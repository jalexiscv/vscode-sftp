# Análisis de la próxima versión: cambios externos y verificación de carga

**Fecha:** 2026-08-22
**Área:** docs

## Descripción

Se documenta el análisis del requerimiento para la próxima versión de la
extensión: detectar modificaciones hechas **fuera de VS Code** (incluidas las
hechas con la ventana cerrada), generar **listados/planes de archivos a
subir** y **verificar** que cada subida fue exitosa.

El documento parte de un diagnóstico del código actual (watcher,
`uploadOnSave`, monitor de borrados, `TransferTask`, `Scheduler`,
`activityLog`), enumera defectos preexistentes que cualquier verificación
heredaría, y propone un diseño por capas: índice de sincronización
persistente, recolector único de cambios, plan/manifiesto de subida,
verificación post-subida (`stat`, opcional `hash`) y registro persistente,
con un plan de implementación en cinco fases y preguntas abiertas.

Defectos detectados al leer el código y recogidos en el documento:

- `TransferScheduler.run()` resuelve en `onIdle` aunque una tarea falle, así
  que `uploadFile()` no rechaza cuando el `put` falla y la vista de actividad
  puede marcar como éxito una subida fallida.
- Las subidas del watcher no se registran en la vista de actividad.
- `uploadOnSave` y `watcher.autoUpload` suben dos veces el mismo guardado.
- El registro de actividad no sobrevive a un reload.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `documents/02-analisis-cambios-externos-y-verificacion-carga.md`
- Análisis completo: lectura del requerimiento, diagnóstico, propuesta de
  diseño, flujos, riesgos, fases y preguntas abiertas.

### [MODIFICADO] `documents/README.md`
- Nueva fila en la tabla "Documentación" enlazando el análisis.

## Impacto

- Solo documentación; no cambia el comportamiento de la extensión.
- Sirve de base para las ramas `fix/`/`feat/` de la versión 1.24.0.
