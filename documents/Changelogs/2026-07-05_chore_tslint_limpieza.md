# Limpieza de violaciones tslint preexistentes

**Fecha:** 2026-07-05
**Área:** build

## Descripción

El código heredado del upstream acumulaba ~50 violaciones de su propio
`tslint.json` (espacios finales, comillas dobles, puntos y comas, trailing
commas, `==`, `throw` de strings, bloques vacíos), la mayoría introducidas
por el merge upstream #408. Con el linter en rojo, la convención de "el
código nuevo no introduce violaciones" no era verificable.

Cambios mecánicos (mayoritariamente `tslint --fix`), sin lógica nueva. Los
dos con matiz:

- `throw ''` → `throw new Error('')` en los centinelas de
  `createFileHandler`/`explorer`: comportamiento equivalente (el mensaje
  vacío sigue llegando igual a `showErrorMessage`) y ahora queda stack en el
  log.
- Los `catch`/arrow vacíos llevan comentario explicando la intención.

## Tipo de Cambio

- `Cambiado`

## Archivos Afectados

### [MODIFICADO] 17 archivos de `src/` (ver commit)
- Correcciones mecánicas de estilo conforme a `tslint.json`; `npx tslint -p .` queda sin errores.

## Impacto

- Linter en verde: las violaciones nuevas ya no quedan enmascaradas.
- Sin cambios funcionales.
