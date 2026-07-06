# Migración del soporte FTP de `ftp` (abandonado) a `basic-ftp`

**Fecha:** 2026-07-05
**Área:** core

## Descripción

El soporte FTP dependía del paquete [`ftp`](https://www.npmjs.com/package/ftp)
0.3.10, sin mantenimiento desde hace ~10 años y origen directo de varios bugs
del backlog del upstream (PASV frágil, FTPS inestable con FileZilla,
decodificación latin1 de listados, `read ECONNRESET` en conexiones de datos).

Se migró a [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)
(mantenido, TypeScript nativo, UTF-8 negociado, FTPS correcto, pasivo
robusto), siguiendo el plan de [01-plan-migracion-basic-ftp.md](../01-plan-migracion-basic-ftp.md).

## Metodología (test primero)

Se creó un **test de integración contra un servidor FTPS real**
(`test/integration/ftpFs.integration.spec.js`), gateado por variables de
entorno (`FTP_TEST_HOST/USER/PASSWORD/PORT/SECURE`) para que CI nunca lo
ejecute. Ejercita el ciclo completo (ensureDir → put → list → download →
MFMT → rename → unlink → rmdir) sobre un directorio aislado que crea y borra
él mismo, sin tocar nada preexistente.

- Baseline con el paquete `ftp`: **7/8** (fallo `read ECONNRESET` en la
  primera operación de datos FTPS).
- Tras la migración a `basic-ftp`: **8/8**. Se verificó además que el
  servidor no quedó con residuos.

## Tipo de Cambio

- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `src/core/remote-client/ftpClient.ts`
- Reescrito sobre `basic-ftp`: `Client.access` con `secure`/`secureOptions`, keepalive por NOOP (con `unref`), desconexión propagada por EventEmitter a `onDisconnected`. Eliminado el monkey-patch de `_send`/`setLastMod` del paquete viejo.

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- Reescrito sobre la API de `basic-ftp`: `list` mapea `FileInfo`; `get` usa `downloadTo` + `PassThrough`; `put` usa `uploadFrom`; `MFMT`, `SITE CHMOD`, `MKD`, `RMD` vía `send`; `removeDir` recursivo. Eliminado `decodeListingName` (ya no hace falta). Permisos y códigos de error adaptados a los de basic-ftp. Se conserva el retry del 550 (mod_rename) y la cola de concurrencia 1.

### [NUEVO] `test/integration/ftpFs.integration.spec.js`
- Suite de integración FTP env-gated (se salta sin credenciales).

### [MODIFICADO] `package.json` / `package-lock.json`
- Agregado `basic-ftp` ^6.0.1; **eliminado** `ftp`.

### [MODIFICADO] `documents/01-plan-migracion-basic-ftp.md`
- Marcado como completado con el resumen de la ejecución.

## Impacto

- FTP/FTPS más estable y moderno; se espera resolver el cluster de bugs FTP del backlog (PASV, FTPS/FileZilla, encoding, ECONNRESET).
- **Limitación asumida**: `basic-ftp` solo soporta modo pasivo. El modo activo (`passive: false`) deja de estar soportado; queda documentado.
- El resto del contrato del filesystem se mantiene: sin cambios para SFTP ni para la capa de transferencia.
