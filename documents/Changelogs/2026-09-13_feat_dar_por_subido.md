# Dar por subidos los archivos de un plan o el árbol local entero

**Fecha:** 2026-09-13
**Área:** modules, commands, package.json, docs

## Descripción

Hasta ahora, cuando un escaneo encontraba muchos archivos que la extensión no
había subido ella misma, el usuario solo podía subirlos, dejarlos pendientes
(`Review plan`) o descartarlos (`Skip`). En un sitio espejado durante años a
mano o con `uploadOnSave` —el caso del log que motivó el cambio: 93 062
archivos sin indexar sobre FTP— ninguna de las tres sirve: subir satura la
conexión, dejar pendiente bloquea los escaneos automáticos, y `Skip` deja en
el índice una entrada que no describe la realidad (los archivos **sí** están
en el servidor). Faltaba poder **darlos por subidos**.

Este cambio añade esa respuesta en tres niveles:

1. **En el diálogo de confirmación** de cualquier plan (escaneo, sondeo,
   watcher, guardados, git): cuarto botón `Mark as uploaded`, entre `Upload N
   file(s)` y `Skip`. Los ítems pendientes quedan `assumed` y el índice los
   registra como `verified` con la marca `assumed: true`, con el tamaño y la
   mtime medidos; nada se transfiere. Si era un escaneo manual sobre un índice
   sin sembrar, el índice queda sembrado igual que tras una subida confirmada.
2. **En la vista de actividad**: `Mark Plan as Uploaded` sobre un plan (menú
   contextual y paleta, con confirmación modal que indica cuántos archivos) y
   `Mark as Uploaded` sobre un archivo (botón en línea y menú contextual, sin
   confirmación, como `Skip`).
3. **Para el árbol entero**: comando `SFTP: Mark Local Files as Uploaded`,
   ofrecido también como `Mark all as uploaded` en el aviso de "índice no
   construido". Recorre el árbol local (podado por `ignore` y
   `uploadExclude`), muestra el recuento en un modal y, si se confirma,
   reemplaza el índice con una entrada `verified`+`assumed` por archivo, lo
   marca como sembrado y da por resueltos (`assumed`) los ítems abiertos de
   los planes de ese servidor, lo que desbloquea los escaneos automáticos.
   No lista el servidor ni conecta: es la alternativa rápida a `Rebuild Sync
   Index` cuando se sabe que el árbol local es lo que hay en el servidor.

Nuevo estado de ítem de plan `assumed`, contado aparte de `verified` en el
resumen (`N assumed uploaded`), en el informe Markdown y en el icono de la
vista (check sin color, frente al check verde de una subida verificada).

De paso se corrige una **fuga de credenciales en el log**: `config at …`
enmascaraba `password` en la raíz pero no dentro de `profiles`, así que la
contraseña de cada perfil salía en claro en el canal de salida (visible en el
log del usuario). `maskConfig` enmascara ahora también cada perfil.

## Tipo de Cambio

- `Agregado`
- `Corregido` (enmascarado de contraseñas de perfiles en el log)

## Archivos Afectados

### [MODIFICADO] `src/modules/syncIndex.ts`
- `IndexEntry.assumed?: boolean`: entrada `verified` afirmada por el usuario,
  no comprobada contra el servidor.

### [MODIFICADO] `src/modules/syncIndexFeeder.ts`
- Nueva `rememberAssumedUploaded(service, files, config?)`: escribe entradas
  `verified` con `assumed: true` y `verifiedAt` actual; devuelve cuántas.

### [MODIFICADO] `src/modules/uploadPlan.ts`
- `PlanItemStatus` incorpora `assumed` (terminal); `PlanSummary.assumed`;
  `formatSummary` añade `N assumed uploaded` cuando no es cero;
  `formatReport` lo incluye.

### [MODIFICADO] `src/modules/planRunner.ts`
- Nueva `markAsUploaded(planId, itemPaths?)`: pasa a `assumed` los ítems
  `pending`/`stale`/`failed` (o el subconjunto indicado), limpia `error` y
  escribe el índice del servicio propietario en una sola llamada.

### [MODIFICADO] `src/modules/planConfirmation.ts`
- `PlanDecision` admite `assume`; botón `Mark as uploaded`; la rama `assume`
  marca los pendientes y llama a `rememberAssumedUploaded` cuando se conoce el
  servicio.

### [MODIFICADO] `src/modules/externalChangeScanner.ts`
- El escaneo manual siembra el índice también con decisión `assume`.
- Aviso de índice no construido con tercer botón `Mark all as uploaded`.
- Nuevas `markLocalTreeAsUploaded(service, options)` (con `confirm(count)`
  opcional, cancelación cooperativa y progreso), `formatMarkUploadedSummary`
  y `markLocalTreeAsUploadedInteractive` (progreso cancelable + modal con el
  recuento + resumen); `settleOpenPlanItems` cierra los ítems abiertos de los
  planes del servicio.

### [MODIFICADO] `src/modules/activityView/format.ts`
- Icono `check` sin color para `assumed`.

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- `maskConfig` exportada y recursiva sobre `profiles`.

### [MODIFICADO] `src/constants.ts`
- `COMMAND_PLAN_MARK_UPLOADED`, `COMMAND_PLAN_MARK_ITEM_UPLOADED`,
  `COMMAND_MARK_LOCAL_TREE_UPLOADED`.

### [NUEVO] `src/commands/commandPlanMarkUploaded.ts`
- `sftp.plan.markUploaded` (paleta y menú del plan): rechaza un plan en
  ejecución, confirma con el recuento y llama a `markAsUploaded`.

### [NUEVO] `src/commands/commandPlanMarkItemUploaded.ts`
- `sftp.plan.markItemUploaded` (solo desde el nodo de archivo).

### [NUEVO] `src/commands/commandMarkLocalTreeUploaded.ts`
- `sftp.markLocalTreeUploaded`: elige el servicio y delega en
  `markLocalTreeAsUploadedInteractive`.

### [MODIFICADO] `package.json`
- Tres comandos nuevos, entradas de paleta y menús `view/item/context`
  (`1_run@2` en el plan; `inline@3` y `1_run@3` en el archivo).

### [MODIFICADO] tests
- `uploadPlan-test.ts`: resumen, informe y cierre del plan con `assumed`.
- `planConfirmation-test.ts`: cuatro botones; `Mark as uploaded` con y sin
  servicio.
- `planRunner-test.ts`: `markAsUploaded` completo, por subconjunto, sobre un
  ítem fallido y con plan desconocido.
- `syncIndexFeeder-test.ts`: `rememberAssumedUploaded`.
- `externalChangeScanner-test.ts`: aviso con tres botones, siembra con
  `assume`, `Mark all as uploaded` desde el aviso, `markLocalTreeAsUploaded`
  (reemplazo del índice, poda, sin conexión, cierre de planes propios,
  cancelación y rechazo, forma interactiva).
- `activityView-test.ts`: icono de `assumed`.
- `serviceManager-test.ts`: `maskConfig` con perfiles.
- Suite: 730 → 744 tests.

### [MODIFICADO] `docs/commands.md`, `docs/configuration.md`, `docs/common_configuration.md`, `FAQ.md`
- Cuarto botón del diálogo, nueva sección `SFTP: Mark Local Files as
  Uploaded`, filas nuevas en la tabla de acciones de la vista, aviso con tres
  botones y alternativa a `Rebuild Sync Index` en "First use".

## Decisiones de diseño

- **`assumed` es un estado propio, no `verified`.** El índice y los informes
  deben distinguir lo comprobado de lo afirmado; en el índice se conserva
  `status: 'verified'` (así `diffAgainstIndex` y todo lo que consulta el
  índice sigue igual) y la distinción va en la marca `assumed`.
- **`Skip` no cambia.** Sigue siendo "esta versión no sube"; la diferencia con
  "dar por subido" es semántica (y el sembrado del índice), no de
  comportamiento en el siguiente escaneo: ambas dejan de proponer el archivo
  hasta que cambie.
- **`Mark Local Files as Uploaded` reemplaza el índice entero**, como
  `Rebuild Sync Index`: una entrada `failed` anterior queda como `verified`
  asumida, porque el usuario afirma que todo está en el servidor.
- **El escáner no importa `planRunner`** (arrastraría la capa de
  transferencia a su test): `settleOpenPlanItems` actúa sobre `uploadPlan`
  directamente y no comprueba `isPlanRunning`; un ítem que el runner tome a la
  vez pasa a `uploading` → `verified`, resultado benigno.
- **Sin confirmación por archivo**, igual que `Skip`; con confirmación modal
  y recuento para un plan entero y para el árbol, porque son miles de
  entradas y la respuesta se recuerda.

## Impacto

- Ninguna clave nueva de configuración; sin usar los comandos el comportamiento
  no cambia salvo el botón adicional en el diálogo y en el aviso.
- Los índices escritos antes de este cambio siguen siendo válidos (`assumed`
  es opcional).
- El canal de salida deja de mostrar las contraseñas de los perfiles.
- Suite completa en verde (744), `tslint` y `npm run compile` sin errores.
