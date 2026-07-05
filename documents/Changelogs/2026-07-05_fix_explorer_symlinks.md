# Symlinks remotos a directorios no navegables en el Remote Explorer

**Fecha:** 2026-07-05
**Área:** modules

## Descripción

Issue upstream #283 "Remote symlinks to directories are not followed": el
Remote Explorer clasificaba cada entrada solo por su tipo `lstat`, así que
un enlace simbólico a un directorio se pintaba como archivo hoja: no se
podía expandir ni navegar (patrón muy común en despliegues tipo
`current -> releases/N`).

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/core/fs/fileSystem.ts`
- Nuevo método `stat()` en la clase base con fallback a `lstat()` para filesystems sin *followed-stat* nativo (FTP mantiene su comportamiento actual).

### [MODIFICADO] `src/core/fs/sftpFileSystem.ts`
- `stat()` real sobre `sftp.stat` de ssh2 (sigue el enlace).

### [MODIFICADO] `src/modules/remoteExplorer/treeDataProvider.ts`
- Al construir los hijos del árbol, las entradas `SymbolicLink` se resuelven con `stat()`; si el destino es un directorio, el nodo es expandible. Un enlace roto queda como hoja (el error se ignora).

## Impacto

- Los directorios enlazados simbólicamente se navegan en el Remote Explorer sobre SFTP; las operaciones de carpeta (descargar, subir) operan a través del enlace.
- Solo afecta al explorador: la semántica de sync/transferencias con symlinks no cambia (sin riesgo de recursión por enlaces).
- El costo extra es un `stat` por entrada symlink listada, solo cuando las hay.
