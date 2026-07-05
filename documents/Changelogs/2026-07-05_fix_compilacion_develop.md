# Restauración de la compilación de la rama develop

**Fecha:** 2026-07-05
**Área:** build

## Descripción

La rama `develop` heredada del upstream no compilaba (`npm run compile` fallaba
con 5 errores de TypeScript). Dos causas:

1. El merge del PR upstream #408 (upload a todos los perfiles) usa las
   constantes `COMMAND_UPLOAD_FILE_TO_ALL_PROFILES` y
   `COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES` en `createCommand.ts` sin
   importarlas.
2. `helper/paths.ts` importaba `{ URI }` de `vscode-uri`, un paquete que no es
   dependencia declarada del proyecto (resolvía a una versión antigua
   transitiva sin ese export nombrado). Además `getFileSystemPath()` estaba
   tipada para recibir `URI` pero todos sus llamadores le pasan `string`.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/commands/abstract/createCommand.ts`
- Se agregó el import de `COMMAND_UPLOAD_FILE_TO_ALL_PROFILES` y `COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES` desde `src/constants.ts`.

### [MODIFICADO] `src/helper/paths.ts`
- `getFileSystemPath()` ahora recibe `string` (lo que realmente le pasan `toRemotePath`/callers) y se eliminó el import de `vscode-uri`.
- `fs.realpathSync.native()` quedó protegido con try/catch: lanzaba excepción al mapear rutas de archivos que ya no existen en disco (p. ej. borrar un archivo remoto tras borrarlo localmente).

## Impacto

- `npm run compile` vuelve a generar `dist/extension.js` sin errores; sin esto ninguna otra corrección era verificable.
- La confirmación de "upload to all profiles" del PR #408 funciona como se pretendía.
- El borrado remoto de archivos ya eliminados localmente no aborta por `ENOENT`.
