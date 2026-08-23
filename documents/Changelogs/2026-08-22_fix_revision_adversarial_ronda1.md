# Correcciones de la revisión adversarial (ronda 1): actividad, supresión, índice, escáner y poda por `ignore`

**Fecha:** 2026-08-22
**Área:** fileHandlers, core, modules, helper

## Descripción

Una revisión adversarial de las fases 0, 1 y 2 del plan de
[detección de cambios externos y verificación de carga](../02-analisis-cambios-externos-y-verificacion-carga.md)
dejó varios hallazgos. Esta entrada corrige los asignados a esta ronda, cada
uno con un test que lo demuestra:

- **A2 (alto) — Fallos previos a la transferencia invisibles en la vista de
  actividad.** Desde la fase 0 las entradas de actividad se abren en los hooks
  `beforeTransfer`/`afterTransfer`, es decir, solo cuando arranca una tarea. Si
  el handler rechazaba antes (conexión caída, contraseña mala, `lstat` del
  origen, `ensureDir` del destino, perfil inválido) no quedaba ninguna entrada
  y el usuario no tenía `Retry`. `createFileHandler` captura ahora el error del
  `handle` y, si no viene ya reportado (`isReported`; los `TransferFailedError`
  llegan marcados y sus tareas ya están registradas), registra una entrada
  `Failed` con ruta local y remota, servicio, perfil, mensaje y `retry`, y
  relanza. Solo para los handlers de transferencia, por un mapeo explícito de
  nombre → `ActivityKind` (`upload*` → `Upload`, `download*` → `Download`,
  `sync …` → `Sync`); `removeRemote`, `rename`, `diff` y `create*` no se
  registran (llevan su propio registro o no son transferencias). El `retry`
  vuelve a llamar al handler con el `ctx` original: si era un `Uri`, el
  servicio y la configuración se resuelven de nuevo en el momento del reintento.
- **A3 (alto) — `suppressAutoSync` sin llamadores en producción.**
  `isSuppressed()` era siempre falso, así que durante un `Sync Remote -> Local`
  o una descarga de carpeta el watcher veía las escrituras de la propia
  extensión y las volvía a subir (y el monitor de borrados replicaba los
  borrados de un sync con `delete`). Los handlers que escriben en local —
  `download`, `downloadFile`, `downloadFolder`, `sync2Local` y `sync2Remote`
  con `bothDiretions` — corren ahora dentro de `suppressAutoSync`. Los de
  subida no se envuelven: suprimirlos se tragaría un guardado real hecho
  mientras tanto. Antes de este cambio `git grep suppressAutoSync` solo
  encontraba la definición y los tests; ahora hay tres llamadores en
  `src/fileHandlers/transfer/index.ts`.
- **B3 (bajo) — Robustez de `syncIndex`.** (1) Si el `rename(.tmp → final)`
  falla (en Windows, EPERM cuando un antivirus tiene el destino abierto) se
  reintenta dos veces con espera corta (100 y 200 ms); si sigue fallando se
  borra el `.tmp` (nunca queda huérfano), el índice queda `dirty`, se
  reprograma el guardado por debounce —acotado a cinco reintentos seguidos,
  después espera al siguiente cambio o flush— y se registra el aviso. (2) Ante
  un error de lectura distinto de ENOENT (EACCES), un JSON corrupto o un
  formato/versión desconocidos, el índice arranca vacío pero queda marcado como
  `loadFailed`: su primer `save()` renombra el original a
  `<file>.corrupt-<timestamp>` (una sola vez) y solo entonces escribe; un
  `logger.warn` lo anuncia. (3) `deactivate()` devuelve la promesa de los
  flush encadenados (`Promise.all` sobre un array con `flushSyncIndex()`,
  preparado para añadir otros), para que VS Code espere el último segundo de
  escritura; cada flush registra su propio error. (4) B9: `SyncIndex` tiene su
  docblock de clase (Conventions.md §5.1), separado del docblock de módulo.
- **B4 (bajo) — La poda por `ignore` de directorios no funcionaba con barra
  final.** `config.ignore(dirPath)` probaba la ruta relativa sin barra final y,
  con la librería `ignore` 5.x, un patrón `node_modules/` (lo habitual en un
  `ignoreFile`/`.gitignore`) no casa con `node_modules`: el escáner local
  entraba en el subárbol y filtraba archivo a archivo. La función acepta ahora
  un segundo parámetro opcional `isDirectory`; si es `true` y la ruta no casa,
  prueba también `relativePath + '/'`. `localScanner` lo pasa para cada
  entrada. El tipo pasa a
  `ServiceConfig.ignore?: ((fsPath: string, isDirectory?: boolean) => boolean) | null`,
  compatible con todos los llamadores actuales.
- **M4 (medio) — `localScanner` con `followSymlinks: true` no protegía contra
  bucles.** Un enlace (o junction) a un ancestro se resolvía con `stat` y el
  recorrido descendía hasta `ENAMETOOLONG` relistando todo. Cada directorio
  pendiente lleva ahora su ruta real (`realpath` de la base y de cada enlace
  seguido; `join` para los subdirectorios normales) y su padre; antes de seguir
  un enlace a directorio, si su destino real es —o contiene— algún directorio
  de la cadena desde la raíz hasta el enlace, no se entra (log `debug`). Un
  enlace a un hermano o a un árbol ajeno se sigue como antes. La comparación
  pliega separadores y, en Windows/macOS, mayúsculas.
- **B5 (bajo) — `describeTransferFailures`/`reasonOf`** prefería `error.code`
  aunque fuera numérico (ssh2 usa códigos SFTP numéricos: `3`), produciendo
  `a.txt (3)`. Solo un `code` de tipo `string` no vacío vale como motivo; si
  no, el `message` plegado a una línea y recortado a unos 80 caracteres.
- **B10 (tests) — Dos tests débiles reforzados.** "honours the concurrency
  bound" contaba resultados (iguales con cualquier cota); ahora envuelve
  `readdir` para contar las llamadas en vuelo y comprueba que el máximo es
  exactamente la cota (3, y 1). "save writes … atomically" se complementa con
  dos casos: el `rename` que falla una vez (se reintenta y el archivo final
  conserva el contenido anterior hasta que aterriza el nuevo) y el que falla
  siempre (sin `.tmp`, índice anterior intacto, `dirty` y guardado de nuevo por
  sí solo).

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/fileHandlers/createFileHandler.ts`
- `TRANSFER_ACTIVITY_KINDS` (nombre de handler → `ActivityKind`) y
  `recordEarlyFailure`; en `fileHandle`, un error que no es
  `TransferFailedError` se registra en `activityLog` (si no venía reportado)
  antes de relanzarse, con `retry: () => fileHandle(ctx, option)`.

### [NUEVO] `src/fileHandlers/__tests__/createFileHandler-test.ts`
- Entrada `Failed` con todos sus campos y reintento funcional; `Download` y
  `Sync` según el handler; nada para errores ya reportados, para
  `TransferFailedError`, para handlers que no son transferencias ni para un
  handler que resuelve; mensaje de un rechazo que no es `Error`.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- `createTransferHandle(REMOTE_TO_LOCAL)`, `sync2Local` y `sync2Remote` con
  `bothDiretions` envuelven su cuerpo en `suppressAutoSync`.

### [NUEVO] `src/fileHandlers/transfer/__tests__/transferSuppression-test.ts`
- Con sistemas de archivos y scheduler simulados y fake timers legacy:
  `isSuppressed()` es `true` dentro del handler y durante la cola de 1,5 s,
  `false` después; `sync2Remote` solo suprime con `bothDiretions`;
  `uploadFile` no suprime; una descarga que falla también libera.

### [MODIFICADO] `src/core/fileService.ts`
- `ServiceConfig.ignore` acepta `isDirectory?: boolean`; `_createIgnoreFn`
  prueba `relativePath + '/'` para directorios.

### [NUEVO] `src/core/__tests__/ignoreDirectories-test.ts`
- `node_modules/` casa con el directorio solo cuando se indica que lo es; lo
  que cuelga de él se ignora igual; patrones sin barra siguen casando; la raíz
  nunca se ignora; rutas remotas.

### [MODIFICADO] `src/modules/localScanner.ts`
- `ScanOptions.ignore` con `isDirectory`; `PendingDir` (`dir`, `real`,
  `parent`), `wouldLoop` exportada, `realpath` de la base y de los enlaces
  seguidos, comparación normalizada.

### [MODIFICADO] `src/helper/fsPromises.ts`
- `realpath(fsPath): Promise<string>` en el tipado mínimo de `fs.promises`.

### [MODIFICADO] `src/modules/__tests__/localScanner-test.ts`
- Poda con un `ignore` que solo acepta con barra final (directorios leídos y
  rutas ofrecidas); enlace a la raíz, a un ancestro de la raíz, dos enlaces
  cruzados y enlace a un hermano; `wouldLoop` aislada; concurrencia medida de
  verdad.

### [MODIFICADO] `src/core/customError.ts`
- `reasonOf` usa `code` solo si es `string` no vacío; mensaje plegado y
  recortado (`MAX_REASON_LENGTH = 80`).

### [MODIFICADO] `src/core/__tests__/transferScheduler-test.ts`
- Código numérico, código vacío y mensaje largo/multilínea.

### [MODIFICADO] `src/modules/syncIndex.ts`
- Docblock de clase; `loadFailed`, `_markLoadFailed`,
  `_preserveUnreadableOriginal`, `_replaceWithRetries`, `_scheduleSave`
  (extraído de `_markDirty`), `RENAME_RETRY_DELAYS_MS`, `MAX_AUTO_RETRIES`;
  `loadFromDisk` marca el índice en los tres casos de carga fallida.

### [MODIFICADO] `src/modules/__tests__/syncIndex-test.ts`
- Archivo corrupto/ilegible/de otra versión conservado como
  `.corrupt-<timestamp>` una sola vez; índice sano sin copia; `rename` que
  falla una vez y que falla siempre.

### [MODIFICADO] `src/extension.ts`
- `deactivate` es `async` y espera `Promise.all(flushes)`; `flushSyncIndex()`
  sigue siendo lo primero que se dispara y nada se reordena.

## Impacto

- La vista de actividad muestra (y permite reintentar) los fallos que ocurren
  antes de que arranque ninguna tarea: sin conexión, credenciales malas,
  origen inexistente, etc.
- Durante una descarga o un `Sync Remote -> Local` (y un sync bidireccional)
  el watcher, `uploadOnSave` y el monitor de borrados ignoran los eventos
  locales, más una cola de 1,5 s. Como efecto colateral ya previsto por
  `syncControl`, un guardado del usuario hecho durante una descarga larga
  tampoco se sube automáticamente (queda el log `[file-save] skipped`); los
  comandos explícitos no se ven afectados.
- Un índice de sincronización ilegible nunca se pisa: aparece una copia
  `<key>.json.corrupt-<timestamp>` junto al nuevo archivo. Un `rename`
  transitorio ya no deja `.tmp` huérfanos ni pierde el guardado.
- Los patrones `dir/` de `ignore`/`ignoreFile` podan el subárbol en el escáner
  local en vez de filtrar archivo a archivo. **Pendiente:** `transferFolder`
  (`src/fileHandlers/transfer/transfer.ts`) sigue llamando a `ignore(srcFsPath)`
  sin la marca de directorio; otro agente trabaja cerca de ese código, así que
  la poda en la subida/descarga de carpetas queda para una ronda posterior
  (basta con pasar `true` cuando la entrada es un directorio).
- Sin cambios en `sftp.json`, comandos ni `package.json`.
- Verificación: `npx tsc --noEmit`, `npx tslint -p .`, `npm test` y
  `npm run compile` en verde (ver informe de la rama).
