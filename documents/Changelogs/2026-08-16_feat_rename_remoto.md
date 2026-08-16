# Renombrar y mover se replican como `rename` en el servidor

**Fecha:** 2026-08-16
**Área:** fileHandlers

## Descripción

Renombrar o mover un archivo en local se replica como un `rename` del lado del
servidor (`renameRemoteOnLocalRename`, activo por defecto) en lugar de subir el
archivo de nuevo y borrar la ruta antigua. El archivo conserva su identidad
remota (permisos, propietario) y no existe ningún instante en el que la ruta
falte en el servidor, algo que importa cuando el remoto es un docroot en
producción.

## Tipo de Cambio

- `Corregido`
- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/fileHandlers/rename.ts`
- **Corrige un bug que hacía que el renombrado nunca funciónase.** El handler
  llamaba `fileOperations.rename(originPath, localFsPath, remoteFs)` con dos
  rutas **locales** contra un filesystem **remoto**, y además invertidas: el
  primer argumento era la ruta nueva y el segundo la vieja.
- Nueva firma `{ fromLocalPath }`, con el contexto apuntando al destino y la
  traducción a ruta remota mediante `toRemotePath`.
- `ensureDir` del directorio destino, para que mover a una carpeta que aún no
  existe en el servidor funcióne.
- Repliegue a subida cuando el origen no está en el servidor, **restringido a
  errores de "no existe"**: subir tras un fallo de permisos dejaría la ruta
  vieja y la nueva en el servidor e informaría de éxito.

### [MODIFICADO] `src/commands/commandUploadChangedFiles.ts`
- Se actualiza la llamada a la firma nueva.

### [MODIFICADO] `src/helper/error.ts`
- `isNotFoundError()`: distingue "no existe" (sftp código 2, ENOENT, 550 de FTP)
  de un fallo de permisos o de red. La distincion gobierna decisiones
  destructivas, así que se aísla y se comparte.

## Impacto

- `Upload Changed Files` replica por fin los renombrados que detecta en git.
- Un renombrado desde el explorador de VS Code se refleja en el servidor sin
  retransmitir el contenido.
