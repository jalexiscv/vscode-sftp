# Correcciones al sistema de ignore: sftp.json nunca se sube y patrones rotos en Windows

**Fecha:** 2026-07-05
**Área:** core

## Descripción

Dos defectos relacionados en el matcher de exclusiones de `FileService`:

1. **Seguridad** (issues upstream "sftp.json is being uploaded containing
   sensitive info", "Syncing local to remote also uploads the sftp.json
   file"): el `ignore` por defecto es `[]`, así que un *Sync Local → Remote*
   del workspace subía `.vscode/sftp.json` —con host, usuario y contraseña—
   al servidor, con frecuencia dentro del docroot público.
2. **Patrones inertes en Windows** (cluster "ignore not working"): la ruta
   relativa se calculaba con `path.relative`, que en Windows usa `\`, pero el
   paquete `ignore` implementa semántica gitignore y solo entiende `/`; la
   mayoría de patrones no casaban nunca. Además la detección local/remoto
   comparaba prefijos con sensibilidad a mayúsculas, clasificando mal rutas
   locales con casing distinto.

## Tipo de Cambio

- `Seguridad` (punto 1)
- `Corregido` (punto 2)

## Archivos Afectados

### [MODIFICADO] `src/core/fileService.ts`
- `filesIgnoredFromConfig()` antepone siempre el patrón anclado `/.vscode/sftp.json` (derivado de `CONFIG_PATH`), independientemente del `ignore` del usuario. Archivos hermanos como `.vscode/settings.json` no se ven afectados.
- `_createIgnoreFn()` convierte la ruta relativa a separadores `/` antes de evaluar el matcher y decide local/remoto con comparación case-insensitive en Windows.

## Impacto

- Las credenciales del proyecto no pueden volver a filtrarse al servidor por un sync/upload, ni siquiera con `ignore` personalizado o vacío.
- Los patrones de `ignore`/`ignoreFile` funcionan en Windows igual que en Linux/macOS.
- Quien sincronice la carpeta `.vscode` completa seguirá subiendo el resto de su contenido, excepto `sftp.json`.
