# Recarga de la configuración cuando sftp.json cambia fuera del editor

**Fecha:** 2026-07-05
**Área:** modules

## Descripción

Issue/PR upstream #494: la configuración solo se recargaba cuando
`sftp.json` se guardaba desde el propio editor (`onDidSaveTextDocument`).
Si el archivo cambiaba por medios externos —un cambio de rama de git, un
script, otra herramienta— la extensión seguía usando la configuración
anterior hasta reiniciar VSCode.

Se adopta la idea del PR #494 (un `FileSystemWatcher` sobre el archivo de
configuración) con tres correcciones sobre esa propuesta:

- El glob se normaliza a separadores `/` (el PR concatenaba `CONFIG_PATH`,
  que en Windows contiene `\` y produce un glob inválido).
- Se vigilan también `create` y `delete` (rama que agrega o elimina
  `sftp.json`); la recarga usa `tryLoadConfigs`, que resuelve a `[]` si el
  archivo ya no existe, eliminando servicios obsoletos sin error.
- Recarga con debounce de 500 ms por archivo: el guardado en el editor y el
  evento del watcher sobre el mismo cambio disparan una única recarga.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`
- Nuevo `configFileWatcher` (`vscode.workspace.createFileSystemWatcher`) sobre `**/.vscode/sftp.json` con handlers de create/change/delete.
- `handleConfigSave` usa `tryLoadConfigs(workspacePath)` en vez de `readConfigsFromFile(uri.fsPath)` para tolerar la eliminación del archivo.
- `requestConfigReload()` con debounce por archivo unifica el guardado del editor y los eventos del watcher.
- El watcher se libera en `destory()` y al re-registrar `watchWorkspace`.

## Impacto

- Cambiar de rama git (o editar sftp.json externamente) aplica la nueva configuración sin reiniciar VSCode ni reabrir la carpeta.
- Si la rama elimina sftp.json, los servicios asociados se eliminan limpiamente.
