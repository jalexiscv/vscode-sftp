# Índice de sincronización persistente, plan de carga y escáner local

**Fecha:** 2026-08-22
**Área:** modules, helper

## Descripción

Fase 2 del diseño descrito en
[02-analisis-cambios-externos-y-verificacion-carga.md](../02-analisis-cambios-externos-y-verificacion-carga.md)
(§3.2, §3.3 capa 2 y §3.4): tres módulos nuevos, autocontenidos y con tests,
que aportan el *estado* que hoy falta entre "algo cambió" y "súbelo". Ninguno
transfiere nada por sí mismo; el cableado con el recolector de cambios, los
comandos y la vista de actividad llega en una fase posterior sobre esta API.

**Índice de sincronización (`syncIndex`).** Recuerda, por destino real
(servicio + host:puerto + ruta remota + perfil), qué versión de cada archivo
local se subió y verificó por última vez (`size`, `mtime` local, `verifiedAt`,
estado `verified`/`failed`). Es lo que permite saber qué falta por subir sin
listar el servidor y detectar ediciones hechas con VS Code cerrado. Se persiste
como un JSON por clave bajo el almacenamiento por workspace de la extensión
(`context.storageUri`), con escritura atómica (`.tmp` + `rename`) y agrupada
(debounce de 1 s); sin workspace, solo en memoria. Las rutas se guardan
relativas a la base del servicio con `/`, y las búsquedas pliegan mayúsculas en
Windows y macOS conservando el casing original.

**Plan de carga (`uploadPlan`).** Manifiesto de un lote de subidas: ítems con
motivo (`new`, `modified`, `deleted`, `renamed`, `missing-remote`) y estado de
ejecución (`pending` → `uploading` → `verified`/`failed`/`skipped`/`stale`),
resumen, informe Markdown exportable y registro de los últimos 20 planes con
notificación de cambios (mismo patrón que `activityLog`). Incluye
`diffAgainstIndex`, la función pura que compara un escaneo local con el índice
y produce los ítems del plan (`mtime` comparado en segundos, como hace
`transfer.ts`).

**Escáner local (`localScanner`).** Recorre el árbol del servicio con `fs` de
Node (no `findFiles`, para poder podar subárboles con la función `ignore` del
servicio antes de leerlos), con concurrencia acotada, cancelación cooperativa,
progreso, y sin abortar por un directorio ilegible. Los enlaces simbólicos no se
siguen ni se listan salvo que se pida.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/syncIndex.ts`
- `SyncIndex` (`get`/`set`/`remove`/`rename`/`entries`/`size`/`clear`/`save`),
  `initSyncIndex`, `getSyncIndex` (carga perezosa por clave, una sola carga
  compartida ante llamadas concurrentes), `flushSyncIndex`, `indexKeyFor`
  (sha1 de los componentes normalizados), `toRelPath`, `__resetForTest`.
- Formato en disco: `{ version: 1, key, entries: { [relPath]: IndexEntry } }`
  en `<storagePath>/sync-index/<key>.json`. Un archivo corrupto o de otra
  versión se registra y se arranca vacío.

### [NUEVO] `src/modules/uploadPlan.ts`
- Tipos `PlanSource`, `PlanReason`, `PlanItemStatus`, `UploadPlanItem`,
  `UploadPlan`, `PlanSummary`; `createPlan` (id `YYYYMMDD-HHmmss-n`, fecha
  inyectable), `getPlans`/`getPlan`/`getLatestPlan`, `updateItem` (estampa
  `startedAt`/`finishedAt` del ítem y cierra o reabre el plan), `summarize`,
  `formatReport`, `onDidChange`, `clearPlans`, `diffAgainstIndex`,
  `__resetForTest`.
- Una entrada del índice en estado `failed` se vuelve a planificar como
  `modified` aunque `size` y `mtime` coincidan: el índice registra el intento,
  no un estado verificado.

### [NUEVO] `src/modules/localScanner.ts`
- `scanLocalTree(baseDir, options)` con `ignore`, `concurrency` (8),
  `isCancelled`, `onProgress` y `followSymlinks`; devuelve
  `{ files, dirs, cancelled, durationMs }`. Nunca rechaza por el árbol en sí.

### [NUEVO] `src/helper/fsPromises.ts`
- Tipado mínimo de `fs.promises` (`readdir` con `withFileTypes`, `lstat`,
  `stat`, `readFile`, `writeFile`, `rename`, `mkdir`, `unlink`): los
  `@types/node` 9 instalados no lo declaran y TypeScript 3.9 no admite unos más
  nuevos. Usar `fs` en vez de `vscode.workspace.fs` permite mockearlo con
  `memfs` en los tests.

### [MODIFICADO] `src/extension.ts`
- `activate`: `initSyncIndex` con `context.storageUri.fsPath` (o el
  `storagePath` obsoleto que es lo único que conocen los tipos 1.40).
- `deactivate`: `flushSyncIndex()` sin bloquear la desactivación; el error se
  registra en el canal de salida.

### [NUEVO] `src/modules/__tests__/syncIndex-test.ts`, `uploadPlan-test.ts`, `localScanner-test.ts`
- 59 pruebas con `jest.mock('fs')` + `memfs`: persistencia y escritura
  atómica, plegado de mayúsculas condicionado a la plataforma, claves
  estables, ids correlativos, cierre del plan, informe, límite de 20 planes,
  `diffAgainstIndex`, poda por `ignore`, cancelación, directorio ilegible y
  enlaces simbólicos.

## Impacto

- Sin cambio funcional visible todavía: nada alimenta el índice ni ejecuta
  planes hasta que la fase siguiente los cablee. Lo único observable es la
  carpeta `sync-index/` que aparecerá bajo el almacenamiento del workspace
  cuando se empiece a escribir en el índice.
- Sin cambios en `sftp.json`, comandos ni `package.json`.
