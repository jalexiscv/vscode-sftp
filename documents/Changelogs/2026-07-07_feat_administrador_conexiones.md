# Administrador gráfico de conexiones (webview)

**Fecha:** 2026-07-07
**Área:** ui

## Descripción

Nueva interfaz gráfica para administrar las conexiones y perfiles de
`.vscode/sftp.json` sin editar el JSON a mano. El comando
`SFTP: Open Connection Manager` (también accesible desde el engranaje de la
vista Remote Explorer) abre un panel webview con la lista de conexiones
(configuración base + perfiles) y un formulario para crear, editar, duplicar,
eliminar, probar y activar cada una.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/connectionManager/index.ts`
- Lógica del panel: singleton del webview, protocolo de mensajes (`ready`/`load`/`save`/`test`/`activate`/`openJson`), lectura y escritura de `.vscode/sftp.json` preservando los campos que el formulario no muestra, validación de cada perfil fusionado con la base (mismo esquema Joi de siempre) y guardas de consistencia (no activar un perfil sin guardar; si el perfil activo se elimina, caer al `defaultProfile`).

### [NUEVO] `src/modules/connectionManager/webviewHtml.ts`
- HTML/CSS/JS inline del panel (CSP con nonce; tema de VSCode vía variables `--vscode-*`). Lista lateral con la conexión activa marcada, formulario con la herencia base→perfil visible en placeholders, y acciones por conexión (guardar, probar, activar, duplicar, eliminar con confirmación).

### [NUEVO] `src/commands/commandOpenConnectionManager.ts`
- Comando `sftp.openConnectionManager`, auto-registrado por `initCommands`.

### [MODIFICADO] `src/core/remoteFs.ts`
- Nuevo helper `testRemoteConnection`: conecta una vez para verificar credenciales y cierra la conexión, salvo que ya existiera una equivalente compartida con los servicios en uso.

### [MODIFICADO] `src/modules/config.ts`
- Se exporta `mergedDefault` para reutilizar los defaults de configuración al probar conexiones.

### [MODIFICADO] `src/constants.ts`
- Constante `COMMAND_OPEN_CONNECTION_MANAGER`.

### [MODIFICADO] `package.json`
- Comando en `contributes.commands` (icono `$(settings-gear)`), `activationEvents` y botón en `view/title` del Remote Explorer.

## Impacto

- Permite gestionar múltiples servidores (mismos archivos, distintos destinos) de forma visual; al guardar, el watcher de configuración existente recarga los servicios sin reiniciar VSCode.
- "Probar conexión" reutiliza la maquinaria real de conexión (incluidas las contraseñas guardadas en SecretStorage) sin afectar las conexiones en uso.
- Sin breaking changes: el panel escribe el mismo esquema de `sftp.json`; si el archivo es un array de configuraciones, administra la primera (avisado con un banner).
