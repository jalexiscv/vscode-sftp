# Análisis: detección de cambios externos y verificación de carga

**Fecha:** 2026-08-22
**Estado:** análisis y propuesta (sin implementar)
**Versión objetivo:** 1.24.0 (siguiente minor tras la 1.22.0)

## 1. Contexto y lectura del requerimiento

El requerimiento pide, para la próxima versión, dos capacidades y un cambio de
actitud:

| Pieza | Qué se pide | Qué significa en la práctica |
| :--- | :--- | :--- |
| **A. Detección de cambios externos** | Detectar modificaciones en archivos del workspace hechas **fuera de VS Code** | Editores externos, generadores de código, `composer`/`npm`, `git pull`/`checkout` en una terminal, clientes FTP, scripts, y — el caso que ningún watcher cubre — cambios hechos **mientras VS Code estaba cerrado** |
| **B. Verificación de carga** | Generar **listados de archivos a subir** y comprobar que **cada subida fue exitosa** | Un *plan* previo a subir (qué, por qué, a dónde), y una *verificación* posterior (el archivo remoto existe y coincide), con un resultado legible y persistente |
| **C. "De una manera más inteligente"** | No reaccionar evento a evento a ciegas | Agrupar, deduplicar, comparar antes de subir, confirmar lotes grandes, reintentar, y dejar constancia de lo que pasó |

El hilo conductor es **confianza**: que el usuario sepa que lo que cambió en
local está en el servidor, y que cuando no lo esté, se entere y pueda
corregirlo con un clic. Hoy la extensión *hace* cosas, pero no *demuestra*
que las hizo.

> Nota de diagnóstico previo (2026-07-22): cuando el plugin "dejó de
> funcionar" tras la actualización de VS Code, los logs mostraban subidas
> exitosas y nunca se identificó el síntoma exacto. Ese episodio encaja con
> este requerimiento: la extensión no ofrece hoy ninguna forma de responder
> con certeza "¿subió o no subió?" ni "¿qué falta por subir?".

## 2. Diagnóstico del estado actual

### 2.1 Detección de cambios externos hoy

Existe, pero es parcial y está desactivada por defecto. Componentes:

- [src/modules/fileWatcher.ts](../src/modules/fileWatcher.ts): un
  `vscode.workspace.createFileSystemWatcher(RelativePattern(baseDir, watcher.files))`
  por servicio. `onDidCreate`/`onDidChange` → cola por ruta → `debounce` de
  550 ms (`leading` + `trailing`) → `upload(uri)` por archivo, en paralelo.
- [src/modules/fileActivityMonitor.ts](../src/modules/fileActivityMonitor.ts):
  `uploadOnSave` sobre `onDidSaveTextDocument`/`onDidSaveNotebookDocument`
  (solo guardados *desde* VS Code).
- [src/modules/localDeleteMonitor.ts](../src/modules/localDeleteMonitor.ts):
  borrados y renombrados, combinando `onDidDeleteFiles`/`onDidRenameFiles` con
  un `FileSystemWatcher` `**/*` por carpeta de workspace. Es el módulo más
  maduro: agrupa, detecta operaciones de git (HEAD + marcadores), pide
  confirmación por encima de un umbral y registra en la vista de actividad.
- Configuración: `watcher.files` / `autoUpload` / `autoDelete`
  ([schema/definitions.json](../schema/definitions.json),
  [src/modules/config.ts](../src/modules/config.ts)). En `defaultConfig` el
  bloque `watcher` está **comentado**: sin configurarlo explícitamente no hay
  watcher, y por tanto **un cambio externo no se sube nunca** con la
  configuración por defecto.

Limitaciones estructurales de lo que hay:

1. **Ciego mientras VS Code está cerrado.** `FileSystemWatcher` solo ve
   eventos en vivo. Todo lo que cambie con la ventana cerrada (un `git pull`
   en otra terminal, un deploy parcial, un editor externo) queda sin subir y
   **nadie lo detecta al arrancar**: no existe reconciliación inicial.
2. **Doble subida con `uploadOnSave`.** Un guardado desde VS Code dispara
   `handleFileSave` *y* `onDidChange` del watcher; los dos suben el mismo
   archivo. La documentación lo reconoce ("Set `uploadOnSave` to `false` when
   you watch everything") en lugar de resolverlo.
3. **Sin plan ni agrupación.** Cada archivo se sube en cuanto cae el debounce,
   sin lista previa, sin comparar con el remoto, sin umbral de confirmación.
   Un `git checkout` que toca 400 archivos son 400 subidas inmediatas. El
   monitor de borrados ya resolvió este problema para su caso; el de subidas
   no lo heredó.
4. **Eventos que no llegan.** El watcher de VS Code respeta
   `files.watcherExclude`, puede ser poco fiable en unidades de red, montajes
   Docker/WSL y ráfagas masivas. No hay modo de sondeo (*polling*) como
   alternativa.
5. **Sin registro.** `doUpload` no pasa por `activityLog` (el de borrados sí),
   así que las subidas del watcher no aparecen en la vista de actividad; los
   fallos solo quedan en el canal de salida y en el color de la barra de
   estado.
6. **Sin guarda de git para subidas.** `doDelete` ignora los borrados
   provocados por git; `doUpload` no distingue un checkout de una edición.
   (Que un checkout se suba puede ser deseable — el FAQ lo propone — pero debe
   ser una decisión del usuario, no un efecto colateral.)

### 2.2 Verificación de carga hoy

No existe como tal. Lo que hay es el *ack* del protocolo:

- [src/core/transferTask.ts](../src/core/transferTask.ts): `open` → `put`
  (pipe del stream local al `WriteStream` remoto; resuelve en `finish`, es
  decir, cuando el servidor ha confirmado cada `WRITE` en SFTP o el `226` en
  FTP) → `futimes` (mejor esfuerzo) → si `useTempFile`, `rename` sobre el
  destino → `close`.
- **No se hace `lstat` posterior**, no se compara tamaño ni fecha, no se
  cuentan los bytes transmitidos frente al tamaño local, no hay checksum.
- El resultado de cada tarea se emite por `afterTransfer` →
  [serviceManager](../src/modules/serviceManager/index.ts) → `reportError` +
  mensaje efímero en la barra de estado. El éxito no se guarda en ningún
  sitio duradero.
- [src/modules/activityLog.ts](../src/modules/activityLog.ts) es **en
  memoria** (500 entradas): un *reload* de la ventana borra el historial,
  incluidos los fallos pendientes de reintento.

### 2.3 Listados de archivos a subir hoy

- `Sync Local -> Remote` calcula diferencias (mtime en segundos + tamaño) en
  [src/fileHandlers/transfer/transfer.ts](../src/fileHandlers/transfer/transfer.ts),
  pero **no las muestra**: decide y transfiere en el mismo paso.
- `Upload Changed Files` usa el estado de git (índice + working tree). Solo
  sirve en repositorios git, no compara con el servidor y no presenta lista
  previa.
- `sftp.diff` compara un archivo; no hay diff de carpetas ni *dry run*.
- No hay ninguna memoria de "último estado subido por archivo", así que la
  única forma de saber qué falta por subir es listar el servidor entero.

### 2.4 Defectos concretos detectados al leer el código

Estos son previos al requerimiento y conviene corregirlos en la primera fase,
porque cualquier "verificación de carga" construida encima heredaría el
problema.

| # | Defecto | Dónde | Efecto |
| :-: | :--- | :--- | :--- |
| D1 | `transferScheduler.run()` resuelve en `onIdle` **aunque una tarea haya fallado**; `Scheduler._runTask` captura el error y solo lo emite por `onTaskDone`. Por tanto `uploadFile()`/`upload()` **no rechazan** cuando el `put` falla: solo rechazan si falla la *recolección* (`lstat`, `ensureDir`). | [src/core/fileService.ts](../src/core/fileService.ts) `createTransferScheduler`, [src/core/scheduler.ts](../src/core/scheduler.ts) | `fileActivityMonitor.handleFileSave` ejecuta `succeed(activityId)` tras `await uploadFile(uri)` → **la vista de actividad marca como éxito una subida fallida**. `commandUploadChangedFiles` nunca llega a su `logger.error('Upload failed.')` por un fallo de transferencia. El `catch` de `fileWatcher.doUpload` tampoco. |
| D2 | `fileWatcher.doUpload` no registra en `activityLog` | fileWatcher.ts | Las subidas por cambio externo son invisibles en la vista de actividad y no se pueden reintentar desde ella. |
| D3 | `uploadOnSave` + `watcher.autoUpload` suben dos veces el mismo guardado | fileActivityMonitor.ts + fileWatcher.ts | Tráfico doble; con `useTempFile` dos `rename` concurrentes sobre el mismo destino. |
| D4 | `activityLog` no persiste | activityLog.ts | Un reload pierde los fallos pendientes. |
| D5 | `useTempFile` sin `openSsh`: `unlink(target)` + `rename` no atómicos; si el `rename` falla el destino queda **ausente** y nadie lo comprueba | transferTask.ts | Exactamente el caso que una verificación post-subida detectaría. |

## 3. Propuesta de diseño

### 3.1 Principio rector

Pasar de **"evento → subida inmediata"** a una tubería con estado:

```
evento en vivo  ─┐
escaneo (arranque / manual / sondeo) ─┼─▶ recolector ─▶ ÍNDICE ─▶ PLAN ─▶ ejecución ─▶ VERIFICACIÓN ─▶ registro persistente
comando explícito / git ─┘                  (dedupe)   (estado)  (lista)  (scheduler)   (stat/hash)      (actividad + índice)
```

Tres ideas hacen "inteligente" al sistema:

1. **Un índice persistente** de lo que se subió (y se verificó) por archivo.
   Es lo que permite saber *qué falta* sin listar el servidor, detectar
   cambios hechos con VS Code cerrado y no volver a subir lo que no cambió.
2. **Un plan explícito** (manifiesto) entre detectar y subir: deduplica,
   agrupa por servicio/perfil, se puede previsualizar, confirmar, recortar y
   exportar.
3. **Verificación como parte de la transferencia**, no como comando aparte:
   cada subida termina en `verified` o `failed` con motivo, se reintenta y
   queda registrada.

### 3.2 Índice de sincronización persistente (`syncIndex`)

Nuevo módulo `src/modules/syncIndex.ts` (sin importaciones desde `src/ui/`,
ver [documents/Changelogs/2026-08-16_feat_actividad_y_pausa.md](Changelogs/2026-08-16_feat_actividad_y_pausa.md)).

- Clave: `serviceBaseDir + host:port + remotePath + profile` → un índice por
  destino real.
- Entrada por ruta relativa: `{ size, mtimeMs, hash?, remoteSize?, remoteMtimeS?, verifiedAt, status: 'verified'|'failed'|'pending' }`.
- Almacenamiento: archivo JSON bajo `context.storageUri` (por workspace;
  `workspaceState` es para valores pequeños). Escritura con `debounce` y
  atómica (escribir `.tmp` + `rename`). Tamaño estimado: 50 000 archivos ≈
  5–8 MB; aceptable. Carga perezosa por servicio.
- Se actualiza desde un único punto: el hook `afterTransfer` (+ verificación)
  de `serviceManager`, y desde los handlers de borrado/renombrado. Así el
  índice refleja *lo verificado*, no lo intentado.
- Comando `SFTP: Rebuild Sync Index` (relista el remoto y reconstruye) para
  el primer uso o tras un cambio de servidor.

### 3.3 Detección de cambios externos en tres capas

| Capa | Mecanismo | Cubre | No cubre |
| :--- | :--- | :--- | :--- |
| **1. Eventos en vivo** | Un `FileSystemWatcher` `**/*` por carpeta de workspace (como ya hace el monitor de borrados), filtrado por `watcher.files`/`ignore`/temporales, alimentando el **mismo recolector** que `uploadOnSave` (elimina D3) | Ediciones externas con VS Code abierto | Cambios con VS Code cerrado; eventos perdidos |
| **2. Reconciliación por escaneo** | Recorrer el árbol local (respetando `ignore` y `tempFilePatterns`) y comparar `size + mtime` contra el **índice**. Se lanza al activar la extensión, al reanudar (`Resume Auto Sync`), al recargar `sftp.json`, al recuperar el foco tras N minutos y bajo demanda (`SFTP: Scan for External Changes`). Produce un **plan**, no subidas directas | Todo lo anterior **más** lo ocurrido con VS Code cerrado; archivos fuera de `files.watcherExclude` no aplica (el escaneo no depende del watcher) | Archivos modificados sin cambiar `mtime` ni tamaño (caso residual; el modo `hash` opcional lo cubre) |
| **3. Sondeo opcional** | `watcher.pollInterval` (ms, 0 = desactivado): repite el escaneo incremental (solo directorios con `mtime` cambiado) | Unidades de red, montajes Docker/WSL, entornos sin eventos fiables | Coste de I/O; por eso es opcional |

Reglas transversales:

- **Un solo recolector** (`changeCollector`): clave por ruta (plegada en
  Windows/macOS, como ya hace `localDeleteMonitor`), ventana de agrupación
  (700 ms, como el monitor), descarta rutas en transferencia, en pausa o bajo
  supresión, y aplica `ignore`.
- **Conciencia de git**: capturar `HEAD` al encolar (misma técnica que el
  monitor de borrados). Si HEAD cambió o hay operación en curso, el lote se
  marca `source: 'git'` y **siempre** pasa por confirmación, independiente
  del tamaño.
- **Umbral de confirmación** (`uploadConfirmThreshold`, por defecto 20):
  por debajo, el lote se sube solo; por encima, se muestra el plan y el
  usuario confirma/recorta. Simétrico a `deleteRemoteConfirmThreshold`.
- **Archivos cambiando durante la subida**: comparar `size + mtime` local
  antes y después; si cambió, el ítem se marca `stale` y se **re-encola** en
  lugar de `failed`.

### 3.4 Plan de carga (manifiesto)

Modelo (en `src/modules/uploadPlan.ts`):

```ts
interface UploadPlan {
  id: string;                // p. ej. 20260822-153012-a1
  serviceName: string;
  profile: string | null;
  source: 'watcher' | 'scan' | 'command' | 'git' | 'poll';
  createdAt: number;
  items: UploadPlanItem[];
}

interface UploadPlanItem {
  localPath: string;
  remotePath: string;
  reason: 'new' | 'modified' | 'deleted' | 'renamed' | 'missing-remote';
  localSize: number;
  localMtime: number;
  status: 'pending' | 'uploading' | 'verified' | 'failed' | 'skipped' | 'stale';
  attempts: number;
  error?: string;            // 'size mismatch (local 1024, remote 0)', 'not found after upload', ...
}
```

Cómo se construye:

- Desde el recolector (capa 1) y el escaneo (capas 2/3): comparación contra
  el índice (barato, local).
- Desde un comando: `transfer()` en
  [transfer.ts](../src/fileHandlers/transfer/transfer.ts) ya separa
  **recolectar tareas** (`collect`) de **ejecutarlas** (`scheduler.run()`).
  Un *dry run* es llamar a `transfer(config, collect)` con un recolector que
  construye el plan y no ejecuta. Esto da gratis `SFTP: Preview Upload` para
  archivo/carpeta/proyecto y una previsualización de `Sync Local -> Remote`.
- Modo "comprobación profunda" (bajo demanda): además del índice, `lstat`
  remoto por ítem para detectar divergencias que el índice no conoce
  (`missing-remote`). Costoso; no automático.

Cómo se presenta:

- **Vista de actividad** (existente, [src/modules/activityView/](../src/modules/activityView/)):
  un nodo por plan ("Lote 15:30 — 12 archivos · 10 verificados · 2 fallidos")
  con los ítems debajo; acciones por ítem: `Upload`, `Skip`, `Diff`
  (`sftp.diff` existente), `Reveal`; acciones por lote: `Upload all`,
  `Retry failed`, `Export report`.
- **Confirmación** sobre umbral: QuickPick multi-selección con todos los
  ítems preseleccionados, o botón "Show plan" que enfoca la vista.
- **Exportación**: Markdown/JSON con el manifiesto y su resultado
  (`SFTP: Export Last Upload Report`), pensado para auditoría o para pegar en
  un ticket.

### 3.5 Verificación de carga

Configurable por servicio/perfil: `verifyUpload: "none" | "stat" | "hash"`
(por defecto `"stat"`), `uploadRetries` (por defecto 2, con espera
incremental).

| Nivel | Qué comprueba | Coste | Notas |
| :--- | :--- | :--- | :--- |
| **0. Ack de protocolo** (ya existe) | `finish` del `WriteStream` SFTP / `226` en FTP | 0 | Necesario pero insuficiente: no detecta truncados por cuota, `rename` fallido con `useTempFile`, ni escrituras parciales. |
| **0b. Conteo de bytes** (nuevo, siempre) | Un `PassThrough` contador en `TransferTask._transferFile`: bytes enviados == tamaño local leído | ~0 | Detecta streams locales cortados (archivo reescrito a mitad, permisos). Local, sin viaje al servidor. |
| **1. `stat`** (por defecto) | Tras `put` (+ `rename` si `useTempFile`): `lstat` remoto; `size` **exacto**; `mtime` en segundos ± tolerancia solo si `futimes` funcionó en ese servidor (capacidad recordada por conexión; `hasWarnedModifedTimePermission` ya existe como germen) | 1 viaje/archivo en SFTP | En FTP `lstat` = `list(parent)`: **verificar por directorio** (un `list` por carpeta del lote) o usar `SIZE` (`client.size()` de basic-ftp). Tener en cuenta `remoteTimeOffsetInHours` y la resolución de minuto de `LIST` frente a `MLSD`. |
| **2. `hash`** (opcional) | Checksum remoto = local | 1 comando/archivo | SFTP: extensión `check-file` (rara) o `exec sha256sum`/`md5sum` por SSH — requiere shell; imposible con saltos `hop` sin shell. FTP: `XCRC`/`XMD5`/`HASH` cuando el servidor los ofrece. Si no está disponible, degradar a `stat` con aviso una vez. |

Contrato de resultados (corrige D1):

- `TransferScheduler.run()` devuelve `{ succeeded: TransferTask[]; failed: Array<{ task, error }> }`
  o lanza un error agregado cuando hay fallos — a decidir en implementación;
  lo importante es que **el llamador pueda saberlo** y que `uploadFile()` ya
  no pueda "terminar bien" con un `put` fallido.
- El registro en `activityLog` se mueve a **por tarea** en
  `beforeTransfer`/`afterTransfer` (una sola fuente de verdad para comandos,
  `uploadOnSave` y watcher — corrige D2), con `remotePath` y resultado de
  verificación; los handlers dejan de llamar a `succeed()` a ciegas.
- Estado por ítem: `verified` (ack + bytes + stat OK) / `failed` (con motivo
  concreto) / `stale` (re-encolado). Un fallo de verificación dispara los
  reintentos antes de darse por perdido.

### 3.6 Reporte y experiencia de usuario

- **Barra de estado** (existente, [src/ui/statusBarItem.ts](../src/ui/statusBarItem.ts)):
  además de la cola, mostrar `↑N` pendientes por cambios externos y `✗N`
  fallidos; el clic abre la vista de actividad en el plan.
- **Resumen por lote**: notificación no modal al cerrar un lote
  ("SFTP: 12 archivos subidos y verificados (3,2 MB, 4,1 s)"); con fallos,
  aviso con botones `Show failures` / `Retry`.
- **Persistencia del registro** (corrige D4): guardar al menos los fallos y
  el último plan en `storageUri`, para que un reload no los pierda.
- **Canal de salida**: mantener el log textual; añadir el resumen del lote al
  estilo de `------ Upload Changed Files Result ------`.

### 3.7 Configuración propuesta (`sftp.json`)

Compatible hacia atrás: todo tiene valor por defecto y lo existente sigue
significando lo mismo.

```json
{
  "uploadOnSave": true,
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": false,
    "pollInterval": 0
  },
  "externalChanges": {
    "scanOnStartup": true,
    "scanOnResume": true,
    "confirmThreshold": 20
  },
  "verifyUpload": "stat",
  "uploadRetries": 2
}
```

Decisiones de diseño a validar:

- ¿Activar `watcher.autoUpload` por defecto? Hoy el bloque está comentado en
  `defaultConfig`. Con el recolector único ya no hay doble subida, y el
  umbral de confirmación evita sorpresas; la propuesta es **activar
  `scanOnStartup` por defecto pero no el watcher en vivo**, y revisar en la
  siguiente versión según la experiencia.
- Nombres: `externalChanges.*` como bloque nuevo o como claves dentro de
  `watcher.*`. Propuesta: bloque nuevo (el watcher es una *fuente*; la
  reconciliación es otra).

## 4. Flujos

### 4.1 Arranque de VS Code (cambios hechos con la ventana cerrada)

1. `activate` → servicios creados → `syncIndex.load(service)`.
2. `externalChanges.scanOnStartup` → escaneo en segundo plano con progreso
   cancelable (`withProgress`), respetando `ignore`.
3. Diferencias vs índice → `UploadPlan{ source: 'scan' }`.
4. Si `items.length <= confirmThreshold` → se ejecuta; si no, la barra de
   estado muestra `↑N` y la vista de actividad el plan pendiente; el usuario
   confirma o recorta.
5. Ejecución → verificación → índice + actividad actualizados → resumen.

### 4.2 Cambio externo con VS Code abierto

1. `FileSystemWatcher` → `changeCollector.enqueue(uri, { head: readGitHead() })`.
2. Ventana de 700 ms → lote; se descartan rutas en transferencia/pausa/
   supresión/ignoradas; si HEAD cambió → `source: 'git'` → confirmación.
3. Plan → ejecución → verificación → registro.

### 4.3 Guardado desde VS Code

Igual que 4.2, entrando por `onDidSaveTextDocument`. El recolector deduplica
con el evento del watcher (misma clave, misma ventana): **una** subida.

### 4.4 Subida de un archivo (cualquier origen)

1. `TransferTask.run()` → `open` → `put` con contador de bytes → `futimes` →
   (`rename` si `useTempFile`) → `close`.
2. Verificación según `verifyUpload` → `verified` | `failed(motivo)`.
3. `failed` → reintento (hasta `uploadRetries`) → si persiste, entrada
   `Failed` en actividad con `retry`, índice marca `failed`, barra `✗N`.
4. `verified` → índice actualizado con `size/mtime/verifiedAt`.

## 5. Riesgos y decisiones

| Riesgo | Mitigación |
| :--- | :--- |
| Escaneo inicial lento en árboles grandes (`vendor/`, `node_modules/`) | `ignore` obligatorio en el recorrido; índice por `mtime` de directorio para saltar subárboles sin cambios; progreso cancelable; `scanOnStartup` desactivable. |
| Falsos positivos por reloj/zona horaria (`mtime` local vs remoto) | La verificación usa **tamaño** como criterio duro; `mtime` solo cuando `futimes` funcionó en ese servidor y con tolerancia; el índice guarda el `mtime` local (no el remoto) para detectar cambios locales. |
| FTP: `lstat` por archivo es un `LIST` del directorio | Verificación agrupada por directorio o `SIZE`; concurrencia 1 ya impuesta para FTP. |
| Ráfagas de git (checkout de miles de archivos) | Captura de HEAD al encolar + confirmación obligatoria para lotes `git`; nunca subir más de `confirmThreshold` sin preguntar. |
| Archivo reescrito durante la subida (build watchers) | Comparación local antes/después → `stale` → re-encolar. |
| `hash` inviable (sin shell, servidores sin `XMD5`) | Degradación automática a `stat`, aviso único en el log. |
| Ciclo de importación `ui/ ↔ modules/` | Los nuevos módulos viven en `modules/`; la barra de estado recibe valores por *push* como ya ocurre con la pausa. |
| Tests con temporizadores | `legacyFakeTimers` de Jest (los modernos chocan con `performance` en este Node). |
| Cambio de comportamiento por defecto | Hacer release minor con nota destacada en `CHANGELOG.md` y los seis README, como en la 1.22.0. |

## 6. Plan de implementación por fases

Cada fase es una rama `feat/…` o `fix/…` integrada en `main` con `--no-ff`,
con su entrada en `documents/Changelogs/` y tests en verde
([Git.md](Protocols/Git.md)). El orden está pensado para que cada fase deje
valor por sí sola y para que lo construido después se apoye en contratos ya
corregidos.

| Fase | Alcance | Archivos principales | Tamaño |
| :-: | :--- | :--- | :-: |
| **0** | **Corregir la base (D1–D3).** `TransferScheduler.run()` informa fallos; registro de actividad por tarea en `afterTransfer`; el watcher registra; recolector único para `uploadOnSave` + watcher (adiós doble subida). Tests unitarios con `LocalRemoteFileSystem` + `memfs` (harness existente en [transfer-test.ts](../src/fileHandlers/transfer/__tests__/transfer-test.ts)). | `core/fileService.ts`, `core/scheduler.ts`, `modules/serviceManager/index.ts`, `modules/fileActivityMonitor.ts`, `modules/fileWatcher.ts`, nuevo `modules/changeCollector.ts` | S–M |
| **1** | **Verificación de carga.** Contador de bytes en `TransferTask`; `verifyUpload: stat` con agrupación por directorio en FTP; reintentos; estados `verified/failed/stale`; resumen por lote; persistencia de fallos (D4). | `core/transferTask.ts`, `core/fs/*`, `modules/activityLog.ts`, `modules/activityView/*`, `ui/statusBarItem.ts`, `modules/config.ts`, `schema/definitions.json` | M |
| **2** | **Índice persistente + plan.** `syncIndex`, `uploadPlan`, nodo de planes en la vista de actividad, `SFTP: Preview Upload` (dry run sobre `transfer(config, collect)`), umbral de confirmación, `Export Last Upload Report`, `Rebuild Sync Index`. | nuevos `modules/syncIndex.ts`, `modules/uploadPlan.ts`; `fileHandlers/transfer/*`, `commands/*`, `package.json` | L |
| **3** | **Detección de cambios externos completa.** Escaneo al arrancar/reanudar/foco/bajo demanda (`SFTP: Scan for External Changes`), sondeo opcional, conciencia de git en subidas, contadores en barra de estado. Prueba E2E con el harness de servidor SFTP local (ver memoria del diagnóstico 2026-07-22). | `modules/changeCollector.ts`, nuevo `modules/externalChangeScanner.ts`, `modules/syncControl.ts`, `extension.ts` | M–L |
| **4** | **Opcional y cierre.** `verifyUpload: hash` (SSH exec / `XMD5`), documentación (`docs/`, FAQ, README ×6), `CHANGELOG.md` raíz, release 1.24.0. | `docs/*`, `README*.md`, `package.json` | M |

Criterio de "hecho" por fase: `npx tsc --noEmit`, `npx tslint -p .`,
`npm run compile`, `npm test` en verde, changelog registrado.

## 7. Supuestos y preguntas abiertas

Supuestos con los que se ha hecho el análisis (corregir si no aplican):

- Los "problemas" que motivan la versión son, en esencia, (a) cambios que no
  llegan al servidor porque se hicieron fuera del editor o con VS Code
  cerrado y (b) la imposibilidad de confirmar que una subida terminó bien.
- Hay que soportar **SFTP y FTP** por igual (la verificación difiere).
- Los proyectos son de tamaño medio (decenas de miles de archivos como
  máximo) y `ignore` ya excluye dependencias.

Preguntas que cambiarían decisiones de diseño:

1. ¿Qué síntoma concreto están viendo los usuarios ahora (archivos que faltan
   en el servidor, subidas que "dicen" éxito y no lo son, watcher que no
   dispara)? Determina qué fase priorizar.
2. ¿Los servidores SFTP habituales permiten shell (para `hash`) o son cuentas
   solo-SFTP / con `hop`? Si es lo segundo, `hash` pasa a la última fase o se
   descarta.
3. ¿Se quiere activar el watcher en vivo por defecto en esta versión, o solo
   la reconciliación al arrancar (propuesta)?
4. ¿El plan debe vivir en la vista de actividad existente o en una vista
   propia "SFTP: Upload Queue"? La propuesta reutiliza la existente para no
   añadir otra vista al contenedor.

## 8. Referencias

- Código: [src/modules/fileWatcher.ts](../src/modules/fileWatcher.ts),
  [src/modules/fileActivityMonitor.ts](../src/modules/fileActivityMonitor.ts),
  [src/modules/localDeleteMonitor.ts](../src/modules/localDeleteMonitor.ts),
  [src/modules/activityLog.ts](../src/modules/activityLog.ts),
  [src/modules/syncControl.ts](../src/modules/syncControl.ts),
  [src/core/fileService.ts](../src/core/fileService.ts),
  [src/core/scheduler.ts](../src/core/scheduler.ts),
  [src/core/transferTask.ts](../src/core/transferTask.ts),
  [src/fileHandlers/transfer/transfer.ts](../src/fileHandlers/transfer/transfer.ts),
  [src/commands/commandUploadChangedFiles.ts](../src/commands/commandUploadChangedFiles.ts).
- Historial relacionado:
  [2026-08-16_fix_transferencia_watcher.md](Changelogs/2026-08-16_fix_transferencia_watcher.md),
  [2026-08-16_feat_actividad_y_pausa.md](Changelogs/2026-08-16_feat_actividad_y_pausa.md),
  [2026-08-16_feat_borrado_espejo_remoto.md](Changelogs/2026-08-16_feat_borrado_espejo_remoto.md).
- Documentación de usuario del watcher: [docs/common_configuration.md](../docs/common_configuration.md) (§ watcher), [FAQ.md](../FAQ.md).
