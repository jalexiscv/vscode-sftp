# El perfil activo seleccionado se respeta y persiste entre sesiones

**Fecha:** 2026-07-10
**Área:** modules

## Descripción

Con varios servidores (perfiles) configurados para el mismo proyecto, el perfil
activado con `SFTP: Set Profile` o con el botón "Activar" del Administrador de
Conexiones a veces "se cambiaba solo" y las subidas iban al servidor
equivocado; la única forma estable de fijarlo era declararlo como
`defaultProfile`. Dos causas independientes:

1. **La recarga de configuración pisaba la selección.** Cualquier guardado o
   cambio en disco de `sftp.json` (editor, cambio de rama de git, guardado del
   propio Administrador de Conexiones) recrea los servicios, y
   `createFileService()` restablecía incondicionalmente
   `app.state.profile = config.defaultProfile`.
2. **La selección no sobrevivía a los reinicios.** El perfil activo vivía solo
   en memoria, así que al reabrir VSCode volvía al predeterminado (o a
   ninguno).

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `src/modules/serviceManager/index.ts`
- `createFileService()` solo aplica `defaultProfile` cuando no hay perfil
  activo o cuando el activo ya no existe en los `profiles` de la configuración
  recargada. Una selección válida del usuario nunca se sobrescribe.

### [MODIFICADO] `src/extension.ts`
- Al activar la extensión se restaura el perfil de la sesión anterior desde
  `workspaceState`, antes de crear los servicios.
- El observer del estado persiste cada cambio de perfil en `workspaceState`.

### [MODIFICADO] `src/constants.ts`
- Nueva clave `STATE_KEY_ACTIVE_PROFILE` para el `workspaceState`.

## Impacto

- El servidor elegido permanece activo hasta que el usuario lo cambie, aunque
  se recargue `sftp.json` o se reinicie VSCode.
- `defaultProfile` pasa a ser lo que debía: valor inicial cuando no hay
  selección y respaldo si el perfil activo desaparece de la configuración.
- Sin cambios en el esquema de `sftp.json` ni en los comandos.
