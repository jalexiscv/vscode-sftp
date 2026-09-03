# Exclusión de directorios solo para la subida (`uploadExclude`)

**Fecha:** 2026-09-03
**Área:** core, fileHandlers, modules, commands, config, docs

## Descripción

Nueva opción de `sftp.json`, `uploadExclude`: una lista de patrones gitignore
—pensada para directorios— que **nunca se suben al servidor**, se dispare la
subida por donde se dispare. A diferencia de `ignore`, que actúa en las dos
direcciones, una ruta excluida sigue pudiendo descargarse, listarse en el
explorador remoto, compararse y traerse con `Sync Remote -> Local`.

Cubre el caso que `ignore` no resolvía: directorios que pertenecen al servidor
(subidas de usuarios, cachés generadas, logs) y que jamás deben sobrescribirse
con la copia local, pero que sí interesa poder bajar; y archivos locales que no
deben llegar nunca al servidor (`*.env`).

```json
{
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

Alcance de la exclusión (documentado en
[03-exclusiones-de-transferencia.md](../03-exclusiones-de-transferencia.md)):

- `Upload File` / `Upload Folder` / `Upload Project` y sus variantes (activo,
  a todos los perfiles): si el objetivo mismo está excluido se avisa con una
  notificación y no se conecta; lo excluido dentro de una carpeta se poda.
- `uploadOnSave`, watcher, escaneos de cambios externos, sondeo, vista previa
  y ejecución de planes (`skipped: excluded from upload (uploadExclude)`).
- `Upload Changed Files`: los cambios excluidos se apartan y se listan en un
  grupo propio de la salida en vez de generar una notificación por archivo.
- `Sync Local -> Remote` y `Sync Both Directions`: el directorio se salta
  entero; con `syncOption.delete` la copia remota tampoco se borra.
- Espejo de borrados y renombrados (`deleteRemoteOnLocalDelete`,
  `renameRemoteOnLocalRename`, `watcher.autoDelete`): la copia remota de una
  ruta excluida se conserva.
- `Rebuild Sync Index`: poda ambos lados, como `ignore`.
- `Force Upload` omite la lista, igual que omite `ignore`.

Decisiones: se mantienen dos matchers separados (`ignore`, `uploadExclude`)
en vez de fundirlos, para que descargas y explorador remoto no cambien; los
borrados se evalúan como archivo **y** como directorio porque la ruta ya no
existe y un patrón `uploads/` solo casa como directorio (esta regla se aplica
ahora también a `ignore`, que antes solo se probaba como archivo); en perfiles
la lista se concatena base + perfil, como `ignore`.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/fileService.ts`
- Nueva opción `uploadExclude: string[]` en `ServiceOption` y matcher
  `uploadExclude` en `ServiceConfig`; tipo exportado `PathMatcher`.
- `_createIgnoreFn()` generalizado en `_createMatcher(patterns, remotePath)`,
  usado para las dos listas.
- Nuevos helpers exportados `uploadIgnoreOf(config)` (combinación
  `ignore || uploadExclude` para todo camino local → remoto) e
  `isExcludedFromMirroring(config, fsPath)` (evaluación como archivo y
  directorio para rutas ya borradas).
- `uploadExclude` añadido a `CONCATENATED_KEYS` (perfiles) y a las claves que
  no forman parte de la identidad de la conexión (`getHostInfo`).

### [MODIFICADO] `src/core/index.ts`
- Exporta `PathMatcher`, `uploadIgnoreOf`, `isExcludedFromMirroring`.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`
- Validación Joi (`string[]`, por defecto `[]`) y esquema JSON con descripción.

### [MODIFICADO] `src/modules/connectionManager/index.ts`
- `mergeForProfile()` concatena `ignore`, `tempFilePatterns` y `uploadExclude`
  como hace `fileService.mergeProfile`.

### [MODIFICADO] `src/fileHandlers/transfer/transfer.ts`
- Nueva opción de transferencia `uploadExclude`; `isUploadExcluded()` la
  consulta solo con dirección `LOCAL_TO_REMOTE` en `transferFolder`,
  `transferFile`, la entrada de `_sync` y su bucle de borrados.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- Los manejadores `upload`, `uploadFile`, `uploadFolder` y `sync2Remote`
  pasan `uploadExclude`; `uploadHandle.run` comprueba el objetivo antes de
  conectar y avisa con `showInformationMessage`.

### [MODIFICADO] `src/commands/fileCommandUploadForce.ts`
- `Force Upload` pasa `uploadExclude: null` además de `ignore: null`.

### [MODIFICADO] `src/modules/changeCollector.ts`
- Admisión (`enqueueChange`, `processPending`) y expansión de directorios en
  `planBatch` con `uploadIgnoreOf(config)`.

### [MODIFICADO] `src/modules/externalChangeScanner.ts`
- Escaneo local y recorrido remoto de `rebuildSyncIndex` podados con
  `uploadIgnoreOf(config)`.

### [MODIFICADO] `src/modules/planRunner.ts`
- Un ítem excluido se marca `skipped` con motivo
  `excluded from upload (uploadExclude)` sin pedir `ensureDir` remoto; la
  opción se pasa además a `transfer()`.

### [MODIFICADO] `src/modules/localDeleteMonitor.ts`, `src/modules/fileWatcher.ts`
- Borrados y renombrados evaluados con `isExcludedFromMirroring`; el camino
  `watcher.autoDelete` incorpora la misma comprobación (`isKeptOnRemote`).

### [MODIFICADO] `src/commands/commandUploadChangedFiles.ts`
- `isExcludedChange()` aparta los cambios excluidos (ambos extremos de un
  renombrado) y los muestra en el grupo
  `excluded by ignore / uploadExclude (not touched)`.

### [MODIFICADO] `src/commands/commandPlanPreview.ts`
- El escaneo de la vista previa usa `uploadIgnoreOf(config)`.

### [NUEVO] `src/core/__tests__/uploadExclude-test.ts`
- Matcher (anclado, `dir/`, lado remoto, raíz), concatenación en perfiles,
  `uploadIgnoreOf` e `isExcludedFromMirroring`.

### [MODIFICADO] tests existentes
- `src/modules/__tests__/config-test.ts`: valor por defecto y validación.
- `src/fileHandlers/transfer/__tests__/transfer-test.ts`: poda en subida, no
  aplicación en descarga, `sync --delete` en ambas direcciones y ambas
  direcciones a la vez.
- `src/modules/__tests__/changeCollector-test.ts`,
  `src/modules/__tests__/planRunner-test.ts`,
  `src/modules/__tests__/externalChangeScanner-test.ts`: descarte en la cola,
  ítem `skipped` con motivo, escaneo y reconstrucción podados.

### [MODIFICADO] `docs/common_configuration.md`, `docs/configuration.md`, `docs/commands.md`
- Sección `uploadExclude`, nota de direccionalidad en `ignore`, menciones en
  escaneos, borrados y `Force Upload`.

### [NUEVO] `documents/03-exclusiones-de-transferencia.md`
- Documento interno con la tabla de mecanismos, dónde se aplica cada matcher,
  flujos y decisiones de diseño. Enlazado desde `documents/README.md`.

## Impacto

- Nueva clave opcional en `sftp.json`; sin ella el comportamiento no cambia.
- Un directorio listado en `uploadExclude` no vuelve a subirse por ningún
  camino salvo `Force Upload`, y su copia remota no se borra ni se renombra por
  espejo.
- Cambio de comportamiento menor en `ignore`: un borrado local cuyo patrón
  `dir/` solo casa como directorio ya no se replica en el servidor (antes sí,
  porque la ruta borrada se probaba únicamente como archivo).
- `Upload Changed Files` lista ahora los archivos apartados por `ignore` o
  `uploadExclude`, que antes se omitían en silencio.
- Suite completa en verde tras el cambio; `npm run compile` y `tslint` sin
  errores.
