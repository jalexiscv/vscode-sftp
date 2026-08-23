# Corrección de la base de transferencias y recolector único de cambios

**Fecha:** 2026-08-22
**Área:** core, fileHandlers, modules, helper

## Descripción

Primera fase del plan de [detección de cambios externos y verificación de
carga](../02-analisis-cambios-externos-y-verificacion-carga.md): corrige los
tres defectos de base (D1–D3 del §2.4) sobre los que se apoyarán las fases
siguientes.

- **D1.** `TransferScheduler.run()` resolvía en `onIdle` aunque una tarea
  hubiera fallado: el `Scheduler` captura el error y solo lo emite por
  `onTaskDone`. En consecuencia `uploadFile()`/`upload()` nunca rechazaban
  por un `put` fallido, y la vista de actividad marcaba como éxito una subida
  rota. Ahora `run()` devuelve `{ succeeded, failed, cancelled }` y los
  handlers lanzan un `TransferFailedError` agregado (`code =
  'ETRANSFER_FAILED'`, propiedad `failures`) cuando hay fallos; las tareas
  canceladas no cuentan como fallo. Para no duplicar diálogos, el error
  agregado se marca como ya reportado y `reportError` lo registra en el log
  sin mostrarlo, porque el hook `afterTransfer` ya mostró cada fallo uno a
  uno.
- **D2.** El registro en `activityLog` vivía solo en
  `fileActivityMonitor.handleFileSave` y el watcher no registraba nada. El
  registro pasa a los hooks `beforeTransfer`/`afterTransfer` que instala
  `serviceManager.createFileService`, **por tarea**, con ruta local y
  remota, servicio, perfil y reintento. Comandos, `uploadOnSave` y watcher
  quedan registrados en un único sitio.
- **D3.** `uploadOnSave` y `watcher.autoUpload` subían dos veces el mismo
  guardado. Un nuevo módulo `changeCollector` es el único punto de entrada
  para "este archivo local cambió y debe llegar al servidor": deduplica por
  ruta, agrupa en una ventana de 700 ms, aplica una sola vez las guardas
  (pausa, supresión, workspace, `ignore`, descarga en curso), agrupa por
  servicio y entrega el lote a un handler (por defecto, `uploadFile` por
  ítem). Captura el estado de git al encolar, como el monitor de borrados,
  y marca el lote como `gitDriven` cuando procede (por ahora solo lo
  registra en el log; la confirmación llegará en otra fase).

## Tipo de Cambio

- `Corregido`
- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/fileService.ts`
- `TransferScheduler.run()` devuelve `Promise<TransferResult>`; el resultado
  se recoge en `onTaskDone` (cancelada → `cancelled`, error → `failed`, si
  no → `succeeded`).
- Se exportan `TransferResult` y `TransferScheduler`.

### [MODIFICADO] `src/core/customError.ts`
- Nuevos `TransferFailure`, `TransferFailedError` (`code =
  'ETRANSFER_FAILED'`, `failures`), `ETRANSFER_FAILED` y
  `describeTransferFailures` (mensaje tipo `2 of 10 file(s) failed to
  upload: a.txt (EACCES), b.txt (...)`, como máximo cinco nombres y `and N
  more`).

### [MODIFICADO] `src/core/index.ts`
- Exporta los tipos y clases anteriores.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- Tras `scheduler.run()` en `createTransferHandle`, `sync2Remote` y
  `sync2Local`, lanza `TransferFailedError` marcado como reportado si hay
  fallos.

### [MODIFICADO] `src/fileHandlers/createFileHandler.ts`
- `afterHandle` (refresco del explorador remoto) sigue ejecutándose tras un
  fallo parcial, y el error se relanza después; se elimina el bloque
  comentado que esbozaba el mismo mecanismo.

### [MODIFICADO] `src/helper/error.ts`
- `markReported(err)` / `isReported(err)`; `reportError` registra en el log
  pero no abre el diálogo cuando el error ya está marcado.

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- Los hooks `beforeTransfer`/`afterTransfer` abren y cierran la entrada de
  actividad de cada tarea (`WeakMap<TransferTask, number>`), con `retry`
  que vuelve a llamar a `uploadFile`/`downloadFile` sobre la ruta local.
- Docblock de módulo.

### [NUEVO] `src/modules/changeCollector.ts`
- API: `enqueueChange(uri, source)`, `setBatchHandler(handler | null)`,
  `flushNow()`, `pendingCount()`, `onDidChangePending(listener)`,
  `destroy()`, `testHooks` (`queueKey`, `isGitDriven`, `BATCH_INTERVAL`), y
  los tipos `ChangeSource`, `PendingChange`, `ChangeBatch`, `BatchHandler`.

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`
- `handleFileSave` resuelve el casing real y llama a `enqueueChange(uri,
  'save')` en lugar de subir directamente; desaparece su registro manual en
  `activityLog`. Docblock de módulo.

### [MODIFICADO] `src/modules/fileWatcher.ts`
- `uploadHandler` llama a `enqueueChange(uri, 'watcher')`; se eliminan
  `uploadQueue`, `doUpload` y `debouncedUpload`. La rama de borrado queda
  intacta. Docblock de módulo.

### [MODIFICADO] `src/extension.ts`
- `deactivate()` llama a `changeCollector.destroy()`.

### [NUEVO] `src/core/__tests__/transferScheduler-test.ts`
- Contrato de `run()` (fallida → `failed`, cancelada → `cancelled`, lote
  completo aunque falle una) y formato de `TransferFailedError`.

### [NUEVO] `src/fileHandlers/transfer/__tests__/transferHandle-test.ts`
- `uploadFile`/`downloadFile` de extremo a extremo sobre `memfs`: rechazan
  con `TransferFailedError` ya reportado cuando falla un archivo, el resto
  del lote se transfiere y `afterHandle` se ejecuta.

### [NUEVO] `src/helper/__tests__/error-test.ts`
- `reportError` omite el diálogo con `reported`; `markReported` es
  idempotente y no enumerable.

### [NUEVO] `src/modules/__tests__/serviceManager-test.ts`
- Los hooks registran una entrada por tarea con su resultado, ruta remota,
  servicio y reintento.

### [NUEVO] `src/modules/__tests__/changeCollector-test.ts`
- Dedupe y plegado de mayúsculas (condicional por plataforma), ventana de
  agrupación con fake timers legacy, agrupación por servicio, guardas,
  handler por defecto (un guardado visto también por el watcher = una sola
  subida), `flushNow`, `pendingCount`, `gitDriven` por `testHooks` y por el
  flujo real con un `.git` en `memfs`.

## Impacto

- `uploadFile()`, `upload()`, `uploadFolder()`, `download*()`, `sync2Remote()`
  y `sync2Local()` **ahora rechazan** cuando falla al menos un archivo del
  lote. Los llamadores existentes (comandos, `Upload Changed Files`, vista de
  actividad) ya tenían `catch` + `reportError`/`logger.error`; el diálogo no
  se duplica porque el error agregado llega marcado como reportado.
- La vista de actividad muestra una entrada por archivo transferido, venga
  de un comando, de un guardado o del watcher, con su estado real
  (éxito/fallo/cancelado) y reintento.
- Un guardado desde VS Code con `watcher.autoUpload` activo produce **una**
  subida. La ventana de agrupación pasa de 550 ms (con flanco de entrada)
  a 700 ms (solo flanco de salida), como el monitor de borrados.
- Sin cambios en `sftp.json` ni en los comandos.
- Verificación: `npx tsc --noEmit` sin errores, `npx tslint -p .` limpio,
  `npm run compile` correcto y la suite de Jest en verde (ver informe de la
  rama).
