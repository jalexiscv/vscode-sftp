# Réplica de los borrados locales en el servidor

**Fecha:** 2026-08-16
**Área:** modules

## Descripción

Al borrar un archivo o una carpeta en local, se borra tambien en el servidor.
Antes esto solo era posible configurando `watcher.autoDelete` **junto con** un
glob `watcher.files`; sin ese glob no se creaba ningún watcher y la opción no
hacía nada. La nueva opción `deleteRemoteOnLocalDelete` está activa por defecto
y no depende del watcher.

Se combinan dos fuentes de eventos porque ningúna basta por sí sola:
`workspace.onDidDeleteFiles` solo ve las operaciónes hechas *a través* de VS Code
pero las entrega agrupadas y distingue un renombrado de un borrado; un
`FileSystemWatcher` lo ve todo (terminal, git, herramientas externas) pero
reporta un renombrado como dos eventos sin relación.

Como el borrado es la única operación sin deshacer a nivel de protocolo, el
comportamiento por defecto es conservador y se apoya en cuatro salvaguardas:

1. **Confirmación en lote.** Un lote mayor que `deleteRemoteConfirmThreshold`
   (10 por defecto) abre un dialogo modal con la lista.
2. **Conciencia de git.** Un checkout, rebase, merge, stash, cherry-pick, revert
   o bisect borra cientos de archivos de forma indistinguible de un borrado del
   usuario. Se detecta por los archivos marca que git mantiene en `.git`
   (`index.lock`, `MERGE_HEAD`, `rebase-merge`...) y el lote se descarta.
3. **Autosupresión.** Un `Sync Remote -> Local` con `syncOption.delete` borra
   archivos locales sobrantes; sin supresión el watcher los replicaría de vuelta
   al servidor, destruyendo justo lo que se acababa de sincronizar.
4. **Papelera remota.** Ver
   [2026-08-16_feat_papelera_remota.md](2026-08-16_feat_papelera_remota.md).

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/localDeleteMonitor.ts`
- Cola por ruta (no por identidad de `Uri`), colapso de descendientes bajo un
  ancestro ya encolado, agrupación por servicio y procesado **secuencial**
  serializado con un guard para no apilar dos dialogos modales.
- `recentlyRenamedAway`: ventana de 5 s que evita que el watcher borre en remoto
  el origen de un renombrado ya replicado.

### [NUEVO] `src/modules/syncControl.ts`
- Estado de pausa persistido y contador de supresión reentrante.
- `isGitOperationInProgress()`, que sube por el árbol buscando `.git` y resuelve
  el caso de `.git` como archivo (worktrees y submódulos).

### [MODIFICADO] `src/host.ts`
- Envoltorios sondeados en runtime de `onDidDeleteFiles`, `onDidCreateFiles` y
  `onDidRenameFiles` (existen desde la API 1.43, pero `@types/vscode` esta
  clavado en 1.40), y `showChoiceMessage` para los dialogos modales.

### [MODIFICADO] `src/extensión.ts`, `src/modules/config.ts`, `src/core/fileService.ts`, `schema/definitions.json`

### [NUEVO] `src/modules/__tests__/syncControl-test.ts`, `src/modules/__tests__/localDeleteMonitor-test.ts`

## Impacto

- Local y remoto dejan de divergir sin que el usuario tenga que borrar a mano en
  el servidor.
- Cambiar de rama en git nunca toca el servidor.
- La detección de git se memoriza por directorio dentro del lote: borrar una
  carpeta de 500 archivos hacía 500 recorridos del árbol con `statSync`.
- 36 tests cubren el estado de pausa, la supresión, la detección de git y el
  colapso de descendientes (incluido el caso de prefijo compartido: `/ab` no
  contiene a `/abc`).
