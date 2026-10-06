# Actualización desde las releases de GitHub

**Fecha:** 2026-10-05
**Área:** modules, core, commands, ci

## Descripción

El usuario preguntó si la extensión podía actualizarse sola desde las
releases de GitHub cuando se publicara una versión nueva. VS Code solo
actualiza por su cuenta las extensiones que vienen del Marketplace; una
instalada desde un vsix se queda como está para siempre. Se eligió que la
propia extensión haga esa parte, porque el workflow de release ya deja un
vsix en cada release y no cambia el flujo de publicación; publicar en el
Marketplace sigue siendo posible y compatible con esto.

Comportamiento:

- Al activarse, y tras 15 s para no estorbar al arranque, consulta
  `https://api.github.com/repos/jalexiscv/vscode-sftp/releases/latest` según
  `sftp.updates.check`: `daily` (una vez cada 24 h, por defecto), `startup`
  (en cada activación) u `off`. Compara el tag con la versión instalada
  (`context.extension.packageJSON.version`).
- Si hay una versión mayor, ofrece `Install`, `Release notes` y `Skip this
  version`. Nada se instala sin que el usuario lo pida.
- `Install` descarga el vsix al almacenamiento global de la extensión
  (`<globalStorage>/updates/`), comprueba su SHA-256 contra el asset
  `<vsix>.sha256` que publica el workflow desde esta versión (una release sin
  checksum se instala sin verificar y se avisa en el canal de salida), lo
  instala con el comando interno `workbench.extensions.installExtension`
  (el mismo de *Install from VSIX…*) y ofrece recargar la ventana.
- `Skip this version` silencia el aviso automático solo para esa versión;
  el comando `SFTP: Check for Updates` la sigue ofreciendo y, a diferencia
  del aviso automático, dice algo en todos los casos (al día, sin vsix,
  fallo de red).
- Solo se acepta un vsix cuya URL empiece por
  `https://github.com/jalexiscv/vscode-sftp/releases/download/`; borradores
  y prereleases se ignoran. Un fallo del chequeo automático solo llega al
  log (`[updates] …`). Una versión instalada mayor que la última release (un
  build local) no se degrada.

## Tipo de Cambio

- `Añadido`

## Archivos Afectados

### [NUEVO] `src/core/httpClient.ts`
- `openStream`, `getBuffer`, `getText`, `getJson`, `downloadToFile` sobre
  `http`/`https` de node: redirecciones (absolutas y relativas, tope 5),
  timeout (15 s), `User-Agent` (GitHub rechaza sin él), `HttpStatusError`
  fuera de 2xx, descarga a `<destino>.part` con renombrado al final y borrado
  del parcial si falla o la longitud no cuadra. Sin dependencias nuevas.

### [NUEVO] `src/modules/updateChecker.ts`
- `init(context)` / `destroy()`: lee `sftp.updates.check`, decide si toca
  (`STATE_KEY_UPDATE_LAST_CHECK` en `globalState`) y programa el chequeo con
  `STARTUP_DELAY_MS` (temporizador con `unref`), una vez por activación.
- `checkForUpdates({ silent })`: consulta, compara, ofrece, instala; devuelve
  el desenlace (`up-to-date`, `available`, `skipped`, `installed`, `failed`,
  `no-release`, `unknown-version`).
- `compareVersions`, `parseRelease`, `fetchLatestRelease` como piezas puras;
  `__setDepsForTest` inyecta red y reloj.

### [NUEVO] `src/commands/commandCheckForUpdates.ts`
- `sftp.checkForUpdates` → `checkForUpdates({ silent: false })`.

### [MODIFICADO] `src/host.ts`
- `openExternal(url)`, `installExtensionFromVsix(fsPath)`, `reloadWindow()`.

### [MODIFICADO] `src/constants.ts`
- `STATE_KEY_UPDATE_LAST_CHECK`, `STATE_KEY_UPDATE_SKIPPED_VERSION`
  (globalState) y `COMMAND_CHECK_FOR_UPDATES`.

### [MODIFICADO] `src/extension.ts`
- `updateChecker.init(context)` tras registrar los comandos y antes de
  comprobar el workspace (una ventana sin `sftp.json` activada por el comando
  también recibe la oferta); `destroy()` en `deactivate`.

### [MODIFICADO] `package.json`
- Ajuste `sftp.updates.check` (`daily` | `startup` | `off`), comando
  `SFTP: Check for Updates` y evento de activación `onCommand:sftp.checkForUpdates`.

### [MODIFICADO] `.github/workflows/release.yml`
- Genera `<vsix>.sha256` (`sha256sum`) y lo adjunta a la release junto al
  vsix, también cuando la release ya existe (`--clobber`).

### [MODIFICADO] `.gitignore`
- `sftp-*.vsix.sha256`.

### [NUEVO] `src/core/__tests__/httpClient-test.ts`
- Once casos contra un servidor `http` local: JSON y cabeceras, texto,
  redirecciones relativas y absolutas, bucle de redirecciones, estado fuera
  de 2xx, JSON inválido, timeout, protocolo no soportado, descarga tras
  redirección con progreso y sin parcial, descarga truncada y descarga con
  error de estado.

### [NUEVO] `src/modules/__tests__/updateChecker-test.ts`
- Veintiséis casos: tabla de `compareVersions`; `parseRelease` con checksum,
  sin él, borradores, prereleases, sin vsix, asset ajeno y tag sin dígitos;
  oferta e instalación completa con verificación, checksum que no cuadra,
  release sin checksum, limpieza de descargas anteriores, notas de la
  release, descarte, omisión de versión y oferta por el comando, al día,
  build local más nuevo, fallo de red, release sin vsix, versión instalada
  desconocida, instalación fallida; chequeo automático `daily` (vencido y
  reciente), `startup`, `off` y cancelación con `destroy`.

### [MODIFICADO] `docs/setting.md`, `docs/commands.md`
- Sección `updates.check` y comando `SFTP: Check for Updates`.

## Impacto

- Quien instala el fork desde un vsix recibe aviso de cada release nueva y
  puede instalarla con dos clics y una recarga; antes había que volver a la
  página de releases a mano.
- Una petición a la API de GitHub al día por máquina (límite anónimo: 60 por
  hora e IP). Sin red no pasa nada visible.
- Las releases anteriores a esta no tienen `.sha256`: si se instalan desde el
  chequeo, van sin verificar y queda constancia en el log.
- Suite de 920 a 957 tests. Sin cambios en `sftp.json`.
