# "Open SSH in Terminal" ignoraba los saltos (hop)

**Fecha:** 2026-07-05
**Área:** commands

## Descripción

Issue upstream "[bug] `Open SSH in Terminal` doesn't use hopping": si la
configuración usa `hop` (conexión a través de hosts intermedios), el comando
que abre la sesión SSH en el terminal integrado construía un `ssh` directo
al host final, que no es alcanzable sin los saltos, y la conexión fallaba.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/commands/commandOpenSshConnection.ts`
- El comando `ssh` generado incluye `-J usuario@host:puerto[,...]` (ProxyJump de OpenSSH) construido desde `config.hop`, tanto para un objeto único como para cadenas de saltos en array.

## Impacto

- La sesión de terminal replica la ruta de conexión de la extensión en configuraciones con `hop`.
- Configuraciones sin `hop` generan exactamente el mismo comando que antes.
