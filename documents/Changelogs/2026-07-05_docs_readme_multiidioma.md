# README multiidioma: español como base + 5 traducciones

**Fecha:** 2026-07-05
**Área:** docs

## Descripción

Se mejoró la estructura del `README.md` y se internacionalizó la portada del
repositorio:

- **Estructura**: barra de idiomas en el encabezado, badges (release,
  licencia, issues) e índice (`📑 Índice`) con anclas a todas las secciones.
- **Español como idioma base** en `README.md`.
- **Traducciones completas** en la raíz, enlazadas entre sí desde la barra
  de idiomas de cada archivo:
  - `README.en.md` — English
  - `README.zh-CN.md` — 中文（简体）
  - `README.pt-BR.md` — Português (BR)
  - `README.fr.md` — Français
  - `README.de.md` — Deutsch
- Las claves JSON de configuración, comandos, rutas y URLs se conservan
  idénticos en todos los idiomas; se traducen prosa, títulos, comentarios de
  los ejemplos y valores de relleno.

## Tipo de Cambio

- `Agregado` (traducciones) / `Cambiado` (estructura del README base)

## Archivos Afectados

### [MODIFICADO] `README.md`
- Barra de idiomas, badges e índice; contenido sin cambios de fondo.

### [NUEVO] `README.en.md`, `README.zh-CN.md`, `README.pt-BR.md`, `README.fr.md`, `README.de.md`
- Traducciones completas del README base.

### [MODIFICADO] `documents/Protocols/Documentations.md`
- La convención de idioma registra el modelo multiidioma y la regla de sincronización: al cambiar el README base deben actualizarse las traducciones en el mismo cambio.

## Impacto

- La portada es accesible en los seis idiomas más comunes de la base de usuarios de la extensión.
- Mantenimiento: cualquier edición del README base implica regenerar/ajustar las cinco traducciones (regla registrada en el protocolo).
