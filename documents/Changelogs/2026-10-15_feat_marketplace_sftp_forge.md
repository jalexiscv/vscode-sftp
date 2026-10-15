# Publicación en el Visual Studio Marketplace como SFTP Forge (`jalexiscv.sftp-forge`)

**Fecha:** 2026-10-15
**Área:** distribución, modules, docs

## Descripción

El usuario pidió publicar la extensión en el Visual Studio Marketplace. Se
creó el publisher `jalexiscv` (Jose Alexis Correa Valencia) y se subió la
1.30.1. El Marketplace rechaza nombres visibles iguales o muy parecidos a
los de extensiones existentes: "SFTP" lo usan liximomo y Natizyskunk, y
"SFTP Plus" choca con "SFTP+ MCP" y "Simple SFTP Plus". Se eligió
**SFTP Forge**, y el `name` del manifiesto pasa de `sftp` a `sftp-forge`
para que el identificador también sea propio: la extensión es
`jalexiscv.sftp-forge`.

Página: https://marketplace.visualstudio.com/items?itemName=jalexiscv.sftp-forge

Para VS Code un id nuevo es otra extensión. Quien tenga instalada la build
anterior (`jalexiscv.sftp`, distribuida solo como vsix) y reciba la nueva
(por el chequeo de actualizaciones de la 1.30.0 o instalándola del
Marketplace) quedaría con las dos a la vez, registrando los mismos comandos
`sftp.*`, vistas y ajustes. Por eso SFTP Forge, en su primera activación,
desinstala `jalexiscv.sftp` y ofrece recargar la ventana. La configuración
(`.vscode/sftp.json`, ajustes `sftp.*`) es la misma y no hay que rehacer
nada.

## Tipo de Cambio

- `Nuevo` (publicación en el Marketplace; retiro de la build anterior)
- `Cambiado` (`name` y `displayName` del manifiesto; documentación de instalación)

## Archivos Afectados

### [MODIFICADO] `package.json`
- `name`: `sftp` -> `sftp-forge`; `displayName`: `SFTP` -> `SFTP Forge`.
  Las claves de configuración, comandos, vistas y el esquema de `sftp.json`
  no cambian (siguen bajo `sftp.*`).

### [NUEVO] `src/modules/legacyBuild.ts`
- `retireLegacyBuild(currentId)`: si `jalexiscv.sftp` está instalada junto a
  esta extensión, la desinstala con `workbench.extensions.uninstallExtension`
  y ofrece `Reload Window`; si falla, avisa con la salida (desinstalarla a
  mano). La build antigua ejecutando este código se deja en paz.
- `extensionIdOf(context)`: `context.extension.id`, o `undefined` en hosts
  que no lo exponen.

### [MODIFICADO] `src/extension.ts`
- Llama a `retireLegacyBuild` tras iniciar el chequeo de actualizaciones,
  sin bloquear la activación; un error se reporta con `reportError`.

### [NUEVO] `src/modules/__tests__/legacyBuild-test.ts`
- 8 tests: ausente, desinstalada con y sin recarga, fallo de desinstalación,
  la propia build antigua (sin distinguir mayúsculas), id desconocido, y
  `extensionIdOf`.

### [MODIFICADO] `README.md`, `README.en.md`, `README.de.md`, `README.fr.md`, `README.pt-BR.md`, `README.zh-CN.md`
- Título "SFTP Forge"; insignias de versión e instalaciones del Marketplace;
  enlace de instalación al Marketplace (las releases VSIX quedan como
  instalación manual); sección de instalación con el Marketplace como vía
  recomendada (`code --install-extension jalexiscv.sftp-forge`) y el vsix
  renombrado a `sftp-forge-x.y.z.vsix`.

## Impacto

- Instalación y actualizaciones automáticas desde el Marketplace.
- Quien venga de `jalexiscv.sftp` queda con una sola extensión tras recargar.
- El chequeo propio de releases de GitHub sigue activo y es compatible: una
  instalación del Marketplace que acepte el vsix de una release se queda con
  el mismo id.
- Los vsix pasan a llamarse `sftp-forge-<versión>.vsix`.
