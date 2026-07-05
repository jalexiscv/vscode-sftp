# Nombres de archivo no ASCII corruptos en listados FTP

**Fecha:** 2026-07-05
**Área:** core

## Descripción

Issue upstream "The Chinese directory is garbled" / PR #443: el paquete
`ftp` decodifica todas las respuestas del servidor como latin1
(`chunk.toString('binary')`), por lo que los nombres UTF-8 (chino, acentos,
etc.) llegaban como mojibake al Remote Explorer y las operaciones sobre esos
archivos fallaban (al reenviar la ruta, se re-codificaba el mojibake y el
servidor no encontraba el archivo).

A diferencia del PR #443, la reinterpretación binary→utf8:

- Solo se aplica si la secuencia de bytes es UTF-8 válida (round-trip
  exacto); un servidor que realmente use latin1 conserva sus nombres.
- Solo se aplica al protocolo FTP. El PR también la aplicaba a SFTP, donde
  ssh2 ya entrega los nombres correctamente decodificados y la
  reinterpretación habría corrompido los nombres no ASCII correctos.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- Nueva función `decodeListingName()`: recupera el nombre UTF-8 desde la decodificación latin1 del paquete `ftp` cuando los bytes son UTF-8 válido.
- `list()` decodifica los nombres antes de construir las rutas y las entradas; `lstat()` se beneficia al comparar contra los nombres ya decodificados.

## Impacto

- Los directorios y archivos con nombres no ASCII se listan y operan correctamente sobre FTP con servidores UTF-8 (la mayoría).
- Servidores latin1 reales y nombres ASCII permanecen intactos.
- SFTP no se toca (ya era correcto).
