# Exclusiones de subida editables desde la interfaz

**Fecha:** 2026-09-13
**Área:** modules, commands, connectionManager, package.json, docs

## Descripción

`uploadExclude` (1.25.0) solo podía editarse a mano en `sftp.json`. El
usuario pidió una lista de directorios excluidos de la subida que se pueda
alimentar **uno a uno desde la interfaz gráfica** de la extensión. Este cambio
la ofrece por tres vías, todas sobre la misma lista del archivo:

1. **Explorador de archivos**: clic derecho sobre una carpeta (o archivo) →
   `SFTP: Exclude from Upload`. Se calcula el patrón anclado relativo a la
   raíz del servicio (`/storage`, `/public/uploads`) y se añade a la lista
   `uploadExclude` **base** de la entrada de `sftp.json` que corresponde al
   servicio, respetando la indentación y el salto final del archivo; el
   watcher de configuración recarga los servicios. Sobre una carpeta ya
   excluida el mismo menú muestra `SFTP: Include in Upload Again`, que quita
   el patrón. La distinción se hace con la clave de contexto
   `sftp.uploadExcludedPaths` (`resourcePath in …`), que contiene las rutas
   absolutas de los patrones anclados sin comodines de todos los servicios y
   se recalcula al activar, al recargar `sftp.json`, al cambiar de perfil y
   tras cada edición. Con selección múltiple, una escritura por servicio;
   desde la paleta se abre un selector de carpetas.
2. **`SFTP: Manage Upload Exclusions`** (paleta y menú `…` del explorador
   remoto): QuickPick con la lista en vigor (base + lista propia del perfil
   activo, esta marcada como heredada y no editable), `Add a folder…`
   (selector, varias a la vez), `Add a pattern…` (cualquier patrón gitignore)
   y, al elegir un patrón, confirmación modal para quitarlo. El pick vuelve a
   abrirse tras cada acción.
3. **Administrador de conexiones** (webview): nueva sección "Excluidos de la
   subida (uploadExclude)" en el formulario, con la lista (entradas heredadas
   de la base atenuadas en una conexión, propias con botón `×`), campo de
   texto y botón `Añadir` (también con Enter). Se guarda con el resto del
   formulario.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/uploadExclusions.ts`
- `patternForPath(service, fsPath)` → patrón anclado `/rel/ruta` o `null`
  (raíz o fuera del servicio); `pathForPattern(service, pattern)` → ruta local
  de un patrón anclado sin comodines, negación ni `..`, o `null`.
- `listExclusions`, `addExclusions` (dedup contra base + perfil activo,
  una escritura), `removeExclusion` (solo lista base; borra la clave al
  vaciarse), `excludePath`.
- Lectura/escritura de `sftp.json` con `fsPromises` + `JSON.parse/stringify`,
  localizando la entrada por `getBasePath(entry.context, workspace) ===
  service.baseDir` (misma resolución que `createFileService`); conserva la
  indentación detectada y el salto de línea final.
- `excludedPaths()` y `refreshContext()` → `setContextValue('uploadExcludedPaths', …)`.

### [NUEVO] `src/commands/commandUploadExcludeAdd.ts`, `commandUploadExcludeRemove.ts`, `commandUploadExcludeManage.ts`
- `sftp.uploadExclude.add`, `sftp.uploadExclude.remove` (oculto en paleta),
  `sftp.uploadExclude.manage`.

### [MODIFICADO] `src/constants.ts`
- Tres ids de comando.

### [MODIFICADO] `src/extension.ts`, `src/modules/fileActivityMonitor.ts`
- `refreshContext()` tras crear los servicios, al cambiar de perfil
  (`app.state.subscribe`) y tras recargar `sftp.json` (`handleConfigSave`).

### [MODIFICADO] `src/modules/connectionManager/webviewHtml.ts`
- Sección de exclusiones: CSS `.excl-list`/`.excl-add`, `renderExclusions`,
  `addExclusion`, `removeExclusion`, cableado del botón y de Enter.

### [MODIFICADO] `src/modules/connectionManager/index.ts`
- `uploadExclude` en `NON_CONNECT_OPTIONS` (no viaja a `testRemoteConnection`).

### [MODIFICADO] `package.json`
- Comandos, paleta, `explorer/context` (grupo `sftp.exclude@1` con `when`
  `resourcePath in sftp.uploadExcludedPaths` y su negación) y `view/title`
  del explorador remoto.

### [NUEVO] `src/modules/__tests__/uploadExclusions-test.ts`
- 13 tests: patrones ida y vuelta (contexto anidado incluido), alta con
  indentación de 2 y 4 espacios y con/sin salto final, dedup sin reescritura,
  archivo en forma de array por `context`, perfil activo heredado y no
  editable, baja y borrado de la clave, ruta fuera de la raíz, archivo
  ausente o corrupto, clave de contexto con varios servicios y servicio sin
  entrada.

### [MODIFICADO] `docs/commands.md`, `docs/configuration.md`, `docs/common_configuration.md`, `FAQ.md`
- Nueva sección de comandos y párrafo en `uploadExclude` / FAQ.

## Decisiones de diseño

- **Solo se edita la lista base.** Los patrones propios de un perfil se
  muestran como heredados; editarlos exigiría decidir si un clic derecho va a
  la base o al perfil activo, y la base es lo que el usuario espera al excluir
  "el directorio" del proyecto.
- **Patrón sin barra final** (`/storage`, no `/storage/`): casa el directorio
  y todo lo que contiene, y coincide con los ejemplos de la documentación.
- **No se toca `FileService`**: la lista cruda se lee del archivo (pequeño)
  cada vez que se recalcula el contexto; evita exponer la configuración
  completa (con credenciales) por un getter.
- **Sin fallback "única entrada"** al localizar la entrada del archivo: la
  resolución de `context` es idéntica a la de `createFileService`, así que un
  servicio legítimo siempre casa; un servicio huérfano no debe editar otra
  entrada.
- **Escritura propia en vez de `fs-extra.outputJson`**: conserva la
  indentación del archivo del usuario (el administrador de conexiones fuerza
  4 espacios) y es comprobable con `memfs`.

## Impacto

- Ninguna clave nueva; `sftp.json` sigue siendo la única fuente de verdad y
  se recarga por el watcher existente.
- Los comentarios de `sftp.json` ya no se conservaban (se lee con
  `readJson`); esta escritura tampoco los conserva, como el administrador.
- Suite: 744 → 757 tests; `tslint` y `tsc` sin errores.
