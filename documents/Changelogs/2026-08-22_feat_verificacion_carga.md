# Verificación de carga, reintentos y conteo de bytes en las transferencias

**Fecha:** 2026-08-22
**Área:** core

## Descripción

Primera fase de
[02-analisis-cambios-externos-y-verificacion-carga.md](../02-analisis-cambios-externos-y-verificacion-carga.md)
(§2.2, §2.4 D5 y §3.5). Hasta ahora una subida se daba por buena en cuanto el
protocolo la confirmaba (`finish` del `WriteStream` en SFTP, `226` en FTP). Eso
no detecta un archivo truncado por cuota, un `rename` fallido con `useTempFile`
que deja el destino ausente, ni una lectura local cortada a mitad. La extensión
*hacía* la subida, pero no podía *demostrar* que había llegado entera.

`TransferTask` pasa a ser responsable de probarlo:

1. **Conteo de bytes (siempre, en ambas direcciones).** Un `Transform` contador
   entre el stream de origen y el `put` del destino compara los bytes entregados
   con el tamaño del origen (`lstat` local en subidas; en descargas se reutiliza
   el tamaño obtenido al recolectar, para no pedir a FTP un `LIST` por archivo).
2. **Verificación post-subida configurable (`verifyUpload`).** Con `stat` (por
   defecto) se consulta el tamaño remoto del destino final (no del `.new`) y
   debe coincidir exactamente con el local. Si además el `futimes` de esa misma
   transferencia tuvo éxito, se compara el `mtime` en segundos con ±2 s de
   tolerancia y solo se registra un aviso si difiere; nunca es motivo de fallo.
3. **Reintentos (`uploadRetries`).** Cualquier error que no sea una cancelación
   —de red, de verificación— repite la transferencia completa con espera
   incremental (500 ms × intento), cerrando el stream del intento fallido y
   reabriendo el origen. Cada reintento deja un `[transfer] retry n/m` en el
   canal de salida.

Una verificación fallida hace que `run()` rechace con
`TransferVerificationError` (`code: 'EVERIFY'`, `reason` legible), de modo que
el scheduler la trata como un fallo de tarea igual que un error de red.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/transferTask.ts`
- Docblock de clase (Conventions.md §5.1).
- `TransferOption`: nuevas opciones `size?`, `verifyUpload?: 'none' | 'stat'`
  y `retries?: number`; exporta `VerifyUploadLevel`, `TransferVerification`,
  `TransferVerificationError`, `DEFAULT_VERIFY_UPLOAD`,
  `DEFAULT_TRANSFER_RETRIES` y `ERROR_CODE_VERIFY`.
- Getters de solo lectura `bytesTransferred`, `expectedSize`, `attempts` y
  `verification` (`{ level, ok, reason? }`).
- `run()` reintenta; `cancel()` aborta el stream de origen, corta la espera de
  un reintento pendiente y marca la tarea como cancelada aunque el origen aún
  no estuviera abierto.
- `_transferFile()`: contador de bytes, comprobación de bytes antes del
  `futimes`/`rename` (con `useTempFile` un fallo de bytes nunca reemplaza el
  destino), verificación por `stat` sobre la ruta final y aviso de `mtime`.

### [MODIFICADO] `src/core/fs/fileSystem.ts`
- `statSize(path): Promise<number>` no abstracto (por defecto `lstat().size`).
- `statMtime(path): Promise<number | undefined>` no abstracto (por defecto
  `lstat().mtime`; un FS puede devolver `undefined` para no pagar el aviso).
- `createAbortedError()` estático, reutilizado por `abortReadableStream`.

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- `statSize` usa el comando `SIZE` de basic-ftp dentro de la cola de
  concurrencia 1; si el servidor no lo implementa (500/502, 550 por modo ASCII
  o respuesta no numérica) cae a `lstat` y lo recuerda en la instancia. Un 550
  normal ("no existe") se propaga, que es justo lo que la verificación quiere
  saber.
- `statMtime` devuelve `undefined`: el `lstat` de FTP es un `LIST` del
  directorio padre y su `futimes` es de mejor esfuerzo, así que el aviso de
  `mtime` costaría un listado por archivo y avisaría en falso.

### [MODIFICADO] `src/fileHandlers/transfer/transfer.ts`
- Propaga `size` del origen (del `lstat` o del listado) en `transfer()`,
  `transferFolder()`, `_sync()` y tras el guardado previo a la subida.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- `transformOption` de `upload`, `uploadFile`, `uploadFolder` y `sync2Remote`
  pasa `verifyUpload: config.verifyUpload` y `retries: config.uploadRetries`;
  `download*` y `sync2Local` pasan `retries` (la verificación por `stat` es
  solo de subida; el conteo de bytes aplica a ambas).

### [MODIFICADO] `src/core/fileService.ts`
- `ServiceOption`: `verifyUpload` y `uploadRetries`.
- `getHostInfo()`: ambas claves entran en `ignoreOptions`, así no forman
  parte de la clave de conexión.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`
- Validación Joi (`verifyUpload: string().valid('none', 'stat')`,
  `uploadRetries: number().integer().min(0)`), valores por defecto y JSON
  Schema con descripción y `default`.

### [NUEVO] `src/core/__tests__/transferTask-test.ts`
- 20 casos sobre el harness `memfs` + `LocalRemoteFileSystem`: subida
  correcta, `useTempFile`, destino que trunca (agota reintentos, `attempts ===
  retries + 1`, `EVERIFY`), ausente tras subir, fallo transitorio (éxito con
  `attempts === 2` y origen reabierto), cancelación sin reintento y durante la
  espera, `verifyUpload: 'none'` (sin `statSize` pero con conteo de bytes),
  aviso de `mtime` con y sin desfase horario, y descargas (tamaño recolectado
  reutilizado, lectura corta).

### [NUEVO] `src/core/fs/__tests__/ftpFileSystem-test.ts`
- `statSize`/`statMtime` de FTP con el cliente basic-ftp simulado: `SIZE`
  sin `LIST`, fallback recordado, respuesta no numérica, 550 que se propaga,
  550 por ASCII que se degrada.

### [NUEVO] `src/modules/__tests__/config-test.ts`
- Defaults y rechazo de `verifyUpload: 'foo'`, `uploadRetries: -1` y
  variantes.

## Impacto

- **Comportamiento por defecto nuevo:** toda subida se verifica por tamaño y
  se reintenta dos veces antes de reportarse como fallida. En SFTP cuesta un
  `lstat` por archivo (dos cuando el `futimes` tuvo éxito, por el aviso de
  `mtime`); en FTP un `SIZE`. Quien no lo quiera puede fijarlo en `sftp.json`:

  ```json
  {
    "verifyUpload": "none",
    "uploadRetries": 0
  }
  ```

  `verifyUpload` admite `"none"` y `"stat"` (por defecto `"stat"`); el nivel
  `"hash"` está previsto pero todavía no se declara en el esquema.
  `uploadRetries` es un entero `>= 0` (por defecto `2`) y aplica también a las
  descargas.
- Con `useTempFile`, un envío incompleto ya no llega a reemplazar el destino:
  el fallo de bytes se detecta antes del `rename`.
- `TransferTask` expone `verification`, `bytesTransferred`, `expectedSize` y
  `attempts` para que las fases siguientes (registro por tarea, índice
  persistente, plan de carga) puedan guardar lo verificado y no lo intentado.
- Sin cambios en comandos ni en la documentación de usuario; `docs/`, README
  y `CHANGELOG.md` raíz se actualizarán en la fase de cierre.
