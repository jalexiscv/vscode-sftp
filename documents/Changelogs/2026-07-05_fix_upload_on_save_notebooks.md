# uploadOnSave no se disparaba al guardar notebooks (.ipynb)

**Fecha:** 2026-07-05
**Área:** modules

## Descripción

Issue upstream "Save changes in `ipynb` are not recognized": los notebooks
se guardan a través del API de notebooks de VSCode, que no emite
`onDidSaveTextDocument`, así que `uploadOnSave` (y la invalidación del cache
del fs) nunca se activaban para archivos `.ipynb`.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/host.ts`
- Nuevo wrapper `onDidSaveNotebookDocument()`: usa el API de notebooks (VSCode >= 1.67) con detección en runtime; en hosts anteriores (el engine permite 1.64) devuelve un disposable no-op.

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`
- El handler de guardado se extrajo a `handleSavedUri()` y se registra en ambos eventos (documentos de texto y notebooks); el watcher de notebooks se libera junto a los demás.

## Impacto

- Guardar un `.ipynb` (u otro tipo de notebook) dispara `uploadOnSave` igual que cualquier archivo de texto.
- En versiones de VSCode sin el API de notebooks el comportamiento queda exactamente como antes.
