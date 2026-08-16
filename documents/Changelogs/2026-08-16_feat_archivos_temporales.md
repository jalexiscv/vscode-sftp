# Exclusión integral de archivos temporales locales

**Fecha:** 2026-08-16
**Área:** core

## Descripción

Amplía la exclusión que introdujo
[2026-07-10_feat_ignorar_archivos_tmp.md](2026-07-10_feat_ignorar_archivos_tmp.md),
que solo cubría el patrón `*.tmp*`. Ese patrón dejaba pasar la mayor parte de la
basura que un proyecto real genera: los archivos de intercambio de vim y emacs,
los bloqueos de Office y LibreOffice, los restos de un merge (`*.orig`, `*.rej`),
las descargas a medias del navegador y los metadatos de macOS y Windows.

Caso especialmente relevante: el propio archivo de staging de la extensión.
`TransferTask._transferFile` sube a `<destino>.new` cuando `useTempFile` está
activo, y una transferencia interrumpida deja ese `.new` huérfano en local, que
un sync posterior volvía a subir.

La lista es configurable: `ignoreTempFiles: false` la desactiva por completo y
`tempFilePatterns` laампlía. Como los patrónes añadidos se concatenan *después*
de los integrados, una negación gitignore (`"!*.bak"`) permite recuperar uno de
los patrónes por defecto.

Se dejaron fuera deliberadamente los archivos de bloqueo de dependencias
(`composer.lock`, `yarn.lock`, `Gemfile.lock`): casan con `*.lock` pero son
artefactos versiónados que deben desplegarse.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/core/tempFiles.ts`
- `DEFAULT_TEMP_FILE_PATTERNS`: la lista integrada, agrupada por origen y
  comentada.
- `resolveTempFilePatterns(config)`: resuelve la lista efectiva a partir de
  `ignoreTempFiles` y `tempFilePatterns`.

### [MODIFICADO] `src/core/fileService.ts`
- `filesIgnoredFromConfig()` sustituye la constante `TMP_FILES_IGNORE_PATTERN`
  por la llamada a `resolveTempFilePatterns()`.
- Nuevas opciónes en `ServiceOption`: `ignoreTempFiles`, `tempFilePatterns`.
- `mergeProfile()` concatena `tempFilePatterns` entre base y perfil, igual que
  ya hacía con `ignore`.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`
- Validación Joi y JSON Schema de las dos opciónes nuevas.

### [NUEVO] `src/core/__tests__/tempFiles-test.ts`, `src/core/__tests__/ignoreTempFiles-test.ts`

## Impacto

- Ningún archivo temporal llega al servidor por upload directo, `uploadOnSave`,
  watcher o sync, en ningúna configuración.
- **Bug detectado y corregido por los tests:** el patrón de emacs `#*#` nunca se
  aplicaba. En sintaxis gitignore un `#` inicial abre un comentario, así que la
  línea se descartaba en silencio; se escribe escapado.
- 57 tests cubren la lista y la función de ignore resultante extremo a extremo,
  incluyendo los casos que **no** deben excluirse.
