# Robustez del handler de uploadOnSave

**Fecha:** 2026-07-05
**Área:** modules

## Descripción

Tres defectos menores en `handleFileSave` (el handler de `uploadOnSave`):

1. El error de una subida fallida se registraba como `download <ruta>`,
   confundiendo el diagnóstico en el canal de salida.
2. `realpathSync.native()` se invocaba fuera del `try`: si el archivo
   desaparecía justo tras guardarse (guardar + borrar rápido, builds que
   reescriben), lanzaba ENOENT sin manejar en vez de registrarse como error.
3. Se aplicaba `await` a una función síncrona.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/modules/fileActivityMonitor.ts`
- `handleFileSave`: mensaje de error correcto (`upload`), resolución de casing dentro del `try` y eliminación del `await` espurio.

## Impacto

- Diagnóstico correcto en el log y sin excepciones no manejadas si el archivo desaparece durante el guardado.
