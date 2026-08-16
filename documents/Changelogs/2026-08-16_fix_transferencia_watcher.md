# Correcciones en el pipeline de transferencia y el watcher

**Fecha:** 2026-08-16
**Área:** fileHandlers, modules, test

## Descripción

Conjunto de defectos preexistentes detectados al auditar el pipeline para
implementar la replica de borrados.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/fileHandlers/transfer/transfer.ts`
- **Pérdida de datos potencial:** los dos `list()` de `_sync` capturaban el error
  degradando a lista vacía. Un fallo de red transitorio al listar el **origen**
  hacía que pareciera vacío y, con `syncOption.delete`, marcaba **todo el
  destino** para borrar. Ahora el error se propaga.
- Los borrados se lanzaban sin `await`, fuera del `Promise.all`: un comando podía
  informar de éxito antes de que el servidor terminase.
- `deleted.push(file)` ocurria **antes** del chequeo de `ignore`, así que el
  array que devuelve `sync()` incluia archivos que nunca se borraron.
- `chmod` se invocaba sin `await` en dos sitios (rechazo no capturado). Ahora se
  espera y se degrada con aviso: en FTP es `SITE CHMOD` y muchos servidores lo
  rechazan, pero eso no debe abortar la transferencia.
- `syncOption.update` comparaba milisegundos crudos mientras el resto del archivo
  compara segundos, de modo que ruido por debajo del segundo, que el sistema de
  archivos remoto ni siquiera puede representar, retransmitia el archivo en cada
  sync.

### [MODIFICADO] `src/modules/fileWatcher.ts`
- `doDelete` no tenía la guarda de transferencias en curso que sí tenía
  `doUpload`: un `Sync Remote -> Local --delete` podía borrar en el servidor lo
  recién sincronizado.
- Las colas eran `Set<Uri>`, que deduplica por identidad de objeto y no por ruta.
- Se intentaba borrar hijos de un directorio ya borrado (ENOENT ruidoso).
- La guarda `watcherConfig.files == false` no cubría `undefined` ni `null`
  (`undefined == false` es `false` en JS), y se llegaba a construir un
  `RelativePattern` con un glob indefinido, pese a que Joi permite
  explícitamente `files: null`.
- Quedaban watchers ya dispuestos en el registro tras un `return` temprano.
- Faltaba el filtro `isInWorkspace` en la rama de borrado.

### [MODIFICADO] `src/commands/commandUploadChangedFiles.ts`
- Los `try/catch` de las tres fases envolvían llamadas asincronas **sin `await`**:
  `Promise.all` recibía un array de `undefined`, no se esperaba nada y los
  rechazos escapaban al catch. Los mensajes "Deletion failed." nunca se emitían.
- La fase de borrados pide confirmación.

### [MODIFICADO] `schema/ftp.schema.json`
- Referenciaba `definitions.json#/sftp` en lugar de `#/ftp` (en dos sitios): una
  configuración FTP recibía autocompletado de opciónes SFTP y ningúna propia.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`
- `filePerm` y `dirPerm` no se validaban y llegaban a `parseInt(x, 8)` como
  `NaN`. Se declaran en Joi y en el schema, junto a `passive`, documentada como
  ignorada desde la migración a `basic-ftp`.

### [MODIFICADO] `test/core/scheduler.spec.js`
- El test `.add() - concurrency: 1` aseveraba una ventana temporal de 50 ms y
  **fallaba**, dejando `npm test` en rojo y rompiendo el job de CI. Al fallar
  dentro del callback de `onIdle`, `done()` nunca se llamaba y encadenaba un
  timeout de 5 s. Se reescribe alrededor de la propiedad que pretendía
  verificar: con concurrencia 1 las tareas se serializan.

## Impacto

- `npm test` vuelve a estar en verde, y con él el CI.
- Desaparece el peor escenario de pérdida de datos del sync.
