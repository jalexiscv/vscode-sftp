# CI y release automatizada con GitHub Actions

**Fecha:** 2026-07-05
**Área:** build

## Descripción

El proyecto no tenía ninguna verificación automatizada: build, tests y lint
se ejecutaban a mano (el upstream se degradó precisamente por carecer de esta
red de seguridad). Se agregan dos workflows:

- **CI** (`ci.yml`): en cada push a `main` y en cada pull request ejecuta
  `npm ci`, tslint, build de webpack y la suite de jest sobre Node 22.
- **Release** (`release.yml`): al subir un tag `v*` verifica (lint + tests),
  empaqueta el `.vsix` con vsce y crea la GitHub Release con el artefacto
  adjunto y notas autogeneradas.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [NUEVO] `.github/workflows/ci.yml`
- Verificación de cada push/PR: lint, build y tests.

### [NUEVO] `.github/workflows/release.yml`
- Release automatizada al taggear: `git tag v1.x.y && git push fork v1.x.y` publica el `.vsix`.

## Impacto

- Ningún cambio entra a `main` sin pasar la verificación completa en un entorno limpio (Linux), complementando la verificación local en Windows.
- Publicar una release deja de ser un proceso manual de 4 pasos: basta con crear y subir el tag.
