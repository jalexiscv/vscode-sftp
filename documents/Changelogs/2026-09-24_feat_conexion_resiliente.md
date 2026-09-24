# Conexión resiliente: espera ante caídas, planes en espera, menos conexiones FTP y menos falsos cambios

**Fecha:** 2026-09-24
**Área:** core, modules

## Descripción

El usuario reportó tres síntomas sobre una conexión inestable: al fallar la
conectividad (`ECONNRESET` y similares) se producía "un reintento masivo de
envíos sin haber conexión" que fallaba de forma descontrolada; la extensión
detectaba cambios en archivos que nadie había editado; y parecía abrir
demasiadas conexiones FTP simultáneas.

El análisis del código confirmó las tres causas:

1. **Nada distinguía "se cayó la conexión" de "falló este archivo".** La
   clasificación de `transferTask.ts` trataba todo error de red como
   reintentable; cada tarea de la cola hacía sus 3 intentos (500 ms y 1000 ms
   de espera) contra el mismo `FileSystem` remoto, que ya estaba cerrado (la
   reconexión solo ocurre en el siguiente `getFs()`); el scheduler seguía con
   la tarea siguiente; `serviceManager.afterTransfer` abría un
   `showErrorMessage` por archivo; el alimentador del índice escribía
   `status: 'failed'` en cada entrada, y `diffAgainstIndex` trata `failed`
   como `modified`, con lo que el siguiente escaneo automático (arranque,
   foco tras cinco minutos) volvía a planificar los mismos archivos: ese es
   el origen de los "cambios" en archivos no editados tras una caída.
2. **Reconexión inmediata y sin espera.** Tras un fallo de conexión, cada
   guardado (un plan por guardado), cada plan y cada entrada de "Retry all
   failed" abría un intento de conexión nuevo. Contra un servidor FTP que
   conserva las sesiones muertas hasta su propio timeout, esa ráfaga es lo
   que produce `421 Too many connections`, y el 421 se reintentaba a su vez
   como error transitorio.
3. **Conexiones FTP permanentes.** Una conexión por perfil, por entrada de
   `sftp.json` y por ventana, mantenida viva con `NOOP` cada 10 s durante
   toda la sesión, sin cierre por inactividad; al cambiar de perfil la del
   anterior quedaba abierta; y la caída en mitad de una operación tardaba
   hasta 10 s en detectarse (solo la veía el temporizador del keepalive).
   Además, `.git/` no se ignoraba por defecto: con un `watcher.files`
   amplio, cada `git status` o auto-fetch de VS Code reescribe `.git/index`
   y `FETCH_HEAD`, y el recolector planificaba cualquier evento sin comparar
   con el índice.

Este cambio introduce una clasificación única de pérdida de conexión, una
puerta de reconexión con espera creciente por identidad de conexión, planes
que quedan en espera y se reanudan solos, un cliente FTP que se invalida al
instante y se cierra por inactividad, y dos filtros contra falsos positivos.

## Tipo de Cambio

- `Agregado`
- `Cambiado`
- `Corregido`

## Archivos Afectados

### [NUEVO] `src/core/connectionHealth.ts`
- `isConnectionLostError(error)`: códigos errno de red (`ECONNRESET`,
  `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`,
  `EAI_AGAIN`, `EHOSTUNREACH`, `EHOSTDOWN`, `ENETUNREACH`, `ENETDOWN`,
  `ENETRESET`), FTP `421`, SFTP `6`/`7`, el código propio `ECONNHOLD` y los
  mensajes de ssh2 y basic-ftp ("Not connected", "Client is closed",
  "Channel closed", "socket hang up", "Timed out while waiting"…). Una
  respuesta de protocolo numérica se juzga solo por su número: un `426`
  (aborto de la conexión de datos) sigue siendo transitorio y se reintenta.
- `markConnectionLost(error)`: marca no enumerable `connectionLost`.
- `ConnectionOnHoldError` (`code: 'ECONNHOLD'`, `retryAfterMs`, `cause`).
- `ConnectionGate`: intentos fallidos consecutivos, espera
  `1 s × 2^(n-1)` con techo de 60 s y mínimo de 60 s tras un `421`;
  `assertMayAttempt()` lanza el error de espera; `recordFailure` ignora
  errores de autenticación y cancelaciones; `recordSuccess` limpia y emite
  `recovered` solo tras un fallo o una caída; `recordDrop` no inicia espera
  (una reconexión inmediata es barata). Reloj inyectable para tests.
- Registro por identidad (`getConnectionGate`), `onConnectionRecovered`,
  `onConnectionAttemptFailed`, `__resetConnectionGatesForTest`.

### [MODIFICADO] `src/core/remoteFs.ts`
- `KeepAliveRemoteFs` recibe su `ConnectionGate`; `getFs()` llama a
  `assertMayAttempt()` antes de construir un cliente; éxito → `recordSuccess`,
  fallo → `recordFailure`.
- El callback de desconexión va ligado al cliente que lo emite:
  `invalid(reason, fs)` ignora eventos de un cliente ya reemplazado (ssh2
  emite `error` y luego `close`; el `close` tardío tumbaba la conexión nueva)
  y eventos repetidos; registra `[connection] host: connection lost (reason)`
  y `recordDrop`; el motivo `idle` se registra como info y no cuenta como caída.
- `end()` tolera un cliente nunca construido (primer intento retenido).
- Nuevas exportaciones `connectionGateOf(option)` e `isSameRemote(a, b)`.

### [MODIFICADO] `src/core/remote-client/sshClient.ts`
- El error de conexión envuelto (`[host]: mensaje`) conserva `err.code` y
  `err.level`; antes se perdía el código y no podía clasificarse.

### [MODIFICADO] `src/core/remote-client/ftpClient.ts`
- `run()` pasa por `_enqueue(task, activity)`: si un comando falla y el
  cliente está cerrado o el error es de conexión, emite `disconnected` al
  instante (antes solo lo detectaba el keepalive, hasta 10 s después).
- Cierre por inactividad: `FTP_IDLE_TIMEOUT = 5 min`; el tick del keepalive
  cierra la conexión y emite `disconnected('idle')` cuando no hay trabajo y
  no ha habido comandos desde hace más del límite. El `NOOP` no cuenta como
  actividad. `setIdleTimeoutForTest`.

### [MODIFICADO] `src/core/transferTask.ts`
- En el bucle de `run()`, un error de conexión no se reintenta dentro de la
  tarea (se relanza marcado con `markConnectionLost`, con `warn`
  `[transfer] connection lost while …`).

### [MODIFICADO] `src/core/fileService.ts`
- `TransferResult.connectionLost?: Error`: al primer fallo de conexión el
  scheduler vacía la cola (`scheduler.empty()`); las tareas en vuelo terminan
  y se listan como siempre.
- `getConnectionGate(config)` y `closeRemoteConnectionOfProfile(previous)`
  (no cierra si el perfil activo resuelve a la misma conexión).
- `VCS_METADATA_IGNORE_PATTERNS = ['.git', '.svn', '.hg']` añadidos siempre
  a la lista de ignorados, negables con `"!.git"`.

### [MODIFICADO] `src/modules/planRunner.ts`
- `runGroup` devuelve `GroupResult { verified, connectionLost?, gate?, host? }`;
  un fallo de conexión al obtener el `FileSystem`, durante la recolección
  (`ensureDir`) o en una tarea deja los ítems en `pending` con
  `error: 'on hold: <motivo>'` (`holdAll`); los ítems encolados que no
  llegaron a ejecutarse vuelven a `pending` con el mismo motivo.
- `execute` registra el plan en `held` (`holdPlan`): aviso único por servicio
  y caída (`outageNotified`), reanudación por `onConnectionRecovered` (solo
  los planes de esa puerta) o por temporizador a `max(5 s, gate.retryAfter())`,
  hasta `MAX_AUTOMATIC_RESUMES = 10`; después queda pendiente hasta una
  reanudación por recuperación o manual. `releaseHold` al terminar sin caída.
- `differs()` usa la regla común de `isUnchangedAgainstIndex` (segundos) en
  lugar de milisegundos exactos.
- Exportados `getHeldPlanIds()`, `resumeHeldPlans(planIds?)`,
  `MAX_AUTOMATIC_RESUMES`; `__resetForTest` limpia temporizadores y suscripción.

### [MODIFICADO] `src/modules/uploadPlan.ts`
- `mtimeInSeconds` exportado; nueva `isUnchangedAgainstIndex(entry, size,
  mtime)` (verificada o saltada, mismo tamaño, mismo mtime al segundo;
  `failed` nunca es "sin cambios"), usada por `diffAgainstIndex`.

### [MODIFICADO] `src/modules/changeCollector.ts`
- `planBatch` descarta los archivos cuyo tamaño y mtime coinciden con la
  entrada verificada del índice (`unchanged`, contados en `debug`); un lote
  solo de archivos sin cambios no crea plan.

### [MODIFICADO] `src/modules/syncIndexFeeder.ts`
- `recordUpload` no escribe `failed` cuando el error es de conexión: la
  entrada queda como estaba (el plan retiene el archivo).

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- `afterTransfer`: un error de conexión no abre diálogo; `warn` en el canal,
  mensaje breve en la barra de estado y entrada `Failed` en la actividad.

### [MODIFICADO] `src/fileHandlers/transfer/index.ts`
- `assertTransferSucceeded`: si `result.connectionLost`, el agregado no se
  marca como ya reportado (nadie lo mostró por archivo) y su mensaje pasa a
  `Connection lost while trying to <acción> (<motivo>): N done, M
  interrupted; the remaining files were not attempted…`.

### [MODIFICADO] `src/extension.ts`
- El observador del perfil cierra la conexión del perfil anterior en cada
  servicio (`closeRemoteConnectionOfProfile`).

### [NUEVO] `src/core/__tests__/connectionHealth-test.ts`, `ftpClient-test.ts`, `remoteFs-test.ts`
### [MODIFICADO] tests de `transferTask`, `transferScheduler`, `transferHandle`, `planRunner`, `syncIndexFeeder`, `changeCollector`, `ignoreDirectories`
- Suite 786 → 859 tests. El "error transitorio" de los tests de reintento
  pasa de `ECONNRESET` a SFTP `4 Failure`; se añaden casos de conexión
  perdida (sin reintento en la tarea, `426` sí reintentado, cola vaciada,
  ítems en espera, reanudación, aviso único, índice intacto, `.git`
  ignorado y negable, eventos sobre archivos sin cambios).

### [MODIFICADO] `docs/common_configuration.md`, `docs/configuration.md`, `docs/ftp_configuration.md`, `FAQ.md`
- Sección nueva "Connection loss and reconnection", párrafo "Lost connection"
  en el flujo, notas en `uploadRetries` e `ignore`, "Idle connections" en la
  doc de FTP y dos entradas de FAQ (`on hold`, `421`).

## Impacto

- Al caerse la conexión: un aviso por servidor, los archivos quedan
  `pending` ("on hold") en el plan, nada se marca fallido en el índice, no
  hay reintentos por archivo ni reconexiones en ráfaga; los planes se
  reanudan solos al volver la conexión (o cada 5 s… 60 s, hasta 10 veces).
- Menos conexiones FTP: cierre tras 5 minutos de inactividad, cierre de la
  del perfil anterior al cambiar, espera de un minuto tras un `421`.
- Menos falsos cambios: `.git`/`.svn`/`.hg` ignorados por defecto (negables
  con `!.git`), y un evento sobre un archivo idéntico al verificado no sube.
- Cambio de comportamiento a tener en cuenta: un `ECONNRESET` en una tarea
  ya no se reintenta con `uploadRetries` dentro de la tarea; la reanudación
  la hace el plan (o el comando debe repetirse). Un `426` FTP sigue
  reintentándose.
- Sin claves nuevas en `sftp.json`; el tiempo de inactividad FTP es una
  constante (5 min).
