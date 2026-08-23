# Detección de cambios externos de extremo a extremo

**Fecha:** 2026-08-22
**Área:** modules, core, commands, ui, config

## Descripción

Fase 3 de
[02-analisis-cambios-externos-y-verificacion-carga.md](../02-analisis-cambios-externos-y-verificacion-carga.md)
(§3.2–3.6, §4 y §5). Las fases anteriores dejaron el índice de sincronización,
el plan de carga y el escáner local como piezas sueltas; esta las conecta con
el recolector de cambios, la transferencia y la barra de estado, de modo que
una edición hecha fuera del editor —o con VS Code cerrado— llegue al servidor
**a través de un plan, con verificación y con constancia**, y que un lote
grande o provocado por git pida confirmación antes de subir nada.

El flujo completo queda así:

```
guardado / watcher / escaneo / sondeo ─▶ changeCollector ─▶ UploadPlan ─▶ planConfirmation ─▶ planRunner ─▶ TransferTask (verificación)
                                                                                                              └─▶ transferEvents ─▶ syncIndexFeeder ─▶ SyncIndex
```

1. **Bus de transferencias (`transferEvents`) y alimentación del índice
   (`syncIndexFeeder`).** Los hooks `beforeTransfer`/`afterTransfer` de
   `serviceManager` emiten ahora, además del registro de actividad, un evento
   por tarea. El alimentador escribe en el índice lo *verificado*: una subida
   correcta guarda `size` (el medido por la tarea) y el `mtime` local de
   origen; una subida fallida conserva la entrada previa marcada `failed` con
   el motivo; una descarga correcta registra el archivo tal como queda en
   disco, para que el siguiente escaneo no lo tome por una edición local.
   `indexFor(service)` es la única composición de la clave del índice
   (`baseDir`, `host`, `port`, `remotePath`, perfil activo) y la comparten el
   escáner, el recolector y la vista. El monitor de borrados olvida la entrada
   (y su subárbol) tras borrar en remoto y la renombra tras un rename.
2. **Ejecutor de planes (`planRunner`).** Un `UploadPlan` se ejecuta con **un**
   scheduler por servicio (no un `uploadFile` por ítem: 400 archivos eran 400
   schedulers y, en FTP, 400 conexiones en cola). Antes de subir hace `lstat`
   de cada archivo: si desapareció queda `skipped` ("missing locally"); si
   cambió desde que se planificó, se actualiza el ítem (aún no se había
   subido). Tras el lote vuelve a comparar: un archivo reescrito *durante* su
   subida queda `stale` y se sube una vez más; si vuelve a cambiar permanece
   `stale` para una ejecución posterior. Las tareas canceladas vuelven a
   `pending`; un plan construido bajo otro perfil no se ejecuta contra el
   activo (sus ítems fallan con un mensaje claro), porque el índice anotaría
   la subida en el destino equivocado. `runPlan` resuelve siempre con el
   resumen y una segunda llamada sobre un plan en curso se une a esa ejecución.
3. **Confirmación por umbral (`planConfirmation`).** Compartida por el
   recolector y el escáner: por encima de `externalChanges.confirmThreshold`
   o si el lote es `git`, un diálogo modal lista hasta 12 rutas y ofrece
   `Upload N file(s)`, `Review plan` (el plan queda pendiente en el registro
   y se enfoca la vista de actividad) o `Skip`. Cerrar el diálogo deja el plan
   pendiente sin robar el foco.
4. **Recolector de cambios (`changeCollector`).** El handler por defecto
   construye un plan por servicio (`new` o `modified` según el índice,
   `source` `git` > `watcher` > `poll` > `scan` > `command`), lo pasa por la
   confirmación y lanza `runPlan` **sin esperarlo**, de modo que un lote largo
   no bloquea el siguiente. Además se corrigen los defectos señalados en la
   revisión del commit base:
   - las guardas baratas (esquema, servicio, `ignore`) se aplican **al
     encolar**: una ruta ignorada ya no reinicia la ventana ni cuesta un
     sondeo de git; el debounce tiene `maxWait` (2 × 700 ms), así que un
     archivo reescrito sin pausa no puede inanir al resto;
   - un **guardado desde el editor se procesa de inmediato** (vuelve la
     latencia cero de `uploadOnSave`) y el eco del watcher para esa misma ruta
     se descarta durante 1,5 s: sigue siendo una sola subida;
   - la configuración y el estado de git se muestrean una vez por servicio o
     directorio durante la ráfaga (no por evento);
   - `gitDriven` compara la **ref** de HEAD (un `git commit` no mueve la ref)
     y solo considera `index.lock` si persiste más de 1 s o coexiste con
     `MERGE_HEAD`, `rebase-merge`, `CHERRY_PICK_HEAD`…, así un `git status`
     tras cada guardado ya no marca lotes como git;
   - un cambio sobre una ruta cuya subida está en curso se **difiere** a la
     siguiente pasada en lugar de descartarse; se admite una ruta fuera de la
     carpeta del workspace si un servicio la cubre (`context` absoluto o
     `../`); un directorio en el lote se expande a sus archivos con
     `scanLocalTree` (el plan es por archivo, nada se sube dos veces).
   - Las guardas de pausa y supresión se evalúan al procesar el lote, como
     antes.
5. **Escáner de cambios externos (`externalChangeScanner`).** Recorre el árbol
   local, lo compara con el índice (`diffAgainstIndex`) y crea un plan
   `scan` (o `poll`) que pasa por la confirmación. Se dispara al activar la
   extensión (`scanOnStartup`), al recargar `sftp.json` (misma clave), al
   reanudar la sincronización automática y al recuperar el foco tras ≥ 5 min
   (`scanOnResume`), por temporizador (`watcher.pollInterval`, sin solapar
   ejecuciones, sin recalcular la config por tic) y bajo demanda. Un escaneo
   automático no se repite mientras un plan de escaneo anterior espera revisión;
   uno manual lo sustituye (sus ítems pendientes quedan `skipped`,
   "superseded by a newer scan"). Con el **índice vacío** no planifica nada
   (todo parecería nuevo): avisa una vez por sesión y servicio y ofrece
   `Build index now`.
6. **Reconstrucción del índice (`rebuildSyncIndex`).** Lista el árbol remoto
   (respetando `ignore` y sin entrar en la papelera) y el local; cada archivo
   presente en ambos con el mismo tamaño y `mtime` dentro de ±2 s (solo tamaño
   en FTP) se registra como verificado; los que difieren o faltan no se
   indexan y saldrán como `modified`/`new` en el siguiente escaneo. Con
   progreso cancelable; una cancelación deja el índice como estaba.
7. **Barra de estado.** `$(arrow-up)N` cambios pendientes de subir (cola del
   recolector + ítems `pending|uploading|stale` de los planes) y `$(error)N`
   subidas fallidas, empujados por `uploadStatus` (`ui/` no importa de
   `modules/`).
8. **Desactivación.** `deactivate` vacía la cola del recolector y espera (tope
   de 5 s) a los planes en curso antes de desechar los servicios: un guardado
   seguido de *Reload Window* se sube.

## Tipo de Cambio

- `Agregado`
- `Cambiado`
- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/core/transferTask.ts`
- Getters de solo lectura `sourceMtime` y `sourceSize` (los de `TransferOption`).

### [NUEVO] `src/modules/transferEvents.ts`
- `emitTransferStart`/`emitTransferDone`, `onDidStartTransfer`/`onDidFinishTransfer`
  (`TransferOutcome { service, task, error, profile }`), `__resetForTest`.

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- Los hooks emiten los eventos anteriores tras actualizar la actividad.

### [NUEVO] `src/modules/syncIndexFeeder.ts`
- `indexFor(service, config?)`, `init`/`destroy`, `forgetInIndex`, `renameInIndex`,
  `testHooks.handleOutcome`.

### [MODIFICADO] `src/modules/localDeleteMonitor.ts`
- Tras un borrado remoto (o `Skipped` por ausente) → `forgetInIndex`; tras un
  rename correcto → `renameInIndex`. Nunca hacen fallar la operación.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`, `src/core/fileService.ts`
- Joi, `defaultConfig` y JSON Schema de `externalChanges` y `watcher.pollInterval`.
- `ServiceOption.externalChanges`, `WatcherConfig.pollInterval`, `'externalChanges'`
  en `ignoreOptions` y en `DEEP_MERGED_KEYS`, `resolveExternalChangesConfig`,
  `resolvePollInterval`, `FileService.getWatcherConfig()`.

### [NUEVO] `src/modules/planRunner.ts`
- `runPlan(planId, { itemPaths? })`, `skipItem`, `isPlanRunning`,
  `onDidChangeRunning`, `whenIdle`, `__resetForTest`.

### [NUEVO] `src/modules/planConfirmation.ts`
- `needsConfirmation`, `buildConfirmationMessage`, `confirmAndRunPlan(plan,
  { serviceName, host?, confirmThreshold, awaitRun? })` → `{ decision, summary }`.

### [MODIFICADO] `src/modules/changeCollector.ts`
- Handler por defecto basado en planes y las correcciones descritas arriba.
  Contrato público intacto (`enqueueChange`, `setBatchHandler`, `flushNow`,
  `pendingCount`, `onDidChangePending`, `destroy`, `testHooks`);
  `PendingChange.gitHeadWhenQueued` guarda ahora la ref (`refs/heads/x` o
  `detached:<sha>`).

### [MODIFICADO] `src/modules/syncControl.ts`
- `readGitHeadRef`, `isGitRewritingWorkingTree` y `findGitDir` exportado. Las
  funciones existentes no cambian.

### [NUEVO] `src/modules/externalChangeScanner.ts`
- `runScan(service, trigger, options?)` → `ScanOutcome`, `scanService`,
  `scanAll`, `rebuildSyncIndex`, `rebuildSyncIndexInteractive`,
  `formatRebuildSummary`, `init(context)`, `destroy`, `testHooks`.

### [NUEVO] `src/commands/commandScanExternalChanges.ts`, `src/commands/commandRebuildSyncIndex.ts`
- Comandos `sftp.scanExternalChanges` y `sftp.rebuildSyncIndex` (QuickPick si
  hay varios servicios, progreso cancelable y resumen final con `Show activity`).

### [MODIFICADO] `src/commands/shared.ts`, `src/host.ts`, `src/constants.ts`, `package.json`
- `pickService(placeHolder)`; `withProgress(options, task)`; constantes de los
  comandos; entradas en `contributes.commands` y `menus.commandPalette`.

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`
- Tras recrear los servicios de un workspace por cambio de `sftp.json`, pide
  un escaneo `config` (sujeto a `scanOnStartup`).

### [MODIFICADO] `src/ui/statusBarItem.ts`
- `setPendingUploads(n)` y `setFailedUploads(n)`, integrados en `_render()`
  y en el tooltip.

### [NUEVO] `src/modules/uploadStatus.ts`
- `computeCounters`, `init`, `destroy`, `refreshNow`.

### [MODIFICADO] `src/extension.ts`
- `activate`: `syncIndexFeeder.init()` y `uploadStatus.init()` antes de
  `setup()`, `externalChangeScanner.init(context)` después.
- `deactivate`: vacía la cola y espera a los planes (5 s) antes de desechar los
  servicios; devuelve la promesa.

### [NUEVO] `test/helper/vscodeMock.ts`
- Mock de `vscode` con una clase `Uri` real (`file`/`parse`) para los tests que
  pasan por `UResource`.

### [NUEVO] Tests
- `transferEvents-test.ts`, `syncIndexFeeder-test.ts`, `planRunner-test.ts`,
  `planConfirmation-test.ts`, `externalChangeScanner-test.ts`,
  `uploadStatus-test.ts`; `changeCollector-test.ts` reescrito para la nueva
  semántica (guardados inmediatos, eco del watcher, maxWait, guardas al
  encolar, diferido por subida en curso, ref de HEAD, `index.lock`
  transitorio, expansión de directorios); `config-test.ts` ampliado.

## Impacto

- **Claves nuevas en `sftp.json`** (todas opcionales, compatibles hacia atrás):

  ```json
  {
    "externalChanges": {
      "scanOnStartup": true,
      "scanOnResume": true,
      "confirmThreshold": 20
    },
    "watcher": {
      "files": "**/*",
      "autoUpload": true,
      "autoDelete": false,
      "pollInterval": 0
    }
  }
  ```

  `externalChanges` admite merge parcial en perfiles; `pollInterval` es el
  intervalo en ms del sondeo (0 lo desactiva) y solo tiene efecto con el
  bloque `watcher` presente.
- **Comandos nuevos:** `SFTP: Scan for External Changes`
  (`sftp.scanExternalChanges`) y `SFTP: Rebuild Sync Index`
  (`sftp.rebuildSyncIndex`).
- **Primer uso:** el índice está vacío, así que los escaneos automáticos no
  planifican nada; se muestra una vez "the sync index for <name> is empty…"
  con `Build index now`. A partir de ahí, cada subida verificada y cada
  descarga alimentan el índice; un escaneo manual con índice vacío planifica
  todo como `new` y el umbral pide confirmación.
- **Comportamiento por defecto nuevo:** al activar la extensión y al
  reanudar la sincronización se escanea el árbol local (respetando `ignore`);
  lo que cambió desde su última subida verificada se sube, pidiendo
  confirmación por encima de 20 archivos o si lo provocó git.
- `uploadOnSave` vuelve a subir **sin esperar** la ventana de agrupación; los
  lotes del watcher/escaneo/sondeo se agrupan 700 ms con tope de 1,4 s. Las
  guardas de pausa y supresión se evalúan al procesar.
- Con `uploadOnSave` y *Save All* de más de `confirmThreshold` archivos, o con
  un `git checkout` bajo el watcher, aparece el diálogo de confirmación.
- Carpeta `sync-index/` bajo el almacenamiento del workspace con un JSON por
  destino, escrito por el alimentador.
- Verificación: `npx tsc --noEmit`, `npx tslint -p .` y `npm run compile`
  sin errores; `npm test` 467 pruebas en verde (8 omitidas).
