# Archivos vacíos por FTPS y plan atascado en el archivo que tumba la conexión

**Fecha:** 2026-10-05
**Área:** core, modules

## Descripción

El usuario reportó un plan de 648 archivos contra un servidor FTPS (Pure-FTPd
con TLS 1.3) que no avanzaba: subía 4 archivos, la conexión se caía con

```
ERR_SSL_TLSV1_ALERT_DECODE_ERROR ... SSL alert number 50 (data socket)
Client is closed because ...
```

el plan quedaba con 644 archivos `on hold`, se reanudaba y volvía a caerse en
el mismo punto, ciclo tras ciclo (unos 340 s cada uno, casi todos gastados en
comprobar los directorios remotos antes de llegar otra vez al mismo archivo).

El log mostró que la caída ocurría siempre sobre el mismo archivo, y ese
archivo pesaba **0 bytes**. Dos causas, una por capa:

1. **Subir un archivo vacío por FTPS cerraba el socket de datos a mitad del
   handshake TLS.** basic-ftp empieza a volcar el origen en cuanto el socket
   de datos informa un cifrado (`getCipher() !== undefined`), y un socket que
   reanuda la sesión TLS de la conexión de control lo informa antes de que el
   handshake termine. Si hay bytes, Node los retiene hasta que el handshake
   acaba y el `end()` espera detrás de ellos; si el origen está vacío no hay
   nada que esperar y el socket se cierra en pleno handshake. Pure-FTPd
   responde con una alerta TLS `decode error` (o con un FIN), y basic-ftp
   cierra el cliente entero. Es una carrera: en loopback el handshake termina
   antes y no falla; con la latencia de una red real falla siempre. Se
   reprodujo en local con un servidor FTPS de prueba (handshake retrasado
   80 ms) tanto en Node 22 como en el runtime de VS Code 1.140 (Node 24,
   BoringSSL), con basic-ftp 6.0.1 y con la 6.2.2: el defecto está en la
   biblioteca y actualizarla no lo corrige.
2. **Un archivo que tumba la conexión en cada intento retenía el plan
   entero.** Desde la 1.28.0 una pérdida de conexión deja el archivo
   interrumpido y los que esperaban en `pending` (`on hold`) y el plan se
   reanuda solo. Eso es correcto cuando la red falla, pero cuando es el propio
   archivo el que provoca el cierre, cada reanudación vuelve a él, se cae otra
   vez y nada de lo que hay detrás llega a subirse.

## Tipo de Cambio

- `Corregido`
- `Cambiado` (una reanudación automática ya no reintenta los ítems `failed`)

## Archivos Afectados

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- `endAfterSecureConnect(input, dataSocket)`: envuelve el origen de la subida
  en un `Readable` que deja pasar los datos tal cual y retiene su fin hasta
  que el socket de datos termina el handshake TLS (`secureConnect`); termina
  de inmediato con un socket sin TLS, uno ya seguro o uno cerrado. No lee nada
  del origen hasta que basic-ftp lee del resultado (tras el `150`), de modo
  que un `STOR` rechazado deja el origen intacto para el reintento de `put`.
  Propaga errores, cierre prematuro y destrucción como hacía `stream.pipeline`
  con el origen directo.
- `atomicPut` sube a través de esa envoltura, con el socket de datos actual
  del contexto de basic-ftp.

### [MODIFICADO] `src/modules/planRunner.ts`
- `MAX_ITEM_INTERRUPTIONS = 3` y un contador por plan y archivo de las subidas
  interrumpidas por una pérdida de conexión: a la tercera seguida el ítem pasa
  a `failed` (`connection lost 3 times while uploading this file: <motivo>`)
  en vez de volver a `pending`, y el canal de salida lo registra.
- `resumeHeld` (reanudación por recuperación de la conexión o por
  temporizador) ejecuta solo lo que está en espera (`pending` y `stale`), no
  los `failed`; si no queda nada en espera libera la retención.
- El contador se borra cuando una ejecución del plan termina sin perder la
  conexión (`releaseHold`).

### [MODIFICADO] `src/core/fs/__tests__/ftpFileSystem-test.ts`
- Once casos nuevos: fin retenido con origen vacío y con contenido, fin
  inmediato con socket seguro, sin TLS o ausente, socket que se cierra durante
  el handshake, lectura perezosa del origen, error y cierre prematuro del
  origen, destrucción en cascada, y `put` pasando por la envoltura.

### [MODIFICADO] `src/modules/__tests__/planRunner-test.ts`
- Tres casos nuevos: fallo a la tercera interrupción, reanudación automática
  que deja el ítem fallido y sube lo que había detrás, y contador reiniciado
  tras una ejecución limpia.

### [MODIFICADO] `docs/configuration.md`, `docs/common_configuration.md`
- Párrafo "A file the connection dies on" junto a "Plans resume on their own".

## Impacto

- Los archivos de 0 bytes (`.gitkeep`, `__init__.py`, salidas de compilación
  vacías) suben por FTPS; antes cada uno cerraba la sesión. FTP sin TLS y SFTP
  no estaban afectados y no cambian.
- Un plan ya no se queda girando sobre un archivo que el servidor rechaza
  cerrando la sesión: a la tercera interrupción ese archivo queda `failed`,
  visible en la vista de actividad, y el resto del plan sube. Ejecutar el plan
  a mano lo reintenta.
- Efecto secundario asumido: sobre una conexión que se cae tres veces seguidas
  durante la subida del mismo archivo sin que este tenga la culpa (un archivo
  grande en una red muy inestable), ese archivo queda `failed` en vez de `on
  hold` y hay que relanzarlo a mano.
- Suite de 887 a 901 tests. Sin cambios en `sftp.json` ni en los comandos.
