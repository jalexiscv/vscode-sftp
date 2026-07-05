# Estrategia de Documentación del Proyecto

Este documento define las políticas y directrices para la documentación continua del proyecto **VSCode-Sftp** (fork corregido de la extensión [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)). Su propósito es guiar a desarrolladores y agentes de Inteligencia Artificial (IA) para mantener la consistencia, integridad y utilidad de la documentación técnica.

## 1. Principios Fundamentales

*   **Modularidad**: La documentación no debe ser un monolito. Debe dividirse en componentes lógicos y manejables (un archivo por tema).
*   **Veracidad**: La documentación debe reflejar fielmente el código. Si el código cambia, la documentación debe actualizarse inmediatamente.
*   **Centralización**: Toda la documentación interna del fork reside en `documents/` (incluidos estos protocolos, en `documents/Protocols/`). Los archivos de la raíz (`README.md`, `FAQ.md`, `CONTRIBUTING.md`, `CHANGELOG.md`) y la carpeta `docs/` pertenecen al **upstream** y están orientados al usuario final de la extensión; solo se modifican de forma deliberada (p. ej. al preparar una release), no como parte de la documentación de trabajo.
*   **Trazabilidad**: La documentación describe *cómo es* el sistema; el historial de *qué cambió* vive en `documents/Changelogs/` (ver [Changelogs.md](Changelogs.md)). No mezclar ambos.

## 2. Estructura de Directorios

La estructura oficial para la documentación del proyecto es la siguiente:

```
VSCode-Sftp/
├── README.md                       <-- Del upstream (usuarios de la extensión; inglés)
├── docs/                           <-- Del upstream (manual de la extensión; inglés)
├── documents/                      <-- Directorio PRINCIPAL de documentación interna
│   ├── README.md                   <-- Punto de entrada (visión general + índice)
│   ├── 01-<tema>.md                <-- Documentos numerados por tema
│   ├── 02-<tema>.md
│   ├── ...
│   ├── Protocols/
│   │   ├── Documentations.md       <-- Este archivo (Política General)
│   │   ├── Changelogs.md           <-- Protocolo del historial de cambios
│   │   ├── Conventions.md          <-- Convenciones de código
│   │   └── Git.md                  <-- Protocolo de control de versiones
│   └── Changelogs/                 <-- Historial de cambios (índice + detalle por cambio)
└── src/                            <-- Código fuente de la extensión (TypeScript)
```

> El índice maestro de la documentación interna es la tabla **"Documentación"** de `documents/README.md`. Un archivo en `documents/` no enlazado desde ese índice es un error de documentación (archivo huérfano).

## 3. Flujo de Trabajo para Documentar (Instrucciones para IA)

Al documentar una nueva funcionalidad o componente, sigue estos pasos estrictos:

### Paso 1: Identificar el Documento
Determina si la funcionalidad pertenece a un documento existente o requiere uno nuevo.
*   *Si existe*: Edita el archivo correspondiente en `documents/` (el tema que cubre esa funcionalidad).
*   *Si es nuevo*: Crea un archivo `NN-descripcion.md` en `documents/`, con el siguiente número correlativo y un nombre descriptivo en minúsculas con guiones (p. ej. `01-arquitectura.md`, `02-remote-explorer.md`).

### Paso 2: Estructura del Archivo
Cada documento debe seguir esta plantilla mínima:
1.  **Título**: Nombre del tema (p. ej. `# Sistema de Transferencia de Archivos`).
2.  **Descripción**: Breve explicación de la funcionalidad en el contexto de la extensión.
3.  **Detalle técnico**: Componentes de `src/` involucrados (commands, core, fileHandlers, modules, ui), clases, comandos de VSCode (`sftp.*`) o configuración (`sftp.json`) relacionada.
4.  **Flujos**: Procesos principales (subida, descarga, sincronización, watcher, etc.) cuando apliquen.

### Paso 3: Actualizar el Índice
**CRÍTICO**: Si creas un archivo nuevo, DEBES actualizar la tabla **"Documentación"** de `documents/README.md` para incluir el enlace. No dejar archivos huérfanos.

### Paso 4: Referencias Cruzadas
Si la documentación afecta la visión general del proyecto, actualiza también las secciones relevantes de `documents/README.md`. Enlaza a la fuente de verdad existente en vez de duplicar información (incluida la documentación del upstream en `docs/` cuando ya cubra el tema).

## 4. Convenciones de Estilo

*   **Idioma**: Español (técnico y formal) para la documentación interna en `documents/`. Los archivos heredados del upstream (`README.md`, `docs/`, etc.) permanecen en inglés.
*   **Formato**: Markdown estándar (GitHub Flavored).
*   **Código**: Usa bloques de código con resaltado de sintaxis (```ts, ```json, ```bash).
*   **Enlaces**: Usa rutas relativas (p. ej. `[Ver tema](01-tema.md)` dentro de `documents/`, o `[documents/01-tema.md](documents/01-tema.md)` desde la raíz del proyecto). Para referenciar código, enlaza el archivo fuente (p. ej. `[src/modules/remoteExplorer.ts](../src/modules/remoteExplorer.ts)`).

## 5. Mantenimiento
Antes de modificar la documentación, lee `documents/README.md` para entender el contexto actual y el índice vigente. No dupliques información; enlaza a la fuente de verdad. Mantén el historial de cambios en `documents/Changelogs/` según el [Changelogs.md](Changelogs.md).
