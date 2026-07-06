# Guardado seguro de contraseñas con SecretStorage

**Fecha:** 2026-07-05
**Área:** core

## Descripción

La feature más pedida del backlog del upstream ("Save SSH passwords" y
similares): hasta ahora, toda configuración sin `password` en `sftp.json`
pedía la contraseña en cada conexión, y la única alternativa era escribirla
en texto plano en el archivo de configuración.

Implementación sobre `SecretStorage` de VSCode (el llavero del sistema
operativo), a diferencia del PR upstream #545 que se descartó por usar
`crypto.createCipher` (eliminado de Node) y archivos en rutas relativas:

- Tras una conexión **exitosa** con una contraseña tecleada, se ofrece
  guardarla ("Save" / "Not now"), configurable con el nuevo ajuste
  `sftp.promptToSavePassword` (default `true`).
- En conexiones siguientes, si la configuración no trae autenticación
  propia (password/clave/agent/interactiveAuth), la contraseña guardada se
  inyecta sin preguntar.
- Si el servidor la rechaza (fallo de autenticación), se olvida
  automáticamente y se vuelve a pedir en el momento.
- Nuevo comando **`SFTP: Forget Saved Passwords`** para borrar todas las
  contraseñas guardadas (SecretStorage no es enumerable, así que se mantiene
  un índice de claves en `globalState`).

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `src/modules/savedPasswords.ts`
- Módulo de persistencia: get/save/remove/clear sobre SecretStorage + índice en globalState + oferta de guardado post-conexión.

### [MODIFICADO] `src/core/remoteFs.ts`
- `KeepAliveRemoteFs.getFs` inyecta la contraseña guardada, captura la tecleada, reintenta olvidando la obsoleta ante fallos de autenticación y dispara la oferta de guardado tras conectar.

### [NUEVO] `src/commands/commandForgetSavedPasswords.ts`
- Comando `sftp.forgetSavedPasswords`.

### [MODIFICADO] `src/extension.ts`, `src/constants.ts`, `package.json`
- Inicialización del módulo con el `ExtensionContext`, constante del comando, y aportes de comando + ajuste `sftp.promptToSavePassword`.

## Impacto

- Se puede trabajar sin contraseñas en texto plano en `sftp.json` y sin re-tecleos por conexión.
- Las credenciales se almacenan en el llavero del SO vía VSCode, nunca en archivos del proyecto.
- Comportamiento previo intacto para configuraciones con `password`, clave privada, agent o interactiveAuth.
