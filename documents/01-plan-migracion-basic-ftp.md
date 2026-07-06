# Plan: migrar el soporte FTP de `ftp` (abandonado) a `basic-ftp`

## Contexto

El soporte FTP se apoya en el paquete [`ftp`](https://www.npmjs.com/package/ftp) 0.3.10, sin mantenimiento desde hace ~10 años. Varios bugs del backlog del upstream provienen directamente de él:

- "unable to parse pasv server response" (regex PASV frágil)
- Problemas de modo activo / EPSV
- FTPS contra FileZilla Server ("TLS session of data connection not resumed")
- Decodificación latin1 de los listados (mitigado en nuestro fork con `decodeListingName`, pero es un parche)
- Sin soporte IPv6

## Propuesta

Migrar `src/core/fs/ftpFileSystem.ts` y `src/core/remote-client/ftpClient.ts` a [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp) (mantenido, TypeScript nativo, UTF-8 por defecto, FTPS correcto, EPSV/PASV robustos).

## Plan

1. **Test de integración primero**: agregar `ftp-srv` como devDependency y una suite jest que levante un servidor FTP local y ejercite list/get/put/mkdir/delete/rename/chmod/futimes sobre la implementación actual (fija el comportamiento esperado).
2. Reescribir `FTPClient` sobre `basic-ftp` (`Client.access` con `secure`/`secureOptions`, keepalive con NOOP propio — basic-ftp no trae keepalive).
3. Reescribir `FTPFileSystem`: mapear `list()` a `FileInfo` de basic-ftp, streams de `downloadTo`/`uploadFrom`, `SITE CHMOD`, `MFMT`, y eliminar `decodeListingName` (basic-ftp negocia UTF-8 con `OPTS UTF8 ON`).
4. Conservar el contrato actual: cola de concurrencia 1, `onDisconnected` → invalidación, semántica de `put` con fd/handles ficticios.
5. Correr la suite de integración contra la nueva implementación y probar manualmente contra un servidor real (proftpd/vsftpd y FileZilla Server para FTPS).
6. Retirar el paquete `ftp` y el monkey-patch de `_send` en `ftpClient.ts`.

## Riesgos

- Cambio de comportamiento en servidores exóticos (parsers de listado distintos): basic-ftp cubre Unix/DOS/MLSD, más formatos que `ftp`.
- El modo activo NO está soportado por basic-ftp (solo pasivo): hay usuarios del backlog pidiendo modo activo — decidir si se mantiene `ftp` como fallback `passive: false` o se documenta la limitación.

## Estado: COMPLETADO (2026-07-05, v1.18.0)

La migración se ejecutó en la rama `feat/basic-ftp`:

- **Test de integración previo** (`test/integration/ftpFs.integration.spec.js`),
  gateado por variables de entorno (`FTP_TEST_HOST/USER/PASSWORD/...`), que
  ejercita ensureDir → put → list → download → MFMT → rename → unlink → rmdir
  contra un servidor FTPS real y limpia solo su propio directorio aislado.
  Baseline con el paquete `ftp`: 7/8 (fallo `read ECONNRESET` en FTPS). Con
  `basic-ftp`: **8/8**.
- `FTPClient` reescrito sobre `basic-ftp` (`Client.access` con `secure`/
  `secureOptions`, keepalive por NOOP con `unref`, desconexión propagada por
  EventEmitter → `onDisconnected`).
- `FTPFileSystem` reescrito: `list` sobre `FileInfo`, `get` vía `downloadTo`
  + PassThrough, `put` vía `uploadFrom`, `MFMT`/`SITE CHMOD`/`MKD`/`RMD` por
  `send`, `removeDir` recursivo. Se eliminó `decodeListingName` (basic-ftp
  negocia UTF-8) y el monkey-patch de `_send` del paquete viejo.
- Dependencia `ftp` **eliminada** de `package.json`.

**Limitación asumida** (modo activo): documentada; basic-ftp usa pasivo. El
config del backlog que pedía modo activo queda pendiente si aparece demanda
real (requeriría un cliente FTP alternativo solo para ese caso).

_Origen: iteración de mejoras 2026-07-05 (documents/Changelogs)._
