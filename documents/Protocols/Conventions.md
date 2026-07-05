# Convenciones de Código

Este documento establece las convenciones de estilo y estructura para el código fuente del proyecto **VSCode-Sftp**, una extensión de Visual Studio Code escrita en **TypeScript**. Su objetivo es que el código sea uniforme y predecible, independientemente de quién (o qué agente de IA) lo escriba.

> **Principio rector:** este proyecto es un fork correctivo de un código base existente. Al modificar un archivo, el código nuevo debe **leerse como el código que lo rodea**. Ante cualquier duda entre este documento y el estilo consistente del archivo que se está tocando, gana el estilo del archivo.

## 1. Estándar Base

*   **TypeScript** (~3.9) compilado con webpack a CommonJS, target ES6 (ver [tsconfig.json](../../tsconfig.json)).
*   El linter del proyecto es **TSLint** con la configuración de [tslint.json](../../tslint.json) (`tslint:recommended` con ajustes). El código nuevo no debe introducir violaciones.
*   Indentación con **2 espacios** (nunca tabs). Codificación **UTF-8 sin BOM**.
*   **Comillas simples** para strings; **punto y coma** obligatorio; comparaciones con **`===`/`!==`**.
*   **Trailing comma** en objetos y arrays multilínea; nunca en llamadas a funciones.
*   Arrow functions de un solo argumento **sin paréntesis** (`config => ...`, no `(config) => ...`).
*   No usar el modificador `public` explícito en miembros de clase (es el valor por defecto).

## 2. Nomenclatura

| Elemento                  | Convención        | Ejemplo                          |
|---------------------------|-------------------|----------------------------------|
| Clases / Interfaces       | `PascalCase`      | `RemoteExplorer`, `FileService`  |
| Métodos / funciones       | `camelCase`       | `createFileService()`            |
| Variables / propiedades   | `camelCase`       | `workspaceFolders`               |
| Constantes                | `UPPER_SNAKE`     | `EXTENSION_NAME`                 |
| Archivos fuente           | `camelCase.ts`    | `fileActivityMonitor.ts`         |
| Comandos de la extensión  | `sftp.camelCase`  | `sftp.setProfile`                |
| Claves de configuración   | `sftp.camelCase`  | `sftp.printDebugLog`             |

## 3. Estructura del Proyecto

*   **Código fuente** en `src/`:
    *   `src/extension.ts` — punto de entrada (activación/desactivación de la extensión).
    *   `src/commands/` — comandos expuestos por la extensión (`sftp.*`).
    *   `src/core/` — núcleo: conexiones, transferencia, filesystem remoto.
    *   `src/fileHandlers/` — operaciones sobre archivos (upload, download, sync, diff...).
    *   `src/modules/` — módulos de alto nivel (config, serviceManager, remoteExplorer, fileActivityMonitor...).
    *   `src/ui/` — componentes de interfaz (status bar, quick pick, árboles...).
    *   `src/helper/`, `src/utils.ts`, `src/logger.ts`, `src/constants.ts` — utilidades transversales.
*   **Pruebas** en `test/`, ejecutadas con **Jest** (`npm test`).
*   **Esquema de configuración** de `sftp.json` en `schema/`.
*   Todo comando nuevo debe registrarse además en la sección `contributes` de [package.json](../../package.json).

## 4. Estilo de Código

*   **Tipado**: declara tipos de parámetros y retorno siempre que sea posible; `strictNullChecks` está activo, maneja explícitamente `null`/`undefined`.
*   **Early return** sobre anidación profunda de `if`.
*   Operaciones asíncronas con **`async/await`**; no mezclar con cadenas de `.then()` en código nuevo.
*   Los errores se reportan con los mecanismos existentes (`reportError`, `logger`), no se silencian con `catch` vacíos.
*   No dejar código muerto ni `console.log` de depuración: usar el **logger** del proyecto (`src/logger.ts`), que escribe en el canal de salida de la extensión.
*   Evita lógica de negocio en `src/ui/` y en los comandos; mantén los comandos delgados y la lógica en `core/`/`modules/`/`fileHandlers/`.

## 5. Comentarios y Documentación

*   **Idioma de los comentarios en el código**: **inglés**, siguiendo el idioma predominante del código base heredado del upstream. La documentación interna en `documents/` se escribe en español (ver [Documentations.md](Documentations.md)).
*   Escribe código que **lea como el código que lo rodea**: respeta la densidad de comentarios, los nombres y los modismos existentes.
*   Comenta el *por qué*, no el *qué* obvio. Usa **JSDoc/TSDoc** para APIs públicas (parámetros, retorno, excepciones) de clases y funciones exportadas.

### 5.1. Docblock de clase en componentes del núcleo

Toda clase nueva (o existente que se modifique) en `src/core/` o `src/modules/` debería iniciar con un docblock que explique **qué responsabilidad cumple** dentro de la extensión, no solo el detalle técnico. El objetivo es que cualquier persona (o agente de IA) entienda *qué es* el componente y *cómo se comporta* sin tener que leer toda la clase.

Plantilla mínima:

```ts
/**
 * <What this component is, in domain language: its responsibility
 * within the extension.>
 *
 * <Central rule/invariant if any (e.g. "one FileService per remote
 * config in the workspace").>
 *
 * Key lifecycle methods:
 * - {@link methodA} <What it solves.>
 * - {@link methodB} <What it solves.>
 */
export default class SomeService {
```

> **Migración del existente:** la mayoría de las clases heredadas del upstream no
> tienen este docblock. Al **tocar** una clase por cualquier motivo, agrégalo si
> falta (regla del boy scout).

## 6. Build y Verificación

*   `npm run compile` — build de producción con webpack (genera `dist/`).
*   `npm run dev` — build de desarrollo con watch.
*   `npm test` — suite de pruebas con Jest.
*   `npm run package` — empaqueta la extensión (`.vsix`) con `vsce`.
*   Un cambio no está terminado hasta que **compila sin errores** y **la suite de pruebas pasa**.

## 7. Relación con otros protocolos

*   Todo cambio de código debe registrarse según [Changelogs.md](Changelogs.md).
*   La documentación asociada sigue [Documentations.md](Documentations.md).
*   El flujo de ramas y commits sigue [Git.md](Git.md).
