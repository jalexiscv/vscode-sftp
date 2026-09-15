# Límites para proyectos grandes y descarte del almacenamiento al cambiar de versión

**Fecha:** 2026-09-15
**Área:** modules

## Descripción

Un proyecto de más de 90 000 archivos llevó a la extensión a proponer 90 000
archivos pendientes de subida y a dejar el extension host —el proceso que
comparten todas las extensiones— arrastrándose. Tres trabajos síncronos corrían
sobre esa cantidad de elementos: la vista de actividad materializaba un nodo de
árbol por cada elemento del plan en cada refresco; el índice de sincronización
(4 MB para ese proyecto) se serializaba con `JSON.stringify` una vez por
segundo mientras había cambios, es decir, durante toda la ejecución del plan; y
el diff contra el índice y la creación del plan recorrían arrays de 90 000
entradas. Ni el escáner de cambios externos ni el recolector del watcher tenían
tope: todo lo que difería del índice entraba en un solo plan, y el umbral de
confirmación (20) solo decidía si se preguntaba, no cuántos elementos se
aceptaban.

Este cambio pone tope al tamaño de un plan, pagina la vista, retiene los
guardados del índice mientras corre un plan y, a petición del usuario, descarta
los archivos que la extensión genera (índice y log de actividad) la primera vez
que una versión nueva se activa en un workspace.

## Tipo de Cambio

- `Agregado`
- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `src/core/fileService.ts`
- `ExternalChangesConfig.maxPlanItems` (número; `0` = sin límite) con valor por
  defecto `2000` en `DEFAULT_EXTERNAL_CHANGES`; `resolveExternalChangesConfig`
  lo resuelve (entero, `>= 0`) como al resto de claves.

### [MODIFICADO] `src/modules/config.ts`
- Validación Joi de `externalChanges.maxPlanItems` (entero `>= 0`) y valor por
  defecto en `mergedDefault`.

### [MODIFICADO] `schema/definitions.json`
- Propiedad `externalChanges.maxPlanItems` con su descripción y defecto.

### [MODIFICADO] `src/modules/externalChangeScanner.ts`
- Nuevo estado de escaneo `too-many` (con `changed` y `reason` en el
  `ScanOutcome`): si los archivos que difieren superan el límite, no se crea el
  plan; se registra un aviso `warn` en el canal de salida, se muestra un mensaje
  de advertencia con `Mark all as uploaded` (lanza
  `markLocalTreeAsUploadedInteractive`) y `Manage upload exclusions` (ejecuta
  `sftp.uploadExclude.manage`), y el servicio queda anotado en `overflowed`.
- Mientras un servicio está en `overflowed`, los disparadores automáticos
  (`startup`, `resume`, `focus`, `poll`) se omiten con motivo explícito; el
  disparador `config` (recarga de `sftp.json`) y el escaneo manual lo limpian
  antes de escanear, y también lo limpian un escaneo que vuelve a estar dentro
  del límite, `rebuildSyncIndex` y `markLocalTreeAsUploaded`.
- `testHooks.MANAGE_EXCLUSIONS_LABEL`; `__resetForTest` limpia `overflowed`.

### [MODIFICADO] `src/modules/changeCollector.ts`
- `planBatch` comprueba el límite **antes** de hacer `lstat` de cada cambio
  (una ráfaga de 90 000 eventos no debe costar 90 000 stats para descartarse) y
  otra vez tras expandir directorios (una carpeta soltada en el workspace llega
  como un evento y se expande a todo su árbol). Un lote por encima del límite se
  descarta con `warn` en el canal y una advertencia con los mismos dos botones,
  una sola vez por servicio y sesión (`oversizeNotified`, que `destroy` limpia).

### [MODIFICADO] `src/modules/activityView/nodes.ts`
- Nodo `MoreNode` (`nodeType: 'more'`, `shown`, `total`), `PLAN_ITEMS_PAGE = 200`,
  `isMoreNode`, `moreNode`; `buildChildNodes` acepta `visibleItems(planId)` y,
  cuando un plan tiene más elementos que los visibles, lista los primeros y
  cierra con el nodo "more". `nodeId` del nodo "more" es `plan:<id>:`, estable
  entre páginas.

### [MODIFICADO] `src/modules/activityView/treeDataProvider.ts`
- `_visibleItems` por plan, `showMore(planId)` (suma una página y refresca) y
  fila `N more file(s)…` con descripción `showing N of M`, icono `ellipsis`,
  `contextValue: 'sftpPlanMore'` y comando `sftp.plan.showMore`.

### [MODIFICADO] `src/modules/activityView/index.ts`
- Registro del comando `sftp.plan.showMore`.

### [MODIFICADO] `src/constants.ts`
- `COMMAND_PLAN_SHOW_MORE` y `STATE_KEY_STORAGE_VERSION`.

### [MODIFICADO] `package.json`
- Comando `sftp.plan.showMore` ("Show More Files", oculto en la paleta).

### [MODIFICADO] `src/modules/syncIndex.ts`
- `holdSyncIndexSaves()`: mientras haya retenciones, el guardado diferido de
  todo índice espera `SAVE_DEBOUNCE_HELD_MS` (60 s) en vez de 1 s; al soltar la
  última, `_rescheduleSave` rearma con el retardo normal cualquier guardado
  pendiente. `save()` y `flushSyncIndex()` no se ven afectados. `testHooks` con
  ambos retardos.

### [MODIFICADO] `src/modules/planRunner.ts`
- `execute` retiene los guardados del índice durante la ejecución del plan y
  los suelta en `finally`.

### [NUEVO] `src/modules/storageReset.ts`
- `discardStorageOnVersionChange({ storagePath, version, state })`: si la versión
  instalada difiere de la guardada en `workspaceState` (`sftp.state.storageVersion`),
  elimina los archivos de `sync-index/` (y la carpeta si queda vacía),
  `activity-log.json` y su `.tmp`, deja intacto cualquier otro archivo o
  subcarpeta, limpia el aviso descartado de índice no construido y registra la
  versión. Un workspace nuevo solo registra la versión; una versión desconocida
  no toca nada. Nunca rechaza. `extensionVersionOf(context)` lee
  `context.extension.packageJSON.version`.

### [MODIFICADO] `src/helper/fsPromises.ts`
- `rmdir` en la interfaz tipada.

### [MODIFICADO] `src/extension.ts`
- `activate` llama a `discardStorageOnVersionChange` antes de `initSyncIndex` e
  `initActivityLog`.

### [MODIFICADO] `docs/common_configuration.md`, `FAQ.md`
- Sección `externalChanges.maxPlanItems`, ejemplo JSON, párrafos de índice,
  recolector, escaneos y plan; entrada de FAQ para el aviso "too many to plan"
  y el descarte al actualizar.

### [MODIFICADO] Tests
- `config-test.ts` (defecto y validación), `externalChangeScanner-test.ts`
  (`too-many`, retención de disparadores automáticos, botones, rebuild, vuelta
  al límite), `changeCollector-test.ts` (ráfaga descartada, carpeta expandida,
  botones, límite 0), `activityView-test.ts` (nodos paginados y `showMore`),
  `syncIndex-test.ts` (`holdSyncIndexSaves`), nuevo `storageReset-test.ts`.
  Suite: 757 -> 786 tests.

## Impacto

- Un proyecto grande ya no puede quedarse con decenas de miles de elementos
  pendientes: por encima de `externalChanges.maxPlanItems` (2000) el escaneo o
  la ráfaga se convierten en un aviso con dos salidas (dar por subido, gestionar
  exclusiones) y los escaneos automáticos de esa conexión se detienen hasta que
  el usuario actúa. Quien quiera planes mayores sube el límite o lo pone a `0`.
- La vista de actividad muestra 200 elementos por página; la barra de estado y
  los informes no cambian.
- Durante una ejecución larga, el índice se escribe una vez por minuto en lugar
  de una vez por segundo; ante un cierre brusco se pierde como mucho un minuto
  de verificaciones, que el siguiente escaneo vuelve a proponer.
- **Al instalar una versión nueva, el índice y el log de actividad de cada
  workspace se descartan la primera vez que se abre**: el índice arranca vacío
  y vuelve el aviso de índice no construido (`Build index now` /
  `Mark all as uploaded`). Es un cambio de comportamiento deliberado, pedido por
  el usuario; el canal de salida lo registra. Nada del proyecto se toca.
