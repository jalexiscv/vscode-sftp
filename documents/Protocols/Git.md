# Protocolo de Control de Versiones (Git)

Este documento establece cómo gestionar ramas, commits y revisiones para el código del proyecto **VSCode-Sftp**. Su objetivo es un historial limpio, atómico y trazable.

## 0. Contexto del Repositorio

*   Este repositorio es un **clon del upstream** [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp). La rama por defecto del upstream es `develop`; las releases se publican desde `master`.
*   El remoto `origin` apunta al upstream, sobre el cual **no tenemos permisos de escritura**. **Nunca hacer push a `origin`.** Cuando exista el fork propio, agregarlo como remoto (p. ej. `git remote add fork <url-del-fork>`) y hacer push únicamente allí.
*   Las ramas `develop` y `master` se mantienen limpias como referencia del upstream; el trabajo del fork se hace en ramas propias.

## 1. Ramas

*   **Nunca trabajar directamente sobre `develop` ni `master`.** Una rama por cambio.
*   Nomenclatura: `tipo/descripcion-breve`, opcionalmente con el área de `src/` afectada.
    *   `fix/sftp-reconnect-timeout`
    *   `feat/remote-explorer-refresh`
    *   `docs/protocolos-proyecto`
    *   `refactor/`, `chore/`, `test/` según corresponda.

## 2. Commits

*   **Atómicos**: un commit = un cambio lógico coherente. No mezclar refactor + feature + fix.
*   **Formato del mensaje** (basado en Conventional Commits):

    ```
    tipo(área): resumen en imperativo y minúscula

    Cuerpo opcional explicando el porqué del cambio, no el qué.
    ```

    El **área** (scope) es el componente afectado: `core`, `commands`, `fileHandlers`, `modules`, `ui`, `helper`, `config`, `build`, `docs`. Si el cambio es transversal, puede omitirse.

    Ejemplo:
    ```
    fix(core): reintentar conexión sftp tras timeout de red
    ```
*   **Tipos**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `security`.
*   Mensaje en **imperativo** ("agrega", "corrige"), no en pasado.

## 3. Qué NO se commitea

*   Secretos, credenciales de servidores ni archivos `sftp.json` con datos reales de conexión (usar ejemplos con valores ficticios).
*   Dependencias ni artefactos de build: `node_modules/`, `out/`, `dist/`, `_debug/`, `*.vsix` (ya cubiertos por `.gitignore`).
*   Archivos generados/caché ni artefactos de depuración.

## 4. Revisión (Pull Requests)

*   Todo cambio no trivial entra por **PR** contra la rama de integración del fork, no push directo.
*   La descripción del PR resume el qué y el porqué, y enlaza la entrada de changelog correspondiente en `documents/Changelogs/`.
*   No hacer merge con la suite de pruebas en rojo (`npm test`) ni con el build roto (`npm run compile`).

## 5. Relación con otros protocolos

*   Cada cambio debe llevar su entrada en [Changelogs.md](Changelogs.md) (en el mismo PR/commit).
*   El código sigue [Conventions.md](Conventions.md) y la documentación [Documentations.md](Documentations.md).
