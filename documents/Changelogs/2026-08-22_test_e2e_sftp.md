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
informativa (S1b).

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
- Limitaciones: los diálogos modales (umbral de confirmación, lotes de git) no
  se manejan, así que los lotes se mantienen por debajo del umbral y el
  workspace de prueba no es un repositorio git; probado en Windows (las rutas
  de `Code.exe` para macOS/Linux están previstas pero no ejercitadas).
