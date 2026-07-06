# README del fork: motivación, actualizaciones y expectativas

**Fecha:** 2026-07-05
**Área:** docs

## Descripción

El README raíz conservaba la estructura y los avisos del upstream (notas del
mantenedor anterior, enlaces de instalación a su Marketplace y releases). Se
reescribió para presentar el fork:

- **Why this fork exists**: upstream sin mantenimiento desde 2023/2025,
  ruptura total en VSCode modernos (isDate), rama develop que no compilaba
  y el problema de seguridad de sftp.json subible al servidor.
- **What we updated**: tablas de correcciones de v1.16.4 y v1.16.5 con
  enlaces a las releases y a los issues/PRs del upstream.
- **What we expect from this version**: reemplazo drop-in, estabilidad en
  tooling actual, seguridad por defecto, proyecto vivo (backlog y tracker
  propios) y calidad verificable en cada release.
- Instalación apuntando a las releases del fork, con la advertencia del
  conflicto de comandos con la extensión original.
- Se conservó la documentación de uso (configuraciones de ejemplo, Remote
  Explorer, Debug, FAQ), los enlaces al wiki del upstream (la compatibilidad
  de configuración se mantiene) y una sección de créditos/donaciones a los
  autores originales.

## Tipo de Cambio

- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `README.md`
- Reescritura descrita arriba. La imagen del Remote Explorer pasa a ruta relativa (`assets/showcase/remote-explorer.png`) en vez de la URL cruda del repo upstream.

## Impacto

- La portada del repositorio comunica qué es el fork, por qué existe y qué garantiza.
- El README empaquetado en el `.vsix` se actualizará con la próxima release.
