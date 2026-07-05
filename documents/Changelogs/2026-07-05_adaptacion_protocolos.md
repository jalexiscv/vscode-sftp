# Adaptación de los protocolos al proyecto VSCode-Sftp

**Fecha:** 2026-07-05
**Área:** docs

## Descripción

Los protocolos de `documents/Protocols/` provenían de otro proyecto (aplicación
PHP/Higgs con arquitectura modular `Modules/<Módulo>/`). Se reescribieron para
que sirvan a este proyecto: una extensión de Visual Studio Code escrita en
TypeScript, fork correctivo de
[Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp).

## Tipo de Cambio

- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `documents/Protocols/Changelogs.md`
- Rutas adaptadas de `Modules/<Módulo>/Changelogs/` a `documents/Changelogs/`.
- Se distingue el `CHANGELOG.md` raíz (releases del upstream) del historial de trabajo del fork.
- El campo "Módulo" de la plantilla pasa a "Área" (core, commands, fileHandlers, modules, ui, etc.).

### [MODIFICADO] `documents/Protocols/Documentations.md`
- Estructura adaptada a `documents/` como directorio principal, con índice maestro en `documents/README.md` (el `README.md` raíz y `docs/` pertenecen al upstream y quedan en inglés).
- Plantillas y ejemplos reorientados a componentes de la extensión (`src/`, comandos `sftp.*`, `sftp.json`).

### [MODIFICADO] `documents/Protocols/Git.md`
- Nueva sección de contexto: clon del upstream, rama por defecto `develop`, prohibición de push a `origin` y uso de un remoto propio para el fork.
- Scopes de commit basados en las áreas reales de `src/`; verificación con `npm test` y `npm run compile` antes de merge.

### [MODIFICADO] `documents/Protocols/Conventions.md`
- Reescritura completa de PHP/PSR-12/Higgs a TypeScript: TSLint (`tslint.json`), 2 espacios, comillas simples, trailing commas, `strictNullChecks`, async/await, logger del proyecto.
- Estructura de `src/` documentada (commands, core, fileHandlers, modules, ui, helper).
- El docblock obligatorio de modelos PHP pasa a docblock de responsabilidad para clases de `src/core/` y `src/modules/` (regla del boy scout).
- Comentarios de código en inglés (idioma del código base heredado); documentación interna en español.

### [NUEVO] `documents/README.md`
- Punto de entrada de la documentación interna con el índice de documentos y protocolos.

### [NUEVO] `documents/Changelogs/CHANGELOG.md`
- Índice inicial del historial de cambios del fork.

## Impacto

- Los protocolos ahora reflejan las herramientas y la estructura reales del proyecto y son aplicables de inmediato.
- Sin impacto en el código fuente de la extensión ni en su comportamiento.
