# Protocolo de Control de Versiones (Git)

Este documento establece cómo gestionar ramas, commits y revisiones para el código del proyecto **VSCode-Sftp**. Su objetivo es un historial limpio, atómico y trazable.

## 0. Contexto del Repositorio

*   Este proyecto es un **fork** de [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), publicado en [jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp).
*   La **rama principal del fork es `main`**: contiene la versión corregida (todas las ramas de trabajo se integran allí) y es la única rama de larga vida.
*   Remotos: `fork` apunta a `jalexiscv/vscode-sftp` (aquí se hace push); `origin` apunta al upstream, **solo lectura** — sirve como referencia y para traer cambios futuros del upstream (`git fetch origin`). **Nunca hacer push a `origin`.**

## 1. Ramas

*   **Nunca trabajar directamente sobre `main`.** Una rama por cambio, que se integra a `main` con merge `--no-ff` y se **elimina** después de integrarse (local y remoto): solo `main` permanece.
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

*   Todo cambio no trivial entra por **PR** contra `main`, no push directo.
*   La descripción del PR resume el qué y el porqué, y enlaza la entrada de changelog correspondiente en `documents/Changelogs/`.
*   No hacer merge con la suite de pruebas en rojo (`npm test`) ni con el build roto (`npm run compile`).

## 5. Relación con otros protocolos

*   Cada cambio debe llevar su entrada en [Changelogs.md](Changelogs.md) (en el mismo PR/commit).
*   El código sigue [Conventions.md](Conventions.md) y la documentación [Documentations.md](Documentations.md).
