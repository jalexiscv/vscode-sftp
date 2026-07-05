# main como única rama principal del fork

**Fecha:** 2026-07-05
**Área:** docs

## Descripción

Por decisión del proyecto, la versión corregida (antes en `develop-fork`)
pasa a ser la rama principal con el nombre `main`, y se eliminan todas las
demás ramas locales y del repositorio publicado
([jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp)). El
historial de cada corrección se conserva íntegro en `main` (merges `--no-ff`
de cada rama de trabajo). El upstream sigue accesible como referencia vía el
remoto `origin`.

## Tipo de Cambio

- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `documents/Protocols/Git.md`
- Nuevo modelo de ramas: `main` como única rama de larga vida; las ramas de trabajo se integran con `--no-ff` y se eliminan tras el merge; push solo al remoto `fork`.

## Impacto

- Repositorio publicado con una única rama visible (`main`) que contiene la versión corregida completa.
- Ninguna pérdida de historial: los commits de todas las correcciones están en `main`.
