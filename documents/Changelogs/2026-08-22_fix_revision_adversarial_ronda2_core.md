# Correcciones de la revisión adversarial (ronda 2, núcleo): reintentos, descargas, `transfer()` y poda de carpetas

**Fecha:** 2026-08-22
**Área:** core, fileHandlers

## Descripción

Segunda ronda de correcciones de la revisión adversarial del plan de
[detección de cambios externos y verificación de carga](../02-analisis-cambios-externos-y-verificacion-carga.md),
limitada al núcleo de transferencia (`TransferTask`, `customError` y el
algoritmo de `src/fileHandlers/transfer/transfer.ts`). Los módulos, los
comandos y la interfaz los corrige otra rama en paralelo. Cada hallazgo lleva
su test:

- **M2 (medio) — Reintentos de errores no transitorios.** `TransferTask.run()`
  reintentaba cualquier error que no fuera una cancelación, incluidos los que
  ningún reintento arregla: permiso denegado (`EACCES`, `EPERM`, código SFTP
  `3`), origen inexistente, `EISDIR`, respuestas permanentes de FTP (`530`,
  `532`, `550`, `553`)... Con `uploadRetries: 2` eso son tres intentos y 1,5 s
  por archivo; en FTP, que transfiere de uno en uno, un plan de cien archivos
  sin permiso tardaba minutos en darse por fallido. Nueva función exportada
  `isRetryableTransferError(error, phase)` (ver la política completa más
  abajo). La **fase** (`'source'` | `'target'`) distingue el único código que
  significa lo contrario según el lado: un origen que no está (`ENOENT`, SFTP
  `2`, el `file not exist` sin código de FTP) no va a aparecer y no se
  reintenta; un destino que desaparece a medias (o que falta tras subir, que
  ya llega como `EVERIFY`) sí. La tarea deduce la fase por identidad: el
  `lstat`/`statSize` del origen, su `get` y el stream de lectura anotan el
  error que lanzan; lo que llega a `run()` sin esa marca es del destino. Cuando
  se omite el reintento queda `[transfer] not retrying <ruta>: <motivo>` en el
  canal de salida (el motivo añade `(code N)` cuando el mensaje no lleva el
  código, como el `Permission denied` de ssh2 con estado `3`).

  Política final de reintentos:

  | Decisión | Casos |
  | :--- | :--- |
  | **Nunca** | cancelación; `EACCES`, `EPERM`, SFTP `3`; `EISDIR`, `ENOTDIR`; `EROFS`, `ENOTSUP`, SFTP `8`; origen ausente (`ENOENT`, SFTP `2`, `file not exist`, FTP `550` al leer el origen); cualquier `5xx` de FTP salvo `552` |
  | **Siempre** | `EVERIFY` (bytes, tamaño, hash, destino ausente tras subir); red y timeouts (`ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ECONNREFUSED`...); SFTP `4` FAILURE y el resto de estados SFTP (`5`, `6`, `7`); `4xx` de FTP (`421`, `425`, `426`, `450`, `451`, `452`) y `552`; destino desaparecido a medias; errores sin código o desconocidos |

- **M3 (medio) — Descargas con el tamaño del listado.** En REMOTE_TO_LOCAL el
  tamaño esperado era el recogido al listar y no se volvía a medir en los
  reintentos: si el archivo remoto crecía entre el `list` y el `get` (logs,
  cachés) los tres intentos fallaban por `bytes mismatch` aunque cada descarga
  hubiera sido completa. El primer intento sigue confiando en el tamaño del
  listado (en FTP medir es un `SIZE` o un `LIST` del directorio padre); a
  partir del segundo se pide `srcFs.statSize(src)` y se compara contra esa
  medida. Si no se recogió tamaño, el primer intento también usa `statSize`
  (en SFTP es el mismo `lstat` de antes; en FTP, un `SIZE` en vez de un
  `LIST`). Las subidas ya hacían un `lstat` local fresco en cada intento y
  siguen igual.

- **M6 (medio) — Coste por archivo de `transfer()`.** La función exportada
  acepta un tercer parámetro opcional `TransferCallOptions` con
  `ensureDirExist?: boolean` (por defecto `true`), que se propaga a
  `transferWithType`. Quien ya asegura cada directorio una sola vez por
  ejecución (el ejecutor de planes, en la rama paralela) la llamará con
  `{ ensureDirExist: false }` y se ahorra un `ensureDir` (y un `chmod` con
  `dirPerm`) por archivo. Solo la firma y la propagación; el uso llega con
  la otra rama.

- **B5 (bajo) — Ciclo `customError.ts` ↔ `transferTask.ts`.** `customError.ts`
  solo necesita `TransferTask` como tipo (`TransferFailure.task`) pero lo
  importaba como valor, mientras `transferTask.ts` importa `CustomError` para
  extenderlo. Ahora es `import type` (TypeScript ≥ 3.8; `tsc`, ts-loader y el
  transpilador de jest lo borran), con un comentario que explica por qué: la
  arista desaparece en tiempo de ejecución y el orden de carga deja de
  importar.

- **B7 (tests) — Velocidad de la suite.** Los tests de reintento esperaban los
  500 ms × intento reales (memfs y los streams no toleran los fake timers) y
  las cuatro suites de transferencia sumaban 7 s. `transferTask.ts` expone el
  gancho `setRetryBaseDelayForTest(ms)` (sin argumento restaura el valor por
  defecto; `RETRY_BASE_DELAY_MS` pasa a exportarse) y las suites lo fijan en
  1 ms; el único caso que depende de la duración real —cancelar durante la
  espera— lo vuelve a poner él mismo.

- **Pendiente de la ronda 1 — Poda de directorios en `transferFolder`.**
  `transferFolder` y `_sync` llamaban a `ignore(srcFsPath)` sin la marca de
  directorio, así que un patrón `node_modules/` (lo habitual en un
  `ignoreFile`) no podaba el subárbol en la subida/descarga de carpetas ni en
  el sync: se entraba y se filtraba archivo a archivo. Ahora pasan `true`
  (siempre son directorios), la rama de borrado de `_sync` y `removeFile`
  pasan `file.type === FileType.Directory`, con lo que un patrón `dir/`
  también protege un directorio del destino de un `sync --delete`. El tipo
  `InternalTransferOption.ignore` se redeclara con la misma forma que
  `ServiceConfig.ignore` (`(fsPath, isDirectory?) => boolean`), compatible con
  todos los llamadores.

## Tipo de Cambio

- `Corregido`
- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/transferTask.ts`
- `TransferPhase`, `isRetryableTransferError(error, phase)` (exportadas),
  `PERMANENT_ERROR_CODES`, constantes de estados SFTP/FTP, `describeError()`.
- `run()`: tras descartar cancelación y presupuesto agotado consulta la
  política; si no reintenta registra `[transfer] not retrying ...` y relanza.
  El log de reintento usa el mismo `describeError`.
- `_sourceError` y `_phaseOf(error)`; `_resolveExpectedSize`, `_openSource` y
  el listener de error de `_countBytes` anotan el error del origen; se limpia
  en cada intento.
- `_measureSource()`: descargas con tamaño recogido lo usan solo en el primer
  intento y piden `statSize` en los siguientes; sin tamaño recogido,
  `statSize`; subidas, `lstat` local en cada intento.
- `RETRY_BASE_DELAY_MS` exportada, `retryBaseDelayMs` mutable y
  `setRetryBaseDelayForTest(ms?)`.
- Docblock de clase actualizado (medida del origen por intento y política de
  reintentos).

### [MODIFICADO] `src/core/customError.ts`
- `import type TransferTask from './transferTask'` con el comentario del
  porqué.

### [MODIFICADO] `src/fileHandlers/transfer/transfer.ts`
- `TransferCallOptions` exportada; `transfer(config, collect, options?)`
  propaga `ensureDirExist` (`true` salvo `options.ensureDirExist === false`).
- `InternalTransferOption.ignore` con `isDirectory?`; `transferFolder` y
  `_sync` pasan `true`; la rama de borrado de `_sync` y `removeFile` pasan la
  marca según el tipo de la entrada.

### [MODIFICADO] `src/core/__tests__/transferTask-test.ts`
- Gancho de retardo (1 ms; el test de cancelación durante la espera usa el
  real). Nuevo `describe('retry policy')`: tabla de códigos que nunca/siempre
  se reintentan, ausente en origen vs. destino, desconocidos y cancelación, y
  casos de extremo a extremo: destino que deniega (SFTP `3`, un intento, log
  `not retrying`), FTP `550` vs `426`, origen local inexistente, origen que
  falla al leerse (`EACCES` a mitad de stream), origen remoto ausente al
  descargar, destino desaparecido al abrir (se reintenta y acaba bien) y tras
  subir (`EVERIFY`, se reintenta). Descargas: origen que creció desde el
  listado (éxito al segundo intento con un solo `lstat`), sin reintentos sigue
  fallando, origen desaparecido antes de la nueva medida (no se reintenta).
  `FlakyFs` falla con `ECONNRESET` explícito.

### [MODIFICADO] `src/core/__tests__/transferTaskHash-test.ts`
- Gancho de retardo; se elimina el `jest.setTimeout(30000)`.

### [MODIFICADO] `src/fileHandlers/transfer/__tests__/transferHandle-test.ts`
- Gancho de retardo (el caso `ECONNRESET` se sigue reintentando).

### [MODIFICADO] `src/fileHandlers/transfer/__tests__/transfer-test.ts`
- `describe('ignore')`: `transfer()` de una carpeta poda `node_modules/` con
  un `ignore` que solo casa con barra final (se le ofrece como directorio, no
  se lista lo de dentro ni se crea en el destino); `sync --delete` conserva un
  directorio del destino que solo casa con barra final y borra el resto.

## Impacto

- Un error permanente (permisos, origen inexistente, 5xx de FTP...) falla al
  primer intento: un lote que el servidor rechaza entero tarda segundos en vez
  de minutos en reportarse, y el canal de salida dice por qué no se reintentó.
  Los errores de red, los timeouts y las verificaciones fallidas se reintentan
  como hasta ahora.
- Descargar un archivo que crece en el servidor (un log) ya no se da por
  fallido tres veces seguidas: el segundo intento se mide contra el tamaño
  actual. Coste: un `statSize` por reintento (SFTP: `lstat`; FTP: `SIZE`).
- `transfer()` admite `{ ensureDirExist: false }` para quien ya garantizó los
  directorios; sin el tercer parámetro se comporta igual que antes.
- Los patrones `dir/` de `ignore`/`ignoreFile` podan el subárbol al subir o
  descargar carpetas y al sincronizar, y un `sync --delete` respeta un
  directorio del destino que case con ellos.
- Las cuatro suites de transferencia pasan de ~7 s a ~2 s; la suite completa
  de ~8,2 s a ~5,4 s, con 41 tests más.
- Sin cambios en `sftp.json`, comandos, `package.json` ni documentación de
  usuario.
- Verificación: `npx tsc --noEmit`, `npx tslint -p .`, `npm test` y
  `npm run compile` en verde.
