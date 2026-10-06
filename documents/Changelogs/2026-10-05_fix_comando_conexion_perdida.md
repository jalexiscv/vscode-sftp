# Un comando de carpeta sobrevive a la pérdida de conexión y las selecciones anidadas se recorren una vez

**Fecha:** 2026-10-05
**Área:** fileHandlers, commands

## Descripción

El usuario reportó una sincronización `local ➞ remote` contra un servidor
FTPS que terminó así tras unos 90 s sin tráfico:

```
[warn] [connection] ftp.dtacenter.com: connection lost (error)
[error] Error: Client is closed because read ECONNRESET (data socket)
    at t.FTPContext.handle ...
    at t.Client.send ...
```

dos veces, con dos diálogos de error idénticos, y el resto del árbol sin
subir. Además, el mismo `README.md` aparecía subido tres veces en el mismo
segundo.

Tres causas:

1. **El recorrido de carpetas no podía recuperarse.** La traza apunta a
   `atomicMakeDir` (el `MKD` que lanza `ensureDir` al entrar en una carpeta).
   Un socket de datos recibió `read ECONNRESET`, basic-ftp cerró el cliente
   entero y rechazó cualquier comando posterior con ese mensaje. El objeto
   `targetFs` que recibe `transfer.ts` está ligado a ese cliente, y la capa
   keep-alive lo termina (`fs.end()`) al registrar la caída, así que ningún
   reintento dentro del recorrido habría servido: solo una nueva llamada a
   `getRemoteFileSystem()` devuelve una conexión viva. Desde la 1.28.0 un plan
   se pone en espera y se reanuda solo; un comando (`Upload Folder`,
   `Sync…`, `Download Folder`, archivo suelto) terminaba ahí.
2. **La excepción salía por el nivel de comando, sin contexto y una vez por
   selección.** Como no procedía de una `TransferTask`, no había línea
   `[transfer] connection lost while …`; cada manejador paralelo de
   `createFileCommand` informaba por su cuenta con la traza completa.
3. **Las selecciones anidadas se recorrían a la vez.** Una carpeta
   seleccionada junto con una subcarpeta (o un archivo de ella) se procesaba
   como dos objetivos independientes, y cada archivo bajo ambas se subía dos
   veces en paralelo. Con FTP las operaciones van por una sola cola de
   concurrencia 1, así que el log las muestra "simultáneas" aunque por el
   cable vaya una a una.

## Tipo de Cambio

- `Corregido`
- `Cambiado` (un comando interrumpido por una pérdida de conexión ya no
  falla de inmediato: se retiene y se reanuda, como un plan)

## Archivos Afectados

### [NUEVO] `src/fileHandlers/transfer/resume.ts`
- `runResumable({ ctx, action, option, walk })`: envuelve un intento
  completo (conexión, recorrido, cola) y lo repite tras cada pérdida de
  conexión. Espera a la puerta de conexión (`recovered` o su retención,
  nunca menos de `MIN_RESUME_DELAY_MS` = 5 s), pide un `remoteFs` nuevo y
  vuelve a recorrer el mismo objetivo hasta `MAX_RESUMES` = 10 veces.
- Entre intentos recuerda las rutas de origen ya verificadas y las salta
  envolviendo `option.ignore` (solo archivos; los directorios se juzgan
  entrada a entrada), de modo que `Upload Folder` no reenvía el árbol. Un
  archivo interrumpido `MAX_FILE_INTERRUPTIONS` = 3 veces se abandona y se
  informa con el resto (`connection lost 3 times while uploading this
  file: <motivo>`), como hace el plan desde la 1.29.1.
- Una reconexión rechazada por la puerta (`ConnectionOnHoldError`) cuenta
  como una reanudación más; un error que no es de conexión (contraseña,
  `EACCES` en `ensureDir`) se propaga sin reintentar; una cancelación
  termina sin reanudar.
- `assertTransferSucceeded` se traslada aquí: comprueba `connectionLost`
  antes que la lista de fallos (una conexión perdida en `ensureDir`, sin
  tarea alguna, también es un fallo), añade `after N attempt(s) to resume`
  al mensaje, marca el agregado con `markConnectionLost` y no marca como
  reportado un agregado con archivos interrumpidos o abandonados, que nadie
  mostró por archivo.
- Aviso `SFTP: connection to <host> lost (<motivo>). The <acción> of <ruta>
  is on hold and will resume when it is back.` una vez por servidor y caída
  (se olvida con el `recovered` de esa puerta); líneas `[upload] <ruta> on
  hold: …; resuming in N s (k/10, M file(s) done so far)`, `[upload] <ruta>:
  resuming (k/10)` y `not resumed any more after N attempt(s)` en el canal de
  salida; mensaje en la barra de estado mientras dura la espera.
- `setResumeDelayForTest` y `__resetResumeStateForTest` como costuras de
  test.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- `createTransferHandle`, `sync2Remote` y `sync2Local` pasan por
  `runResumable`; el `walk` de cada uno construye el `transferConfig` con el
  `remoteFs` y la opción del intento. `assertTransferSucceeded` deja de
  vivir aquí.

### [MODIFICADO] `src/commands/abstract/createCommand.ts`
- `withoutNestedTargets(targets)`: descarta las selecciones contenidas en
  otra seleccionada (mismo esquema y autoridad, comparación por segmento,
  sin distinguir mayúsculas en Windows) y los duplicados exactos; conserva
  el orden. Se registra `"<comando>": N selection(s) inside another selected
  folder skipped`.
- `runOnTargets`: recoge los errores de todas las selecciones y los informa
  al final. El primer agregado marcado `connectionLost` abre el diálogo; los
  siguientes llegan solo al log (`markReported`); los demás errores se
  informan uno a uno como antes. Solo cuenta la marca explícita, no un
  resumen por archivo que cite un errno.
- `createFileMultiCommand` ("to All Profiles") usa el mismo recorrido.

### [MODIFICADO] `src/fileHandlers/transfer/__tests__/transferHandle-test.ts`
- El servicio falso expone `getConnectionGate` y el retardo de reanudación
  se acorta. El caso de `downloadFile` con `ECONNRESET` refleja la conducta
  nueva: tres retenciones, archivo abandonado, agregado en su dirección y
  sin marcar como reportado.

### [MODIFICADO] `src/fileHandlers/transfer/__tests__/transferSuppression-test.ts`
- El fallo de descarga pasa a ser `EACCES`: una conexión perdida retendría
  el handler bajo temporizadores falsos que el test no avanza. El scheduler
  falso expone `stop`.

### [NUEVO] `src/fileHandlers/transfer/__tests__/transferResume-test.ts`
- Nueve casos sobre memfs: `ensureDir` que falla una vez y se repite sobre
  una conexión nueva; archivos ya enviados que no se reenvían y los
  interrumpidos o descartados que sí; archivo abandonado a la tercera
  interrupción con el resto subido; agotamiento de las reanudaciones con el
  agregado marcado; reconexión retenida por la puerta que cuenta como
  reanudación; error ajeno a la conexión que se propaga sin reintento; sync
  que se reanuda igual; un aviso por servidor y caída, y otro tras la
  recuperación; `recovered` que adelanta la reanudación.

### [NUEVO] `src/commands/abstract/__tests__/createCommand-test.ts`
- Diez casos: selección anidada descartada conservando el orden, hermano con
  prefijo común conservado, duplicado exacto, esquemas distintos, selección
  única, mayúsculas en Windows; handler una vez por selección exterior, una
  pérdida de conexión informada una vez y los demás errores uno a uno,
  comando multiperfil y objetivo ausente.

### [MODIFICADO] `docs/configuration.md`, `docs/common_configuration.md`
- Párrafo "Commands hold and resume too" junto a "A file the connection dies
  on", y la frase sobre comandos de "The batch stops" remite a él.

## Impacto

- Un `Upload Folder`, `Sync…` o `Download Folder` interrumpido por una caída
  de la conexión espera y continúa donde iba, sin reenviar lo ya subido; solo
  tras diez reanudaciones (unos diez minutos con la puerta al máximo) falla
  con el agregado de la 1.28.0, una vez por ejecución.
- Una selección que incluye una carpeta y parte de su contenido se recorre
  una sola vez.
- Efecto asumido: un comando sobre un archivo suelto contra un servidor caído
  tarda hasta diez reanudaciones en rendirse en lugar de fallar al instante;
  el aviso y la barra de estado dicen que está en espera. `SFTP: Cancel All
  Transfers` solo lo corta mientras hay tareas en vuelo, no durante la
  espera.
- Suite de 901 a 920 tests. Sin cambios en `sftp.json` ni en los comandos.
