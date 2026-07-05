# Reparación de la infraestructura de tests (Jest 29 / Node 22)

**Fecha:** 2026-07-05
**Área:** build

## Descripción

La suite de tests heredada del upstream estaba rota: 3 de las 4 suites ni
siquiera se ejecutaban y la única prueba del algoritmo de transferencia con
offset horario fallaba. Tres causas independientes:

1. `test/preprocessor.js` usaba la API de transformadores anterior a Jest 28
   (devolvía un `string`); Jest 29 exige un objeto `{ code }`.
2. `memfs` 2.x (mock del filesystem) es incompatible con los streams de
   Node 22 (`Cannot set property closed ... which has only a getter`), lo que
   hacía fallar en runtime las tareas de transferencia dentro de los tests.
3. Incluso `memfs` 4.x cierra el file descriptor de forma asíncrona tras
   `finish` ignorando `autoClose: false`, a diferencia del `fs` real de Node.
   Eso rompía a `TransferTask`, que conserva la propiedad del fd para hacer
   `futimes` y `close` después de escribir (el test
   `sync --update with time offset` recibía EBADF, el mtime remoto no se
   fijaba y la segunda pasada re-subía el archivo).

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `test/preprocessor.js`
- `process()` ahora devuelve `{ code }` como exige Jest >= 28.

### [MODIFICADO] `package.json` / `package-lock.json`
- devDependency `memfs` actualizada de ^2.15.5 a ^4 (compatible con streams de Node 22).

### [MODIFICADO] `__mocks__/fs.js`
- `createWriteStream` del mock neutraliza el cierre interno del stream cuando el llamador pasa `fd` con `autoClose: false`, replicando el contrato del `fs` real (el llamador conserva la propiedad del fd).

## Impacto

- `npm test` vuelve a ser una señal fiable: 4/4 suites y 42/42 tests en verde.
- Solo afecta al entorno de pruebas; ningún cambio en el código de la extensión.
