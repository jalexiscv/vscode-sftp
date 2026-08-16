# Papelera remota con restauración

**Fecha:** 2026-08-16
**Área:** modules

## Descripción

Antes de esta versión el borrado remoto era inmediato e irreversible: un `unlink`
o un `rmdir` recursivo, sin copia de seguridad de ningúna clase. Eso es difícil
de defender cuando los borrados pasan a replicarse de forma automática
([2026-08-16_feat_borrado_espejo_remoto.md](2026-08-16_feat_borrado_espejo_remoto.md)).

Con `remoteTrash.enabled` (por defecto), borrar es un `rename` del lado del
servidor hacia `<papelera>/<marca-de-tiempo>/<ruta relativa original>`. Al ser
un rename no cuesta ancho de banda, a diferencia de una copia de seguridad por
descarga. Se conserva la ruta relativa a `remotePath` para que la restauración
sea inequívoca aunque dos archivos borrados compartan nombre base.

El índice se guarda en `workspaceState` y no en el servidor: tiene que
sobrevivir a una conexion caída, y escribirlo en remoto costaría un viaje de ida
y vuelta por cada borrado.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/remoteTrash.ts`
- `moveToTrash()`, `restoreFromTrash()`, `purgeExpired()`, `emptyTrash()`.
- `getLastTrashEntries()` devuelve el lote completo: borrar una carpeta produce
  una entrada por archivo, y restaurar solo una dejaría el árbol a medias.
- Guarda contra rutas que resuelvan fuera de `remotePath`, que harían que
  `upath.join` saliera de la papelera y renombrara en un lugar arbitrario.

### [NUEVO] `src/commands/commandRestoreLastDeletion.ts`, `commandRestoreFromTrash.ts`, `commandEmptyTrash.ts`

### [MODIFICADO] `src/core/fileService.ts`
- `trashIgnorePatterns()` excluye la papelera de todos los recorridos: sin esto
  un `Sync Remote -> Local` descargaría todo lo borrado y un
  `Sync Local -> Remote --delete` vacíaría la papelera.
- `resolveRemoteTrashConfig()` rellena los valores que el usuario omita, porque
  `mergedDefault` es un spread superficial y un
  `{"remoteTrash": {"enabled": false}}` dejaría `path` sin definir, resolviendo
  a la raiz remota.

## Impacto

- Un borrado equivocado se revierte con `SFTP: Undo Last Remote Deletion`.
- La restauración se niega a sobrescribir: si la ruta original está ocupada,
  informa del conflicto en vez de reemplazar lo que hay.
- Lo caducado se purga en segundo plano al activar la extensión, sin bloquear el
  arranque ni molestar si el servidor no responde.
