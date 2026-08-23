# Vista de planes de carga, comandos de plan y registro de actividad persistente

**Fecha:** 2026-08-22
**Área:** modules, commands, ui

## Descripción

Fase 4 del plan de
[02-analisis-cambios-externos-y-verificacion-carga.md](../02-analisis-cambios-externos-y-verificacion-carga.md)
(§3.4 presentación del plan, §3.6 experiencia de usuario y §2.4 D4). Hasta
ahora el plan de carga existía solo como datos (`uploadPlan`, fase 2) y el
registro de actividad se perdía con cada recarga de la ventana. Esta fase hace
visibles los planes y actuables desde la vista de actividad, añade los
comandos que los crean, ejecutan y exportan, y guarda el registro en disco.

**Registro de actividad persistente (D4).** `activityLog` escribe las 200
entradas más recientes en `activity-log.json` bajo el almacenamiento del
workspace (`context.storageUri`), con escritura atómica (`.tmp` + `rename`) y
agrupada (debounce de 1 s con `unref`); sin workspace, sigue solo en memoria.
Al activar la extensión se recargan: las entradas `Pending` pasan a `Cancelled`
con `error: 'interrupted by a window reload'`, los `Upload`/`Download` con ruta
local recuperan su `retry` (`uploadFile`/`downloadFile` sobre la ruta local,
el mismo que instalan los hooks de transferencia) y el contador de ids continúa
tras el mayor leído. `Retry All Failed` vuelve a ver los fallos de la sesión
anterior.

**Vista de actividad con dos niveles.** Mientras no hay planes, el árbol es el
de siempre (lista plana, más reciente primero, con el marcador "No activity
yet"); esta decisión mantiene intacto el aspecto actual para quien no use
planes. En cuanto existe un plan aparecen dos raíces expandidas: **Upload
plans** (un nodo por plan, más reciente primero, con sus ítems debajo) y
**Activity** (la lista de siempre). El `TreeView` se crea con `showCollapseAll`.

- Nodo de plan: etiqueta `HH:mm:ss · <origen> · <servicio>`, descripción
  `N files — V verified, F failed, P pending` (más `uploading`, `skipped` y
  `stale` solo si no son cero), icono por estado (`loading~spin` si el runner
  lo está ejecutando, `error` con fallos, `clock` con trabajo pendiente,
  `pass` terminado), tooltip con id, servicio, perfil, origen, fechas, resumen
  y bytes; `contextValue: 'sftpPlan'`.
- Nodo de ítem: etiqueta = nombre del archivo, descripción
  `<estado> · <motivo> · <ruta relativa al workspace>`, icono por estado
  (`verified` check, `failed` error, `uploading` spin, `pending`
  circle-outline, `skipped` dash, `stale` warning), tooltip con rutas local y
  remota, tamaño, intentos, duración y error; `contextValue: 'sftpPlanItem'`;
  el clic abre el archivo local (reutiliza `sftp.activity.reveal`, que ahora
  acepta cualquier nodo con ruta local) solo si el archivo existe.
- La vista publica la clave de contexto `sftp.hasUploadPlans` para que las
  acciones de plan del título de la vista aparezcan solo cuando hay planes, y
  se refresca con `uploadPlan.onDidChange` y `planRunner.onDidChangeRunning`.

**Comandos nuevos.** Se registran por el mecanismo existente de descubrimiento
por nombre de archivo (`src/commands/commandPlan*.ts` + `checkCommand`), como
el resto de comandos de paleta; los que reciben un nodo del árbol lo resuelven
contra el registro vivo de planes (`planShared.ts`) y, sin argumento, piden el
plan con un QuickPick cuando hay más de uno.

| Id | Título | Dónde | `when` |
| :--- | :--- | :--- | :--- |
| `sftp.plan.preview` | SFTP: Preview Upload (Dry Run) | paleta, título de la vista | `sftp.enabled` / `view == sftpActivity` |
| `sftp.plan.uploadAll` | SFTP: Upload Plan | paleta, título de la vista, menú del plan (inline) | `sftp.enabled` / `view == sftpActivity && sftp.hasUploadPlans` / `viewItem == sftpPlan` |
| `sftp.plan.uploadItem` | SFTP: Upload This File | menú del ítem (inline) | `view == sftpActivity && viewItem == sftpPlanItem` |
| `sftp.plan.skipItem` | SFTP: Skip | menú del ítem (inline) | `view == sftpActivity && viewItem == sftpPlanItem` |
| `sftp.plan.diffItem` | SFTP: Diff with Remote | menú del ítem | `view == sftpActivity && viewItem == sftpPlanItem` |
| `sftp.plan.exportReport` | SFTP: Export Last Upload Report | paleta, título de la vista, menú del plan (inline) | `sftp.enabled` / `sftp.hasUploadPlans` / `viewItem == sftpPlan` |
| `sftp.plan.remove` | SFTP: Remove Plan | menú del plan | `view == sftpActivity && viewItem == sftpPlan` |
| `sftp.plan.clearAll` | SFTP: Clear Upload Plans | paleta, título de la vista | `sftp.enabled` / `sftp.hasUploadPlans` |

- **Preview Upload (Dry Run)**: elige el servicio (QuickPick si hay varios,
  con el del editor activo primero) y el alcance (`Project` = `baseDir`,
  `Active folder` si el editor activo cae dentro del servicio, `Pick folder…`
  con `showOpenDialog`, rechazando carpetas fuera de `baseDir`); escanea con
  `scanLocalTree` (progreso cancelable, `ignore` del servicio), compara con
  `diffAgainstIndex` contra el índice del destino
  (`indexKeyFor({ baseDir, host, port, remotePath, profile: app.state.profile })`,
  rutas remotas resueltas con `UResource.from`, como `handleCtxFromUri`), crea
  el plan con `source: 'command'` y todos los ítems `pending` **sin
  ejecutarlo**, enfoca la vista (`sftpActivity.focus`) y resume ("12 file(s)
  would be uploaded (3 new, 9 modified); 40 unchanged") con un botón `Upload
  all`. Si no hay nada que subir no crea plan. Si el índice está vacío avisa de
  que todo cuenta como nuevo y remite a `SFTP: Rebuild Sync Index`.
- **Upload Plan** ejecuta `runPlan(plan.id)` y notifica el resumen (aviso si
  hubo fallos); rechaza si el plan ya está en ejecución o no tiene nada
  pendiente. **Upload This File** / **Skip** llaman a `runPlan(id, {
  itemPaths })` / `skipItem`. **Diff with Remote** reutiliza el handler `diff`
  con `Uri.file(localPath)`. **Export Last Upload Report** abre
  `formatReport(plan)` en un documento Markdown sin título. **Remove Plan**
  y **Clear Upload Plans** (con confirmación) no borran planes en ejecución y
  lo avisan.

## Tipo de Cambio

- `Agregado`
- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `src/modules/activityLog.ts`
- `initActivityLog({ storagePath })`, `flushActivityLog()`; guardado
  debounced y atómico de las 200 entradas más recientes sin `retry`; carga con
  `Pending → Cancelled`, reconstrucción del `retry` de subidas/descargas,
  continuación de `nextId`, filtro de filas malformadas, archivo ausente o
  corrupto tolerado. `clear()` también se persiste. `__resetForTest` limpia el
  estado de persistencia. Docblock ampliado.

### [MODIFICADO] `src/modules/uploadPlan.ts`
- `removePlan(id): boolean`, `formatSummary(summary)` (una línea de números
  compartida por la vista y las notificaciones) y `formatBytes` exportado.

### [NUEVO] `src/modules/planRunner.ts`
- **Stub** con las firmas pactadas (`RunPlanOptions`, `runPlan`, `skipItem`,
  `isPlanRunning`, `onDidChangeRunning`) para que esta rama compile; en la
  integración se conserva la implementación real de la rama hermana. Marcado
  con `// stub: replaced by the real runner at integration`.

### [NUEVO] `src/modules/activityView/nodes.ts`
- Tipos `GroupNode`, `PlanNode`, `PlanItemNode`, `ActivityTreeNode` (unión
  con `ActivityEntry`), guardas (`isGroupNode`, `isPlanNode`,
  `isPlanItemNode`, `isActivityEntry`, `isPlaceholder`), `localPathOf`,
  `nodeId`, `buildRootNodes`, `buildChildNodes`, `planNode`, `planItemNode`,
  `placeholder`. Funciones puras sin vscode.

### [NUEVO] `src/modules/activityView/format.ts`
- Etiquetas, descripciones, tooltips e iconos (`IconSpec = { id, color? }`) de
  entradas, planes e ítems, separados del proveedor para poder probarlos.

### [MODIFICADO] `src/modules/activityView/treeDataProvider.ts`
- Proveedor sobre la unión de nodos: raíces, grupos, planes e ítems; `id`
  estable por nodo; `isPlanRunning` para el icono del plan; `isPlaceholder`
  reexportado desde `nodes.ts`.

### [MODIFICADO] `src/modules/activityView/index.ts`
- `showCollapseAll`, suscripciones a `uploadPlan.onDidChange` y
  `planRunner.onDidChangeRunning`, clave de contexto `sftp.hasUploadPlans`,
  `reveal` sobre cualquier nodo con ruta local, `retry` solo sobre entradas.
  Docblock de clase.

### [NUEVO] `src/commands/planShared.ts`
- `planFromArg`, `planItemFromArg`, `pickPlan`: resolución del plan/ítem a
  partir del nodo del árbol o por QuickPick. No coincide con el patrón
  `command*.ts` del descubrimiento, a propósito.

### [NUEVO] `src/commands/commandPlanPreview.ts`, `commandPlanUploadAll.ts`, `commandPlanUploadItem.ts`, `commandPlanSkipItem.ts`, `commandPlanDiffItem.ts`, `commandPlanExportReport.ts`, `commandPlanRemove.ts`, `commandPlanClearAll.ts`
- Los ocho comandos descritos arriba.

### [MODIFICADO] `src/constants.ts`
- `COMMAND_PLAN_*` y `COMMAND_ACTIVITY_FOCUS` (`sftpActivity.focus`, generado
  por VS Code a partir del id de la vista), añadidos al final.

### [MODIFICADO] `src/extension.ts`
- `await initActivityLog({ storagePath })` tras `initSyncIndex` y antes de
  `initCommands`/`ActivityView`; `flushActivityLog()` en `deactivate` sin
  bloquear. Solo líneas nuevas.

### [MODIFICADO] `package.json`
- `contributes.commands` (8 comandos, con iconos), `menus.commandPalette`,
  `menus.view/title` y `menus.view/item/context` según la tabla. Añadidos al
  final de cada lista.

### [MODIFICADO] `src/modules/__tests__/activityLog-test.ts`
- Persistencia con `memfs`: guardado sin `retry`, modo memoria, sin escritura
  si nada cambió, límite 200 en disco y en carga, `clear` persistido, `.tmp`
  renombrado, debounce con fake timers legacy, carga con ids continuados,
  `Pending → Cancelled`, `retry` reconstruido para Upload/Download (handlers
  mockeados) y ausente para el resto, filas malformadas, archivo ausente,
  corrupto o de otra versión, y notificación tras la carga.

### [MODIFICADO] `src/modules/__tests__/uploadPlan-test.ts`
- `removePlan`, `formatSummary`, `formatBytes`.

### [NUEVO] `src/modules/__tests__/activityView-test.ts`
- Guardas, `localPathOf`, `nodeId`, agrupación de raíces e hijos, etiquetas,
  descripciones, tooltips e iconos, y el proveedor completo (lista plana,
  marcador, grupos, plan en ejecución, clic solo si el archivo existe,
  `activity.failed`) con un mock mínimo de `vscode` (`Uri`, `ThemeIcon`,
  `ThemeColor`, `EventEmitter`, `TreeItemCollapsibleState`).

## Impacto

- El historial de la vista de actividad (hasta 200 entradas) sobrevive a una
  recarga de la ventana y los fallos de subida/descarga siguen siendo
  reintentables después; aparece `activity-log.json` en el almacenamiento del
  workspace de la extensión.
- La vista de actividad cambia de forma solo cuando existe algún plan: pasa de
  lista plana a dos grupos expandidos. Las entradas existentes, sus acciones
  (`Retry`, clic para abrir) y el botón de limpiar no cambian.
- Ocho comandos nuevos; ninguno se ejecuta solo. Hasta que se integre el
  `planRunner` real, "Upload Plan", "Upload This File" y "Skip" notifican el
  error del stub si se invocan.
- Sin cambios en `sftp.json` ni en el esquema. Las tooltips de los nodos
  nuevos están en inglés, como el informe Markdown; las de las entradas de
  actividad conservan el texto existente.
- Verificación: `npx tsc --noEmit`, `npx tslint -p .`, `npm run compile` y la
  suite de Jest en verde (ver informe de la rama).
