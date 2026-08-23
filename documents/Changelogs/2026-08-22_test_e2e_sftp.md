# Harness de pruebas de extremo a extremo: extensión real en VS Code real contra un servidor SFTP real

**Fecha:** 2026-08-22
**Área:** build, docs

## Descripción

Validación de la versión 1.24.0 (verificación de carga, índice de
sincronización, planes y detección de cambios externos) tal como la vive el
usuario: la extensión **compilada** (`dist/extension.js`) corriendo en un
**extension host real** de VS Code (instancia aislada con `--user-data-dir` y
`--extensions-dir` propios) contra un **servidor SFTP real** en `127.0.0.1`.
Nada se simula: el servidor es un proceso SFTP de verdad (escrito con el
paquete `ssh2` que la extensión ya usa), los archivos llegan a un directorio
del disco, y las comprobaciones se hacen sobre lo que el usuario podría ver:
el árbol del servidor, el canal de salida `sftp`, `activity-log.json` y
`sync-index/*.json` en el almacenamiento del workspace, y el registro de
peticiones del servidor.

El harness vive en `test/e2e/` y se ejecuta con `npm run test:e2e` (o
`SFTP_E2E=1 npx jest test/e2e`). Sin `SFTP_E2E=1` y sin VS Code instalado el
spec de Jest se omite, como `ftpFs.integration.spec.js`, así que `npm test`
no abre ventanas. No añade dependencias: usa el mecanismo de
`--extensionTestsPath` de VS Code (el mismo que envuelve
`@vscode/test-electron`) lanzando el `Code.exe` instalado.

Estrategia elegida: la opción A del plan (script ejecutado **dentro** del
extension host, con acceso a `vscode.commands.executeCommand`,
`workspace.openTextDocument`, etc.), sin el paquete `@vscode/test-electron`
porque lo único que aporta aquí —descargar VS Code y lanzarlo con las mismas
banderas— no hace falta con una instalación local, y así el runner puede
entrar en `package.json` sin dependencias nuevas. El README del harness
explica cómo usar `@vscode/test-electron` si se quiere.

Escenarios cubiertos (ids del plan de pruebas de la release), todos en verde
en la ejecución de referencia (Windows 11, VS Code 1.134.0, Node 24.18.1 en el
extension host):

| Id | Sesión | Qué demuestra |
| :-- | :-- | :-- |
| S1 | `fresh` | Activación con `.vscode/sftp.json`; comandos registrados; sin `[error]` en el canal ni en `exthost.log` tras activar |
| S7 | `fresh` | Índice vacío en el primer uso: el escaneo de arranque no sube nada y avisa; `Rebuild Sync Index` indexa solo los archivos idénticos (3 indexados, 1 distinto, 4 solo local, 1 solo remoto) |
| S2 | `fresh` | `Upload Project`: 8 archivos (uno binario de 100 KiB) en el servidor con el contenido exacto; un `LSTAT` de verificación por archivo; `activity-log.json` con `success`; índice `verified` |
| S3 | `fresh` | Servidor que trunca un archivo: 3 intentos (`retry 1/2`, `retry 2/2`), entrada `failed` con `size mismatch (local 2431, remote 0)`, índice `failed`; recuperación con `Retry All Failed Operations` → `verified` |
| S4 | `fresh` | Cambios hechos por otro proceso con VS Code abierto (`watcher.autoUpload`): 1 modificado + 5 nuevos en un solo plan `watcher`, 6 verificados; los ignorados (`ignore`) no suben |
| S5 | `fresh` | Guardar desde el editor con el watcher activo = **una** subida (un solo `OPEN` de escritura en el servidor, una sola entrada de actividad; el eco del watcher se descarta) |
| S8 | `fresh` | `Preview Upload (Dry Run)` no toca el servidor; `Export Last Upload Report`; `Upload Plan` sube y verifica; `Resume Auto Sync` dispara un escaneo que queda "up to date" |
| S6 | `reconcile` | Con VS Code cerrado se editan 2 archivos y se crean 2 (uno en carpeta nueva): el escaneo de arranque planifica 4 y los sube verificados; `Scan for External Changes` después no sube nada |
| S9 | `drain` | Guardar y cerrar la ventana de inmediato: `deactivate` vacía la cola y el archivo está en el servidor al cerrarse |
| S10 | `hash` | `verifyUpload: "hash"` contra un servidor sin shell degrada a `stat` con un único aviso; `useTempFile` sube a `.new` y renombra; todo verificado |

Hallazgo documentado (no es una regresión de 1.24.0; ocurre igual en `main`):
tras cada subida explícita, `refreshRemoteExplorer`
(`src/fileHandlers/shared.ts`) llama a `RemoteTreeData.refresh`, que lanza
`Can't find config for remote resource …` en
`src/modules/remoteExplorer/treeDataProvider.ts:140/196` cuando la vista del
explorador remoto nunca se ha abierto (`_rootsMap` es `null`). La promesa no
se espera ni se captura, así que queda como `[error]` en `exthost.log`. No
afecta a la transferencia ni al índice; el harness lo registra como nota
informativa (S1b). (Corregido después en la ronda 2 de la revisión
adversarial; véase la re-ejecución más abajo.)

## Re-ejecución sobre el código final

Segunda ejecución del harness sobre la rama de integración con todo el código
final de la 1.24.0 (`b4404fc`: rondas 1 y 2 de la revisión adversarial
incluidas), en las mismas condiciones (Windows 11, VS Code 1.134.0, Node
24.18.1 en el extension host, `npm run compile` previo). Resultado:
**13 de 13 escenarios en verde** en dos ejecuciones consecutivas
(`report.md` en `SFTP_E2E_RUN_DIR`), `npm test` en verde (37 suites, 701
pruebas; el spec E2E se omite sin `SFTP_E2E=1`). No se encontró ninguna
regresión del producto; todos los fallos iniciales previstos eran expectativas
del harness desfasadas por los cambios de la ronda 2.

| Id | Sesión | Resultado | Qué cambió respecto a la primera ejecución |
| :-- | :-- | :-- | :-- |
| S1 | `fresh` | PASA | Sin cambios |
| S7 | `fresh` | PASA | El resumen de `Rebuild Sync Index` tiene otro formato (`3 indexed (0 with another mtime on the server), 1 differ in size, 4 only local, 1 only remote; index marked as built`); se comprueba además que el aviso de índice vacío (`Build index now` / `Don't show again`) se muestra, que antes del rebuild el índice **no** está sembrado y que después el archivo lleva `seededAt`; la notificación resumen (`Indexed 3 files; 1 differ in size, …`) coincide con el log |
| S2–S5, S8 | `fresh` | PASA | Sin cambios (el watcher y los guardados siguen con la regla del umbral; el escaneo de `Resume Auto Sync` sobre un índice sembrado y completo sigue "up to date") |
| S1b | `fresh` | PASA (antes INFO) | Convertido en aserción: **0** líneas `[error]` en `exthost.log` en toda la sesión; el `Can't find config for remote resource …` del Remote Explorer ha desaparecido |
| S6 | `reconcile` | PASA (adaptado) | Con el índice sembrado por el `Rebuild` de S7, el escaneo de arranque que encuentra 2 modificados + 2 nuevos **abre el modal de confirmación** (`Review plan` por defecto, `Upload 4 file(s)`, `Skip`); el harness comprueba que mientras el diálogo espera **no hay ninguna subida** (0 `OPEN` de escritura, sin `[plan …] uploading`, los nuevos sin entrada en el índice), contesta `Upload 4 file(s)` y verifica `user chose "run"` → `4 verified, 0 failed` → contenido en el servidor e índice `verified`; el escaneo manual posterior sigue "up to date" sin escrituras |
| S6c | `reconcile` | PASA (nuevo) | Con la sincronización pausada se crea un archivo desde fuera (el watcher lo descarta: `auto sync is paused`); `Resume Auto Sync` lanza el escaneo `resume`, que abre el modal; `Skip` deja `status: 'skipped'` en el índice, no sube nada y un escaneo manual después lo deja en paz ("up to date") |
| S6b | `drain` | PASA (nuevo) | Antes de la sesión se modifica **solo** un archivo ya indexado: el escaneo de arranque lo sube solo (`1 verified, 0 failed`), sin diálogo (`0` modales registrados, sin `user chose`) |
| S9 | `drain` | PASA | Sin cambios (el drenaje de `deactivate` con `confirm: false` sube el guardado de 1 archivo) |
| S10 | `hash` | PASA | Sin cambios |

Lo que se adaptó en el harness y por qué:

- **Diálogos modales conducidos desde el script del extension host.** El
  host entrega a todo módulo que vive bajo la ruta de una extensión el
  **mismo** objeto de API `vscode` (una instancia por extensión, elegida por
  la ruta del archivo que hace `require`), y `extensionHost.js` está bajo el
  `extensionDevelopmentPath`. Envolver `vscode.window.show*Message` al cargar
  el módulo lo envuelve también para la extensión: las llamadas modales se
  **retienen** (se registran, no se muestran) hasta que un escenario las
  contesta con uno de los botones ofrecidos (`pendingModal(/patrón/)` →
  `dialog.answer('Skip')`); las no modales pasan y se registran. Cada llamada
  (mensaje, botones, respuesta) queda como evidencia, y un modal retenido que
  nadie contesta se comporta como un diálogo que el usuario no cierra, que es
  justo lo que afirman las comprobaciones de "nada sube mientras el diálogo
  espera". Comprobado empíricamente en esta ejecución: el modal del plan de
  arranque y el del escaneo `resume` llegaron al driver con el texto y los
  botones esperados. El perfil añade `window.dialogStyle: custom` como red de
  seguridad: un modal que el driver no capturase sería un diálogo del
  workbench, no nativo, y nunca bloquearía el cierre de la ventana.
- **`.vscode/sftp.json` retenido en la sesión `reconcile`.** El módulo de
  pruebas se carga **después** de las activaciones ansiosas (`Eager
  extensions activated` → `run()` 3 ms más tarde en los logs), así que un
  escaneo de arranque disparado por `workspaceContains:.vscode/sftp.json` ya
  habría pedido su diálogo antes de existir el driver. El runner aparta el
  archivo (`sftp.json.e2e-held`) antes de lanzar VS Code y el script lo
  restaura y activa la extensión él mismo: es el mismo `activate()` →
  `scanAll('startup')` (`trigger startup` en el log). La sesión `drain` no lo
  necesita: su plan de arranque solo tiene modificados y debe correr sin
  preguntar.
- **Fixtures.** Las ediciones offline de `reconcile` llevan `kind`
  (`modified` / `new`); antes de `drain` se aplica una edición offline más de
  un archivo indexado (`notes/readme.txt`).
- **S7, S1b y README** como se describe en la tabla; el README documenta el
  driver de diálogos, la retención de la configuración y las nuevas filas de
  la tabla de sesiones.

Observación para el integrador (comportamiento del producto, no regresión):
cuando el escaneo de arranque encuentra a la vez archivos modificados y
archivos nuevos, el plan es uno solo y **todo** espera al diálogo, también los
modificados (S6 lo evidencia: 0 subidas hasta contestar). Los modificados solo
se suben por sí solos cuando el plan no contiene ningún `new` (S6b). La
entrada `skipped` que deja `Skip` lleva `verifiedAt: 0`.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `test/e2e/sftpServer.js`
- Servidor SFTP con `ssh2.Server`: usuario/contraseña `test`/`test`, raíz en un
  directorio local, handlers REALPATH/OPEN/READ/WRITE/CLOSE/STAT/LSTAT/FSTAT/
  SETSTAT/FSETSTAT/OPENDIR/READDIR/MKDIR/RMDIR/REMOVE/RENAME/READLINK, `exec`
  rechazado (sin shell), registro de peticiones (`ops`) e inyección de fallos
  (`faults.truncate`, `faults.failWrite`). `snapshotTree` y `findFreePort`.

### [NUEVO] `test/e2e/control.js`
- Canal de control JSON-lines sobre TCP (solo Node) entre el runner y el script
  del extension host.

### [NUEVO] `test/e2e/extensionHost.js`
- Script cargado con `--extensionTestsPath`: ejecuta las sesiones `fresh`,
  `reconcile`, `drain` y `hash`, con los escenarios de la tabla; lee el canal
  de salida (`logs/**/output_logging_*/N-sftp.log`), `activity-log.json` y
  `sync-index/*.json`; escribe resultados y evidencia en JSON.

### [NUEVO] `test/e2e/runner.js`
- Orquestador: arranca el servidor, prepara los workspaces y el perfil de VS
  Code (`settings.json` con `sftp.debug`, sin confianza de workspace), lanza
  `Code.exe` por sesión (limpiando `ELECTRON_*`/`VSCODE_*` del entorno), hace
  las ediciones "con VS Code cerrado", atiende el canal de control, recoge
  logs y genera `results/report.md` y `summary.json`; sale con 1 si algo falla.

### [NUEVO] `test/e2e/sftpE2e.spec.js`
- Envoltorio Jest gateado por `SFTP_E2E=1` y la presencia de VS Code; lanza el
  runner como proceso hijo y comprueba el veredicto.

### [NUEVO] `test/e2e/README.md`
- Cómo funciona, cómo se ejecuta, variables de entorno, qué cubre cada sesión,
  dónde queda la evidencia y cómo añadir escenarios (en inglés).

### [MODIFICADO] `package.json`
- Script `test:e2e`: `node test/e2e/runner.js`. Sin dependencias nuevas.

## Impacto

- Sin cambios en `src/` ni en el comportamiento de la extensión.
- `npm test` sigue igual (el spec E2E se omite salvo `SFTP_E2E=1`).
- El directorio de cada ejecución (`<tmp>/vscode-sftp-e2e/<fecha>` o
  `SFTP_E2E_RUN_DIR`) conserva el servidor, el perfil de VS Code y los
  informes como evidencia.
- Limitaciones: los lotes se mantienen por debajo del umbral de confirmación y
  el workspace de prueba no es un repositorio git, así que el único modal que
  aparece es el de los planes de escaneo con archivos nuevos (S6/S6c), que el
  driver de diálogos contesta; probado en Windows (las rutas de `Code.exe`
  para macOS/Linux están previstas pero no ejercitadas).
