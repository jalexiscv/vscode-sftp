# Sobrescritura FTP rechazada en servidores con mod_rename

**Fecha:** 2026-07-05
**Área:** core

## Descripción

Issue upstream #420 / PR #445: en servidores proftpd con `mod_rename`, el
comando `STOR` sobre un archivo existente responde 550 y la subida falla;
solo funcionaba la primera subida de cada archivo.

Se implementa como *fallback* y no como borrado incondicional (que es lo que
proponía el PR #445, además sin `await`, con carrera entre DELETE y STOR):

- Solo se activa si `STOR` falla con código 550, el destino existe como
  archivo y el stream de entrada aún no fue consumido. node-ftp garantiza
  esto último: pausa el stream y solo lo consume tras la respuesta 150 del
  servidor, de modo que el reintento nunca sube datos truncados.
- Servidores normales no pagan ningún round-trip extra ni pierden la
  atomicidad de la sobrescritura.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- `put()` rastrea si la transferencia comenzó (evento `resume`) y, ante un 550 con destino existente y stream intacto, elimina el archivo remoto y reintenta el `STOR` una vez.

## Impacto

- Subidas repetidas funcionan en servidores FTP con `mod_rename` u overwrite deshabilitado vía 550.
- Sin cambios de comportamiento ni costo adicional para el resto de servidores.

## Nota de triaje

En esta iteración se evaluó y **descartó** el PR upstream #545 (guardar
contraseñas cifradas con contraseña maestra): es una funcionalidad nueva, no
un bug, y su implementación usa `crypto.createCipher` (eliminado en Node
moderno) y almacena las claves en una ruta relativa impredecible. Si se
quiere esa funcionalidad, debe rehacerse sobre `SecretStorage` de VSCode.
