# Actualización de ssh2 a ^1.17.0 ("isDate is not a function")

**Fecha:** 2026-07-05
**Área:** core

## Descripción

El bug con más reportes del upstream (issues #586, #590 y numerosos
duplicados): toda operación SFTP fallaba con
`TypeError: isDate is not a function` en versiones recientes de VSCode.

La causa es que `ssh2` 1.13.0 (fijado en `package-lock.json`) usa el API
legado `util.isDate`, eliminado en los runtimes de Node que empaquetan los
VSCode recientes. Como `ssh2` está declarado como *external* en
`webpack.config.js`, la extensión lo distribuye tal cual desde
`node_modules`, por lo que la versión del lockfile es exactamente la que
se ejecuta en producción.

Adopta la corrección propuesta en el PR upstream #595.

## Tipo de Cambio

- `Corregido`

## Archivos Afectados

### [MODIFICADO] `package.json`
- Dependencia `ssh2` actualizada de `^1.13.0` a `^1.17.0`.

### [MODIFICADO] `package-lock.json`
- `ssh2` resuelto a 1.17.0 (sin `util.isDate`; compatible con Node moderno).

## Impacto

- Las transferencias SFTP vuelven a funcionar en VSCode con runtimes Node recientes.
- ssh2 1.17 además soporta formatos de clave OpenSSH modernos y algoritmos
  requeridos por servidores OpenSSH >= 8.8 (rsa-sha2), mitigando otros
  reportes de autenticación del upstream.
- Sin breaking changes: el API de ssh2 1.x se mantiene.
