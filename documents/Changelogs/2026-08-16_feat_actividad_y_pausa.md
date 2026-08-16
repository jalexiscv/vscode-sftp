# Vista de actividad y modo pausa

**Fecha:** 2026-08-16
**Área:** modules, ui

## Descripción

Dos funciónalidades de control sobre lo que la extensión hace de forma
automática.

**Vista de actividad.** Una segunda vista en el contenedor SFTP de la barra
lateral con el historial estructurado de cada transferencia, borrado y
renombrado: tipo, estado, hora, ruta local y remota, perfil, duracion y error.
El canal de salida ya registraba todo, pero un log plano responde mal a "que ha
pasado?": no se filtra, un fallo se pierde con el scroll y no hay forma de
actuar sobre una entrada. Los fallos se reintentan de uno en uno o todos a la
vez, secuencialmente para no saturar una conexión que ya está fallando.

**Modo pausa.** `SFTP: Pause/Resume Auto Sync` suspende `uploadOnSave`,
`downloadOnOpen`, el watcher y la replica de borrados y renombrados. Los
comandos explícitos siguen funciónando: invocar un comando *es* la forma de
saltarse la pausa para una operación concreta. El estado se guarda por workspace
y se muestra en la barra de estado.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/activityLog.ts`, `src/modules/activityView/`
### [NUEVO] `src/commands/commandToggleAutoSync.ts`, `commandPauseAutoSync.ts`, `commandResumeAutoSync.ts`, `commandActivityClear.ts`, `commandActivityRetryAllFailed.ts`

### [MODIFICADO] `src/ui/statusBarItem.ts`
- `setPausedState()`, `setQueueSize()` y `setDetail()`.
- **El módulo no importa nada de `src/modules/`.** `app.ts` construye el
  singleton en tiempo de importación y todo módulo de `modules/` vuelve a `app`
  a través de `logger` -> `ui/output`; leer el estado de pausa desde aqui cerraba
  ese ciclo y ejecutaba el constructor contra un módulo a medio inicializar. El
  estado se empuja desde `extensión.ts`.

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`, `src/modules/serviceManager/index.ts`, `src/extensión.ts`, `package.json`

## Impacto

- El indicador de la barra de estado muestra el perfil activo, la cola pendiente
  y si la sincronización está pausada.
- La vista se oculta con el ajuste `sftp.showActivityView`.
- El ciclo de importación descrito arriba se detectó al escribir el primer test
  del módulo: compilaba y arrancaba bien, y solo fallaba cuando algo cargaba
  `modules/` antes que `app`.
