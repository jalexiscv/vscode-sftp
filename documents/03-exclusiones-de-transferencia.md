# Exclusiones de transferencia: `ignore`, temporales y `uploadExclude`

## Descripción

La extensión dispone de tres mecanismos para dejar rutas fuera de las
transferencias. Los tres se expresan con patrones **gitignore** (paquete
`ignore`), relativos al `context` de la configuración, y los tres se resuelven
en `FileService` a una función *matcher* que entiende tanto rutas locales
(bajo el `baseDir`) como remotas (bajo `remotePath`). Se diferencian en **qué
dirección** afectan y en **quién los define**:

| Mecanismo | Lo define | Dirección | Uso típico |
|-----------|-----------|-----------|------------|
| `ignore` / `ignoreFile` | el usuario | ambas: ni sube ni baja | `.git`, `node_modules`, `*.log` |
| Exclusiones integradas (`.vscode/sftp.json`, papelera remota, `ignoreTempFiles` + `tempFilePatterns`) | la extensión, ampliables por el usuario | ambas | credenciales, archivos de intercambio de editores |
| `uploadExclude` | el usuario | **solo local → remoto** | `storage/`, `public/uploads/`, `*.env`: lo que pertenece al servidor o no debe llegar nunca a él |

`uploadExclude` (desde 2026-09-03) cubre el hueco que `ignore` no podía: un
directorio que el servidor genera o recibe de sus usuarios (subidas, cachés,
logs) no debe sobrescribirse jamás con la copia local, pero sí tiene que poder
descargarse, listarse y compararse.

## Detalle técnico

### Resolución de los patrones — [src/core/fileService.ts](../src/core/fileService.ts)

- `filesIgnoredFromConfig()` construye la lista efectiva de `ignore`:
  `/.vscode/sftp.json` + papelera remota + temporales + `ignore` + `ignoreFile`.
- `_createMatcher(patterns, remotePath)` convierte cualquier lista en un
  `PathMatcher` `(fsPath, isDirectory?) => boolean`. Decide si la ruta es local
  o remota por prefijo, la relativiza con separadores `/` y consulta el matcher
  gitignore; con `isDirectory` prueba además la forma `ruta/`, que es la única
  que casa con patrones tipo `uploads/`.
- `ServiceConfig` expone los dos matchers: `ignore` y `uploadExclude` (ambos
  `null` cuando la lista está vacía).
- `uploadIgnoreOf(config)` devuelve la combinación (`ignore || uploadExclude`)
  que consulta **todo camino local → remoto**; `isExcludedFromMirroring(config,
  fsPath)` la evalúa como archivo y como directorio a la vez, para rutas que ya
  no existen en disco (borrados, origen de un renombrado).
- En perfiles, `uploadExclude` se **concatena** base + perfil, como `ignore` y
  `tempFilePatterns` (`CONCATENATED_KEYS`).

### Validación y esquema

- [src/modules/config.ts](../src/modules/config.ts): `uploadExclude` es
  `string[]`, por defecto `[]`.
- [schema/definitions.json](../schema/definitions.json): autocompletado y
  descripción en `sftp.json`.

### Dónde se aplica cada matcher

| Camino | `ignore` | `uploadExclude` | Componente |
|--------|:-------:|:---------------:|------------|
| Upload File / Folder / Project, Upload Active …, … To All Profiles | ✔ (salvo `Upload File`, que lo omite) | ✔, con aviso si el objetivo mismo está excluido | [src/fileHandlers/transfer/index.ts](../src/fileHandlers/transfer/index.ts) |
| Recorrido de carpetas y archivos al subir | ✔ | ✔ solo con dirección `LOCAL_TO_REMOTE` | [src/fileHandlers/transfer/transfer.ts](../src/fileHandlers/transfer/transfer.ts) |
| `Sync Local -> Remote` (incluido `syncOption.delete`) y `Sync Both Directions` | ✔ | ✔: el directorio se salta entero, borrados incluidos | `transfer.ts` (`_sync`) |
| `Force Upload` | ✘ | ✘ | [src/commands/fileCommandUploadForce.ts](../src/commands/fileCommandUploadForce.ts) |
| `uploadOnSave`, watcher, escaneos, sondeo (colector de cambios) | ✔ | ✔ (antes de entrar en la cola) | [src/modules/changeCollector.ts](../src/modules/changeCollector.ts) |
| Escaneo de cambios externos y `Rebuild Sync Index` | ✔ | ✔ (poda local y remota) | [src/modules/externalChangeScanner.ts](../src/modules/externalChangeScanner.ts) |
| Ejecución de planes | ✔ (`skipped: ignored by config`) | ✔ (`skipped: excluded from upload (uploadExclude)`) | [src/modules/planRunner.ts](../src/modules/planRunner.ts) |
| Vista previa de plan | ✔ | ✔ | [src/commands/commandPlanPreview.ts](../src/commands/commandPlanPreview.ts) |
| `Upload Changed Files` (git) | ✔ | ✔ (grupo `excluded` en la salida) | [src/commands/commandUploadChangedFiles.ts](../src/commands/commandUploadChangedFiles.ts) |
| Espejo de borrados y renombrados (`deleteRemoteOnLocalDelete`, `renameRemoteOnLocalRename`, `watcher.autoDelete`) | ✔ | ✔ (la copia remota se conserva) | [src/modules/localDeleteMonitor.ts](../src/modules/localDeleteMonitor.ts), [src/modules/fileWatcher.ts](../src/modules/fileWatcher.ts) |
| Download File / Folder / Project, `Sync Remote -> Local`, `downloadOnOpen` | ✔ | ✘ | `transfer/index.ts` |
| Explorador remoto, listados, diff | ✔ | ✘ | `remoteExplorer`, `commands/shared.ts` |

## Flujos

1. **Guardado en el editor de `storage/app.log`** con `uploadExclude:
   ["/storage"]`: `enqueueChange` consulta `uploadIgnoreOf(config)` y descarta
   la ruta antes de encolarla; no reinicia la ventana de agrupación ni genera
   plan.
2. **`Upload Folder` sobre `storage/`**: `uploadHandle.run` hace `lstat` del
   objetivo, comprueba `uploadExclude(ruta, true)`, registra la omisión y
   muestra una notificación ("… is excluded from upload (uploadExclude). Use
   *Force Upload* to send it anyway") sin llegar a conectar.
3. **`Upload Project`**: `transferFolder` poda `storage/` al recorrer el árbol
   (una línea de log por directorio excluido) y `transferFile` descarta los
   archivos sueltos que casen (p. ej. `.env`).
4. **`Sync Local -> Remote` con `delete`**: `_sync` sale al entrar en un
   directorio excluido y el bucle de borrados descarta las rutas remotas que
   casen, de modo que `storage/` del servidor ni se sobrescribe ni se vacía.
5. **Borrado local de `public/uploads/foto.jpg`**: `localDeleteMonitor` llama a
   `isExcludedFromMirroring` y no toca el servidor.
6. **`Download Folder` de `storage/`**: `uploadExclude` no interviene; solo
   `ignore` puede filtrar.

## Decisiones de diseño

- **Dos matchers en vez de fundir `uploadExclude` en `ignore`**: los
  manejadores de descarga y el explorador remoto reciben `config.ignore` sin
  cambios; solo los caminos de subida consultan la combinación. Así ninguna
  descarga cambia de comportamiento.
- **`Upload File` respeta `uploadExclude` aunque omita `ignore`**: la lista
  existe para proteger el servidor de la copia local, así que solo `Force
  Upload` (cuyo cometido es ignorar reglas) la salta.
- **Borrados evaluados como archivo y como directorio**: la ruta ya no existe
  y un patrón `uploads/` solo casa como directorio. Equivocarse hacia el lado
  conservador cuesta repetir a mano un borrado; hacia el otro, borrar en el
  servidor un directorio que la configuración pedía conservar. Esta regla se
  aplica también a `ignore`, que antes solo se probaba como archivo.
- **`Sync Both Directions` salta el directorio entero**: es la única forma de
  garantizar que ni sube ni borra nada allí; para traer su contenido está
  `Sync Remote -> Local` o `Download Folder`.
