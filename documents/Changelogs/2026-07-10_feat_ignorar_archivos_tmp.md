# Exclusión permanente de archivos temporales (`.tmp`) en las transferencias

**Fecha:** 2026-07-10
**Área:** core

## Descripción

Todo archivo o carpeta cuyo nombre contenga `.tmp` (por ejemplo `informe.tmp`,
`plantilla.tmp.php`, `.tmpfile` o el contenido de `cache.tmp/`) queda excluido
de forma permanente de las transferencias, en cualquier servidor configurado y
sin necesidad de declararlo en el `ignore` del usuario. Los archivos temporales
que generan editores y procesos de build no deben llegar nunca al servidor.

Se implementa como un patrón gitignore integrado (`*.tmp*`) que se antepone a
la lista de exclusiones, junto al patrón ya existente que protege
`.vscode/sftp.json` (ver [2026-07-05_fix_sistema_ignore.md](2026-07-05_fix_sistema_ignore.md)).

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/fileService.ts`
- Nueva constante `TMP_FILES_IGNORE_PATTERN` (`*.tmp*`).
- `filesIgnoredFromConfig()` antepone siempre este patrón, antes de los
  patrones de `ignore`/`ignoreFile` del usuario.

## Impacto

- Ningún archivo con `.tmp` en el nombre vuelve a subirse al servidor, ni por
  upload directo, ni por `uploadOnSave`, ni por sync.
- La exclusión aplica en ambas direcciones (tampoco se descargan `.tmp`
  remotos), coherente con el resto del mecanismo de `ignore`.
- Nombres que no contienen `.tmp` literal (`tmp.txt`, `tmpcache.js`,
  `index.temp`) no se ven afectados. Verificado con la librería `ignore` real
  del proyecto sobre 12 casos.
