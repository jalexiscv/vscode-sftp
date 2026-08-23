# Correcciones de la revisión adversarial (ronda 2, módulos): primer uso del índice, planes zombis, guardados bajo supresión, documentos sucios, refrescos de la vista y `ensureDir` por directorio

**Fecha:** 2026-08-22
**Área:** modules, fileHandlers, ui, config

## Descripción

Una revisión adversarial de toda la integración de la 1.24.0 (detección de
cambios externos, planes de carga, vista de actividad) dejó una lista de
hallazgos. Esta entrada corrige los asignados a `src/modules/*`, cada uno con
su test, y un hallazgo menor de la prueba E2E sobre el Remote Explorer.

### C1 (crítico) — Primer uso y migración del índice de sincronización

Hasta ahora el escáner solo se protegía con `index.size === 0`. En cuanto el
índice tenía **una** entrada (un guardado con `uploadOnSave`), el siguiente
escaneo de arranque marcaba todo lo demás como `new` y, si eran ≤
`confirmThreshold` (20), lo **subía sin preguntar** (pisando el servidor y
pidiendo la contraseña al arrancar); si eran más, el modal volvía en cada
arranque porque `Skip` no se recordaba; y `Rebuild Sync Index` no saneaba la
situación porque exigía mtime remoto ±2 s (un despliegue con git/rsync deja
otros mtimes). El comportamiento nuevo, de principio a fin:

1. **Índice "sembrado" (`seededAt`).** `SyncIndex` guarda un metadato
   persistente `seededAt` (`markSeeded()`, `isSeeded()`, getter `seededAt`),
   serializado en el JSON junto a `entries` y compatible con archivos que no
   lo tienen (un índice escrito por la 1.24.0 carga como **no sembrado**,
   tenga las entradas que tenga). Lo marcan: `rebuildSyncIndex` al terminar
   con éxito, y un escaneo **manual** (`SFTP: Scan for External Changes`) cuya
   subida el usuario confirmó y que terminó sin ítems pendientes — o que
   encontró el árbol al día. Un simple `uploadOnSave` **no** siembra.
2. **Disparadores automáticos sobre un índice no sembrado** (`startup`,
   `config`, `resume`, `focus`, `poll`): planifican solo los ítems
   `modified` (ya indexados y cambiados); los `new` se cuentan y se registran
   en el log (`[scan] <name>: N unindexed file(s) ignored until the index is
   built`), **sin subir ni preguntar**, y la barra no los cuenta como
   pendientes (nunca entran en un plan). El aviso "the sync index for <name>
   is empty / is not built yet; N unindexed file(s) are left alone until it
   is" se muestra **una vez por servicio y sesión**, con los botones `Build
   index now` y `Don't show again`; este último se persiste en
   `workspaceState` (`STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED`, una lista de
   claves de índice) y se olvida en cuanto el índice se construye. Si el
   usuario no elige nada, el aviso vuelve solo en la siguiente sesión.
   `ScanOutcome.ignoredNew` informa del recuento.
3. **Planes de escaneo con ítems `new` sobre un índice sembrado**: piden
   confirmación **siempre**, aunque sean ≤ umbral (`needsConfirmation` lo
   aplica a los orígenes `scan` y `poll`). Los `modified` ≤ umbral siguen
   subiéndose solos, que es el comportamiento esperado del espejo. Los lotes
   de guardado (`command`) y del watcher conservan la regla del umbral: el
   usuario está creando esos archivos en ese momento y un diálogo por cada
   archivo nuevo haría inutilizable el espejo (un `New File` en el explorador
   con `watcher.autoUpload` abriría un modal). Esta es una decisión
   deliberada de esta ronda; si se quiere extender al watcher basta con
   añadir `'watcher'` a `RECONCILIATION_SOURCES`.
4. **`Skip` persistente.** Al elegir `Skip` en el diálogo (o `Review plan` y
   quitar ítems con `SFTP: Skip` en la vista), se escriben en el índice
   entradas `status: 'skipped'` con el `size`/`mtime` local del ítem
   (`syncIndexFeeder.rememberSkipped`). `IndexEntry.status` pasa a
   `'verified' | 'failed' | 'skipped'`; `diffAgainstIndex` trata `skipped`
   como sin cambios mientras `size` y `mtime` (en segundos) coincidan, y como
   `modified` cuando cambian. El mismo modal ya no vuelve en cada arranque.
   Los `skipped` internos (`superseded by a newer scan`, `missing locally`,
   `ignored by config`, `unsaved changes in the editor`) **no** se recuerdan.
5. **`rebuildSyncIndex` por tamaño.** Indexa por **tamaño igual**, guardando
   el mtime **local** como línea base de los escaneos siguientes; el mtime
   remoto ya no es condición (queda como información: `RebuildSummary.
   mtimeDiffer`, y el resumen dice "Indexed N files; M differ in size, K only
   local, J only remote. X of the indexed files have another mtime on the
   server (matched by size)."). Marca `seededAt` y borra la marca del aviso.
6. **M7 — botón por defecto del modal.** `Review plan` es ahora el primer
   botón (el que elige Enter), antes que `Upload N file(s)` y `Skip`: es la
   única respuesta que ni sube ni descarta nada si se contesta a ciegas.

### A1 (alto) — `Cancel All Transfers` dejaba planes zombis

`fileService.cancelTransferTasks()` → `stop()` vacía la cola sin un
`onTaskDone` por tarea encolada (y un scheduler parado ignora `add()`);
`planRunner` solo mapeaba `succeeded/failed/cancelled`, así que los ítems cuya
tarea nunca arrancó quedaban `uploading` para siempre: plan sin `finishedAt`,
`$(arrow-up)N` permanente, no reejecutable. Tras `scheduler.run()`, todo ítem
del lote que sigue `uploading` y cuya tarea no aparece en ninguna de las tres
listas vuelve a `pending`, como los cancelados; el plan se cierra y se puede
ejecutar de nuevo.

### M1 — Un guardado durante una descarga/sync remoto→local se perdía

`changeCollector` descartaba todo el lote si `isSuppressed()`. Ahora los
**guardados** (`source === 'save'`) se retienen en la cola (marcados
`heldKeys`) y se reprocesan con un único temporizador a
`SUPPRESSION_TAIL_MS + 100` ms (la constante se exporta de `syncControl`);
mientras la supresión siga activa se retienen de nuevo. Los eventos del
watcher bajo supresión siguen descartándose: son el eco de las escrituras de
la propia extensión, y reencolarlos volvería a subir lo recién descargado.
Con la sincronización **pausada** se descarta todo, como antes, con log.
`flushNow` no espera a los guardados retenidos (igual que a los diferidos por
una subida en curso).

### M4 — Los planes automáticos guardaban documentos sucios

`transfer()` hace `document.save()` si el archivo está abierto y sucio ("save
before upload"): un escaneo de arranque escribía en disco un borrador
restaurado por hot-exit y lo subía. Para planes con `source !== 'command'`,
`planRunner.prepareItems` marca esos ítems `skipped` con `error: 'unsaved
changes in the editor'` y lo registra; los planes de comando (`Upload Plan`,
`Preview` + `Upload all`) siguen guardando antes de subir.

### M5 — Tormenta de refrescos de la vista de actividad

La vista refrescaba en cada `record/update` del log, cada `updateItem` del
plan y cada cambio de `running` (~5 `fire()` por archivo), y
`getTreeItem` hacía `fs.existsSync` por nodo en cada reconstrucción.
`ActivityTreeDataProvider.scheduleRefresh()` coalesce los eventos en una
reconstrucción cada 100 ms (la primera llamada arma el temporizador; las
siguientes se pliegan; un flujo continuo refresca una vez por ventana);
`refresh()` (botón) sigue siendo inmediato y `dispose()` cancela el
temporizador. `makeCommand` ofrece siempre el comando `reveal` a los nodos con
ruta local (ya tolera archivos ausentes) en vez de hacer `stat` por nodo.

### M6 — `ensureDir` por archivo en `planRunner.runGroup`

Cada `transfer()` hacía `ensureDir(dirname)` (un `mkdir` fallido más un
`lstat` por archivo en SFTP). `runGroup` asegura ahora cada directorio remoto
distinto **una vez por ejecución** (promesa cacheada, con el `chmod` de
`dirPerm` que hacía `transferWithType`) y llama `transfer(cfg, collect, {
ensureDirExist: false })`. El contrato nuevo de `transfer()` —tercer parámetro
opcional `TransferCallOptions { ensureDirExist?: boolean }`, por defecto
`true`— es el acordado con la rama hermana que trabaja en
`src/fileHandlers/transfer/transfer.ts`; es el único cambio en ese archivo.

### B1–B4 y el hallazgo E2E

- **B1.** `changeCollector` (expansión de directorios) y
  `externalChangeScanner.walkRemote` llaman `config.ignore(path, true)` para
  los directorios, así los patrones `dir/` podan el subárbol.
- **B2.** `flushNow({ confirm: false })` drena la cola sin abrir el modal: un
  lote que necesitaría confirmación se deja pendiente (log) y solo se ejecutan
  los que no la necesitan (`ConfirmPlanOptions.prompt`). `deactivate` lo usa.
- **B3.** Los escaneos por foco recorren los servicios **en serie**
  (`scanSequentially`, compartido con `scanAll`), no en paralelo: sin modales
  apilados.
- **B4.** Si el escaneo revienta tras `showMsg('scanning…')`, la barra pasa a
  "scan of <name> failed" (2 s) en vez de quedarse en "scanning…".
- **E2E — `Can't find config for remote resource remote://…` tras cada subida
  explícita.** `createFileHandler` → `afterHandle` → `refreshRemoteExplorer`
  → `RemoteExplorer.refresh` (sin esperar la promesa) → `RemoteTreeData.
  getChildren/getParent` lanzaban porque `findRoot` devuelve `null` mientras
  la vista nunca se ha abierto (`_rootsMap === null`). Ahora, con la vista sin
  construir, `getChildren` devuelve `[]` y `getParent` `undefined` (un destino
  desconocido con la vista construida sigue lanzando), y `RemoteExplorer.
  refresh` captura la promesa y la registra con `logger.debug`. Docblock de
  clase añadido.

## Tipo de Cambio

- `Corregido`
- `Cambiado`
- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/modules/syncIndex.ts`
- `IndexEntry.status: 'verified' | 'failed' | 'skipped'`; `IndexFile.seededAt?`;
  `SyncIndex.isSeeded()`, `seededAt`, `markSeeded(at?)`; `_load(entries,
  seededAt?)`; `_writeTo` serializa la marca; `clear()` la conserva. Docblocks.

### [MODIFICADO] `src/modules/syncIndexFeeder.ts`
- `rememberSkipped(service, files, config?)` y el tipo `SkippedLocalFile`;
  docblock.

### [MODIFICADO] `src/modules/uploadPlan.ts`
- Docblock de `diffAgainstIndex`: las entradas `skipped` cuentan como sin
  cambios mientras el stat coincida (la comparación ya lo hacía).

### [MODIFICADO] `src/modules/planConfirmation.ts`
- `needsConfirmation`: además de git y umbral, `scan`/`poll` con algún ítem
  `new` (`RECONCILIATION_SOURCES`). Orden de botones `Review plan`, `Upload N
  file(s)`, `Skip`. `ConfirmPlanOptions.prompt?` y `service?`; `Skip` con
  `service` → `rememberSkipped`. Docblock.

### [MODIFICADO] `src/modules/externalChangeScanner.ts`
- `doScan`: `knownOnly` para disparadores automáticos sobre índice no
  sembrado (filtra `new`, cuenta `ignoredNew`, aviso), `try/catch` que
  restablece la barra, siembra tras un escaneo manual confirmado y terminado
  (o al día), pasa `service` a la confirmación. `notifyUnbuiltIndex` con
  `Build index now` / `Don't show again` persistente
  (`loadDismissedNotices`, `persistDismissedNotices`, `dismissUnbuiltNotice`,
  `forgetUnbuiltNotice`). `rebuildSyncIndex` por tamaño, `mtimeDiffer`,
  `markSeeded`. `walkRemote` con la marca de directorio. `scanSequentially`
  para `scanAll` y el foco. `ScanOutcome.ignoredNew`, `RebuildSummary.
  mtimeDiffer`, `formatRebuildSummary` nuevo. `init(context)` carga la lista
  persistida. Docblock reescrito.

### [MODIFICADO] `src/modules/planRunner.ts`
- `hasUnsavedChanges` + `prepareItems` (M4); `ensureRemoteDir` cacheado y
  `transfer(…, { ensureDirExist: false })` (M6); ítems `uploading` sin tarea
  → `pending` tras `scheduler.run()` (A1); `skipItem` → `rememberSkipped`.
  Docblock.

### [MODIFICADO] `src/modules/changeCollector.ts`
- `heldKeys`, `holdForSuppression`, `armSuppressionRetry`,
  `SUPPRESSION_RETRY_MS`, `isWaiting`/`onlyWaitingPending`/`onlyHeldPending`;
  `processPending` retiene guardados bajo supresión; `planBatch` poda
  directorios con `ignore(path, true)` y pasa `prompt`/`service`;
  `FlushOptions` y `flushNow({ confirm })`; `destroy` limpia el temporizador.
  Docblock.

### [MODIFICADO] `src/modules/syncControl.ts`
- `SUPPRESSION_TAIL_MS` exportada.

### [MODIFICADO] `src/modules/activityView/treeDataProvider.ts`, `src/modules/activityView/index.ts`
- `scheduleRefresh()`, `dispose()`, `REFRESH_DELAY_MS`; `makeCommand` sin
  `fs.existsSync`; la vista suscribe los eventos a `scheduleRefresh` y
  dispone el proveedor.

### [MODIFICADO] `src/modules/remoteExplorer/treeDataProvider.ts`, `src/modules/remoteExplorer/explorer.ts`
- `getChildren` → `[]` y `getParent` → `undefined` con la vista sin
  construir; `RemoteExplorer.refresh` captura la promesa; docblock de clase.

### [MODIFICADO] `src/fileHandlers/transfer/transfer.ts`
- `TransferCallOptions` y tercer parámetro de `transfer()` (contrato
  compartido con la rama hermana).

### [MODIFICADO] `src/constants.ts`
- `STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED`.

### [MODIFICADO] `src/extension.ts`
- `deactivate`: `flushPendingChanges({ confirm: false })`.

### [MODIFICADO] Tests
- `syncIndex-test.ts` (marca sembrada: persistencia, carga de un archivo
  antiguo, `clear`, entrada `skipped`), `syncIndexFeeder-test.ts`
  (`rememberSkipped`), `uploadPlan-test.ts` (`skipped` en `diffAgainstIndex`),
  `planConfirmation-test.ts` (regla `new`, orden de botones, `prompt: false`,
  `Skip` recordado), `externalChangeScanner-test.ts` (primer uso: índice con
  1 entrada + 5 nuevos en `startup` → nada se sube ni se pregunta; `modified`
  sí se planifica; escaneo manual siembra; `Don't show again` persistente con
  `workspaceState` simulado; `Skip` recordado y no replanificado; sembrado +
  `new` ≤ umbral pide confirmación; foco en serie; barra restablecida; rebuild
  por tamaño, `mtimeDiffer`, poda `dir/`), `planRunner-test.ts` (`Cancel All`
  con concurrencia 1 y 3 archivos → `pending` y reejecutable; documento sucio
  omitido en plan automático y guardado en plan de comando; `ensureDir` una
  vez por directorio; `skipItem` recordado), `changeCollector-test.ts`
  (guardado retenido y reintentado tras la cola con fake timers legacy;
  watcher descartado; `flushNow({ confirm: false })`; directorio `dir/`
  podado), `activityView-test.ts` (`scheduleRefresh` con fake timers legacy;
  el comando se ofrece siempre).

### [NUEVO] `src/modules/__tests__/remoteExplorer-test.ts`
- `getChildren`/`getParent`/`refresh` con la vista sin construir.

## Impacto

- **Primer uso / migración (para la documentación de usuario):**
  1. Mientras el índice de un destino **no esté construido** (primera
     instalación, o un índice de la 1.24.0), los escaneos automáticos solo
     suben lo que el índice ya conoce y cambió; los archivos que no conoce se
     dejan en paz y se anotan en el log.
  2. La extensión lo avisa una vez por servicio ("the sync index … is empty /
     is not built yet") con `Build index now` y `Don't show again`; sin
     respuesta, vuelve a avisar solo en la siguiente sesión.
  3. Para construirlo: `SFTP: Rebuild Sync Index` (indexa por tamaño igual
     lo que ya está en ambos lados; el mtime remoto no importa) o un
     `SFTP: Scan for External Changes` manual cuya subida se confirme y
     termine (o que encuentre todo al día).
  4. Con el índice construido, un escaneo automático que encuentre archivos
     nuevos **siempre pregunta** antes de subirlos (los modificados ≤ umbral
     siguen subiéndose solos); `Review plan` es el botón por defecto.
  5. `Skip` se recuerda: esos archivos no vuelven a planificarse hasta que
     cambien; para volver a verlos, `Rebuild Sync Index` o un escaneo manual.
- `Cancel All Transfers` sobre un plan deja sus ítems `pending` y el plan se
  puede reejecutar; los contadores de la barra se restablecen.
- Un guardado hecho durante una descarga o un `Sync Remote -> Local` se sube
  en cuanto termina la supresión (≈1,6 s después), en vez de perderse.
- Los planes automáticos no guardan documentos con cambios sin guardar; el
  ítem queda `skipped` ("unsaved changes in the editor") en la vista.
- La vista de actividad se reconstruye como mucho cada 100 ms durante un plan
  largo y ya no hace un `stat` por fila.
- Un plan de N archivos en D directorios hace D `ensureDir` en vez de N.
- Desaparece el `[error] Error: Can't find config for remote resource …` del
  exthost tras cada subida explícita con el Remote Explorer sin abrir.
- Cambios de API: `IndexEntry.status` admite `'skipped'`; `SyncIndex.
  seededAt`/`isSeeded()`/`markSeeded()`; `rememberSkipped`;
  `ConfirmPlanOptions.prompt`/`service`; `flushNow(options?)`;
  `ScanOutcome.ignoredNew`; `RebuildSummary.mtimeDiffer`; `transfer(config,
  collect, options?)`; `ActivityTreeDataProvider.scheduleRefresh()/dispose()`;
  `RemoteTreeData.getParent(): Promise<ExplorerItem | undefined>`;
  `SUPPRESSION_TAIL_MS` exportada. Formato del índice en disco: `seededAt`
  opcional (versión 1, compatible en ambos sentidos).
- Sin cambios en `sftp.json`, comandos ni `package.json`.
- Verificación: `npx tsc --noEmit`, `npx tslint -p .`, `npm run compile` sin
  errores; `npm test` 660 pruebas en verde (8 omitidas).
