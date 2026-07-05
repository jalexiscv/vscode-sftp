# Corrección de cuelgue tras cierre del canal SFTP y handlers inválidos

**Fecha:** 2026-07-05
**Área:** core

## Descripción

Dos defectos en `SSHClient` (adopta la corrección del PR upstream #582,
issue "SFTP session hangs indefinitely after server-side channel
termination"):

1. Cuando el servidor terminaba el canal SFTP (p. ej. `killall sftp-server`,
   timeout de inactividad del servidor), el cliente ssh2 no emitía ningún
   evento a nivel de conexión: la extensión seguía reutilizando un canal
   muerto y se colgaba indefinidamente en la siguiente operación.
2. `_connectSSHClient` registraba `.on('close', this.end())` y
   `.on('end', this.end())`: eso **invoca** `this.end()` en el momento del
   registro (y registra `undefined` como listener) en vez de pasar una
   función. Los listeners reales de desconexión los registra
   `RemoteClient.onDisconnected()`, así que estas líneas solo introducían
   un `end()` espurio durante el arranque de la conexión.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/core/remote-client/sshClient.ts`
- Tras obtener el canal SFTP, se escucha su evento `close` y se propaga como `this._client.end()`, lo que dispara `onDisconnected` → `RemoteFs.invalid()` y fuerza la reconexión perezosa en la siguiente operación.
- Eliminados los handlers inválidos `.on('close', this.end())` / `.on('end', this.end())`.
- Agregado el docblock de responsabilidad de la clase (regla boy scout de `Conventions.md`).

## Impacto

- La extensión se reconecta sola tras un cierre de canal del lado del servidor en vez de colgarse hasta reiniciar VSCode.
- Sin cambios de comportamiento en conexiones sanas.
