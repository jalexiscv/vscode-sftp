# "Error: Config Not Found" por casing de rutas en Windows

**Fecha:** 2026-07-05
**Área:** modules

## Descripción

Cluster de issues del upstream ("Error: Config Not Found on Ctrl+S",
"uploadOnSave stopped working", "upload con clic derecho funciona pero al
guardar no", PR #447): en Windows el filesystem es case-insensitive, pero el
Trie que indexa los servicios de archivo por ruta base solo normalizaba la
letra de unidad. Si VSCode reportaba el archivo guardado con un casing
distinto al del workspace configurado (p. ej. `D:\PROJECT` vs `d:\project`),
`findPrefix` no encontraba el servicio y la extensión lanzaba
`Error: Config Not Found` en cada guardado.

El mismo defecto afectaba al supresor del watcher: la comparación
`task.localFsPath === uri.fsPath` podía no reconocer una descarga en curso y
disparar una re-subida.

A diferencia del PR upstream #447 (que baja a minúsculas las claves dentro
del Trie de forma incondicional), el casefold se aplica solo en Windows y en
la capa del serviceManager, preservando la semántica case-sensitive en
Linux/macOS y sin alterar el `baseDir` real que usan el resto de componentes.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- Nueva función `toTrieKey()`: normaliza y, solo en Windows, baja a minúsculas la clave completa del Trie.
- `createFileService`, `getFileService` y `disposeFileService` indexan/buscan/eliminan con `toTrieKey()`; `FileService` sigue recibiendo la ruta con su casing original.

### [MODIFICADO] `src/helper/paths.ts`
- Nuevo helper `isSamePath()`: igualdad de rutas case-insensitive en Windows.

### [MODIFICADO] `src/modules/fileWatcher.ts`
- El supresor de re-subidas durante descargas compara rutas con `isSamePath()`.

## Impacto

- `uploadOnSave`, `downloadOnOpen` y el watcher encuentran la configuración aunque el casing reportado por VSCode difiera del configurado (Windows).
- Sin cambios de comportamiento en Linux/macOS.
