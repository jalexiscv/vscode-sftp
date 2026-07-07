# Modo strict de TypeScript activado

**Fecha:** 2026-07-07
**Área:** build

## Descripción

Se activa `"strict": true` en `tsconfig.json` para reducir errores de tipos,
con dos matices documentados como comentarios en el propio archivo:
`noImplicitAny` queda diferido (~180 parámetros sin tipo por anotar en un
barrido aparte) y `skipLibCheck` cubre los `@types` instalados que no tipan
limpio con TypeScript 3.9. Se corrigen los 26 errores reales que strict
destapó en `src/`.

## Tipo de Cambio

- `Cambiado`
- `Corregido`

## Archivos Afectados

### [MODIFICADO] `tsconfig.json`
- `strict: true` (reemplaza a `strictNullChecks`), `noImplicitAny: false` y `skipLibCheck: true`, con comentarios explicando cada excepción.

### [MODIFICADO] `src/modules/appState.ts`
- Bug latente corregido: asignar `profile` antes de llamar a `subscribe()` crasheaba (`_observer` undefined); ahora el observer es nullable y la notificación va con guarda.

### [MODIFICADO] `src/fileHandlers/createFileHandler.ts`
- La firma interna aceptaba `option?: T` cuando la pública promete `Partial<T>`; `invokeOption` ahora se tipa explícitamente en lugar de inferirse como `{}`.

### [MODIFICADO] 9 archivos más (`commands/abstract/command.ts`, `commands/shared.ts`, `core/fileService.ts`, `core/remote-client/sshClient.ts`, `core/remoteFs.ts`, `core/transferTask.ts`, `core/uResource.ts`, `modules/remoteExplorer/treeDataProvider.ts`, `ui/statusBarItem.ts`)
- Propiedades sin inicializar resueltas con aserciones `!` donde la asignación está garantizada tras la construcción, o con inicializadores reales donde son más fieles (`_cancelled = false`, `= null`, `= new Map()`); anotaciones `this: any` en las funciones que dependen del `this` dinámico de sus llamadores.

### [MODIFICADO] `test/preprocessor.js`
- El tsconfig ahora es JSONC (contiene comentarios): se lee con `tsc.readConfigFile` en lugar de `require()`.

## Impacto

- Sin cambios funcionales para el usuario; verificado con build de webpack limpio, 42/42 tests y tslint sin errores.
- Mayor seguridad de tipos para el desarrollo futuro; `noImplicitAny` queda como siguiente paso incremental.
