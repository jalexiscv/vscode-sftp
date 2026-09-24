# Huella de contenido: un archivo solo cuenta como modificado si cambiaron sus bytes

**Fecha:** 2026-09-24
**Área:** core, modules, commands

## Descripción

El usuario reportó que la extensión seguía detectando "modificaciones
externas" sobre archivos cuyo contenido no había cambiado, y pidió un
mecanismo que permita establecer de verdad si un archivo sufrió cambios
antes de volver a subirlo.

La causa está en la regla de comparación del índice de sincronización: hasta
ahora un archivo se consideraba modificado cuando su tamaño o su mtime (al
segundo) difería de lo registrado en su última subida verificada. El tamaño
casi nunca engaña, pero el mtime se mueve por muchos motivos que no son una
edición: un `git checkout`, `stash` o `pull` reescribe archivos cuyo contenido
acaba siendo idéntico; una copia o una restauración desde una copia de
seguridad les da una fecha nueva; un formateador o un paso de build vuelve a
escribir el mismo texto; un `touch` no cambia nada. Cada uno de esos casos
aparecía como cambio externo y el archivo se subía otra vez.

La solución es guardar en el índice una **huella del contenido** (SHA-1) de
cada versión verificada y consultarla en el único caso ambiguo: mismo
tamaño, otro mtime. La huella de una subida se calcula sobre el propio flujo
de bytes que se envía al servidor (el `ByteCounter` de `transferTask` ya
recorría cada chunk para contar bytes), así que una subida no lee el archivo
dos veces. Las operaciones que siembran el índice (`Rebuild Sync Index`,
`Mark Local Files as Uploaded`, `Mark as uploaded` y `Skip` en un plan) leen
los archivos que registran para anotar su huella. Un escaneo, un evento del
watcher, un sondeo o una vista previa que encuentra un archivo con el mismo
tamaño y otro mtime lo lee una vez, compara la huella y, si coincide, lo deja
en paz y mueve la entrada del índice al mtime nuevo para no volver a leerlo;
solo bytes distintos lo convierten en `modified`. Un tamaño distinto sigue
siendo cambio sin lectura; una entrada sin huella (escrita por una versión
anterior, o de un archivo ilegible en su momento) y un archivo de más de
64 MB conservan la regla de tamaño y mtime.

Se añade la clave `externalChanges.compareContent` (`true` por defecto) para
desactivar la comparación: apagada, no se lee ningún archivo y no se anota
ninguna huella.

## Tipo de Cambio

- `Agregado`
- `Cambiado`
- `Corregido`

## Archivos Afectados

### [NUEVO] `src/core/fingerprint.ts`
- `FINGERPRINT_ALGORITHM = 'sha1'`, `MAX_FINGERPRINT_SIZE = 64 MB`,
  `canFingerprint(size)`.
- `createFingerprinter()`: digester incremental para flujos.
- `fingerprintFile(fsPath)`: digest en streaming de un archivo (a través de
  `fs`, para que memfs lo sustituya en los tests).
- `fingerprintFiles(candidatos, { isCancelled, onProgress, concurrency })`:
  lote con concurrencia acotada (4), progreso y cancelación cooperativa; los
  archivos por encima del tope o ilegibles se omiten con un `debug`, nunca
  abortan el lote.

### [MODIFICADO] `src/core/transferTask.ts`
- `ByteCounter` digiere cada chunk además de contarlo; `fingerprint()` devuelve
  el digest.
- `contentFingerprint` (getter): huella de los bytes transferidos por el
  último intento, fijada solo cuando el conteo de bytes coincidió con el
  tamaño esperado; se limpia al inicio de cada intento. Vale tanto para
  subidas (lo que tiene el servidor) como para descargas (lo que quedó en
  disco).

### [MODIFICADO] `src/modules/syncIndex.ts`
- `IndexEntry.fingerprint?: string`, campo opcional: los índices anteriores se
  cargan sin cambios de formato.

### [MODIFICADO] `src/modules/uploadPlan.ts`
- `classifyAgainstIndex({ index, relPath, fsPath, size, mtime, compareContent })`
  → `{ verdict: 'new' | 'modified' | 'unchanged', byContent }`: la regla
  única que comparten escáner, recolector y vista previa. Solo lee el archivo
  cuando el tamaño coincide, el mtime se movió, la entrada tiene huella, la
  comparación está activa y el tamaño no supera el tope. Si la huella
  coincide, refresca el mtime de la entrada (solo si nadie la reemplazó
  mientras se leía); un error de lectura devuelve `modified` como antes.
- `diffAgainstIndex` pasa a ser asíncrono: clasifica todo por stat de
  inmediato y lee los sospechosos de cuatro en cuatro, con `onProgress`,
  `isCancelled` y los campos nuevos `rewritten` y `cancelled` en el resultado.
  Ya no es "pura": puede refrescar el mtime de entradas existentes, nunca
  añade entradas.
- `isUnchangedAgainstIndex` se conserva como regla de solo stat (la usa el
  runner para detectar un archivo reescrito durante su subida).

### [MODIFICADO] `src/modules/externalChangeScanner.ts`
- `doScan` espera al diff asíncrono, muestra `N file(s) compared by content`,
  trata la cancelación durante las lecturas como escaneo cancelado y registra
  los archivos reescritos con el mismo contenido.
- `rebuildSyncIndex` anota la huella de cada archivo emparejado por tamaño
  (`RebuildProgress.fingerprinted`, `RebuildSummary.fingerprinted`); una
  cancelación durante las lecturas deja el índice intacto.
- `markLocalTreeAsUploaded` lee los archivos tras la confirmación
  (`onProgress(files, fingerprinted)`); cancelable de la misma forma.
- `fingerprintBaseline(...)`: no lee nada si `compareContent` está apagado.

### [MODIFICADO] `src/modules/changeCollector.ts`
- `addFile` es asíncrono y usa `classifyAgainstIndex`; el `debug` de
  "unchanged" añade cuántos se reconocieron por contenido.

### [MODIFICADO] `src/modules/syncIndexFeeder.ts`
- Una subida verificada y una descarga anotan `task.contentFingerprint`.
- `rememberSkipped` y `rememberAssumedUploaded` calculan la huella de los
  archivos declarados (`fingerprintDeclared`), salvo con `compareContent`
  apagado.

### [MODIFICADO] `src/commands/commandPlanPreview.ts`
- La vista previa compara por contenido dentro de la misma notificación de
  progreso, cancelable, y registra los reescritos.

### [MODIFICADO] `src/core/fileService.ts`, `src/modules/config.ts`
- `ExternalChangesConfig.compareContent` (por defecto `true`), validación
  `Joi.boolean()` y resolución en `resolveExternalChangesConfig`.

### [NUEVO] `src/core/__tests__/fingerprint-test.ts`
### [MODIFICADO] tests de `transferTask`, `uploadPlan`, `externalChangeScanner`, `changeCollector`, `syncIndexFeeder`, `config`
- Suite 859 → 887 tests: digest incremental y por archivo, tope de tamaño,
  lote con cancelación; huella expuesta por la tarea (y ausente tras un flujo
  incompleto); reescritura idéntica vs. edición del mismo tamaño en diff,
  clasificación, recolector y escáner; entrada `skipped` que conserva su
  estado; sin huella o con `compareContent` apagado se aplica la regla vieja;
  cancelación del diff; refresco que no pisa una entrada reemplazada;
  huellas en rebuild, mark-as-uploaded, skip y assumed; validación de la
  clave.

### [MODIFICADO] `docs/common_configuration.md`, `docs/configuration.md`, `docs/commands.md`
- Sección `externalChanges.compareContent`, párrafos "Fewer false changes",
  "Sync index", "Scans" y "First use", y los comandos de escaneo,
  reconstrucción, marcado y vista previa. `docs/configuration.md` recibe
  además la sección `externalChanges.maxPlanItems` que le faltaba.

## Impacto

- Un archivo con el mismo tamaño y otro mtime ya no se sube "por si acaso":
  se lee una vez, se compara su huella y solo cambia de verdad si cambiaron
  los bytes. Los reescritos idénticos se cuentan en el canal de salida
  (`N file(s) rewritten with the same content, not planned`) y su entrada
  sigue al mtime nuevo, así que la siguiente comprobación no vuelve a leer.
- Coste: una lectura local por archivo sospechoso (nunca por los de tamaño
  distinto ni por los que coinciden en stat), acotada a 64 MB por archivo y a
  cuatro lecturas simultáneas. Reconstruir o marcar el árbol lee cada archivo
  una vez, con progreso y cancelación.
- Los índices existentes siguen valiendo: sus entradas no tienen huella y se
  comportan como hasta ahora hasta que una subida, una descarga, un rebuild
  o un mark-as-uploaded se la anote. Para cubrir de golpe un proyecto ya
  sincronizado, basta con `SFTP: Mark Local Files as Uploaded` o
  `SFTP: Rebuild Sync Index`.
- Clave nueva en `sftp.json`: `externalChanges.compareContent` (`true`).
  Apagada, todo funciona exactamente como en la 1.28.0.
