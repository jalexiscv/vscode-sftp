# Protocolo de Registro de Cambios (Changelog)

Este documento establece el protocolo para registrar todos los cambios realizados
en el código fuente del proyecto **VSCode-Sftp** (fork corregido de
[Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)).

Este protocolo debe ser seguido por todos los desarrolladores y agentes de IA que
trabajen en el proyecto.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/)
y este proyecto adhiere al [Versionado Semántico](https://semver.org/lang/es/).

> **Importante:** el `CHANGELOG.md` de la **raíz del repositorio** pertenece al
> proyecto original (upstream) y registra las *releases publicadas* de la
> extensión. **No se usa para el trabajo diario de este fork.** El historial de
> cambios propio de este proyecto vive en `documents/Changelogs/`. Solo al
> preparar una release de la extensión se consolida un resumen en el
> `CHANGELOG.md` raíz.

---

## Estructura de Archivos

```
VSCode-Sftp/
├── documents/
│   ├── Protocols/
│   │   └── Changelogs.md           ← Este archivo (protocolo)
│   └── Changelogs/
│       ├── CHANGELOG.md            ← Índice numerado de todos los cambios
│       ├── YYYY-MM-DD_descripcion.md   ← Archivo detallado por cambio
│       └── ...
└── CHANGELOG.md                    ← Releases del upstream (no tocar en el día a día)
```

> Las rutas `Changelogs/...` de este documento son relativas a `documents/`.

---

## 1. Índice de Cambios (`documents/Changelogs/CHANGELOG.md`)

Este archivo es un **índice numerado y resumido** de todos los cambios. **No debe contener detalles**, solo una línea breve por cambio con enlace al archivo detallado correspondiente.

### Formato del índice

```markdown
# Changelog - VSCode-Sftp

| #  | Fecha      | Descripción breve                              | Detalle                                       |
|----|------------|------------------------------------------------|-----------------------------------------------|
| 3  | 2026-07-10 | Corrección de reconexión SFTP tras timeout     | [Ver detalle](2026-07-10_descripcion.md)      |
| 2  | 2026-07-08 | Manejo de errores en subida de carpetas        | [Ver detalle](2026-07-08_otra_descripcion.md) |
| 1  | 2026-07-05 | Adaptación de protocolos al proyecto           | [Ver detalle](2026-07-05_descripcion.md)      |
```

> **Nota:** Las entradas se numeran de forma ascendente. La más reciente va primero (orden cronológico inverso).

---

## 2. Archivos Detallados por Cambio

Cada cambio significativo debe tener su **propio archivo** en `documents/Changelogs/` con la descripción completa.

### Nomenclatura del archivo

```
YYYY-MM-DD_descripcion_breve.md
```

Ejemplo: `2026-07-10_sftp_reconnect_timeout.md`

### Contenido del archivo detallado

```markdown
# Título descriptivo del cambio

**Fecha:** YYYY-MM-DD
**Área:** [core | commands | fileHandlers | modules | ui | helper | config | build | docs]

## Descripción

Breve explicación del cambio y su motivación (p. ej. el issue o bug del
upstream que corrige, con enlace si existe).

## Tipo de Cambio

- `Agregado` | `Cambiado` | `Corregido` | `Removido` | `Obsoleto` | `Seguridad`

## Archivos Afectados

### [NUEVO|MODIFICADO|ELIMINADO] `src/ruta/al/archivo.ts`
- Detalle de lo que se hizo en este archivo

### [NUEVO|MODIFICADO|ELIMINADO] `src/ruta/al/otro_archivo.ts`
- Detalle de lo que se hizo

## Impacto

- Descripción del impacto funcional para el usuario de la extensión
- Notas sobre compatibilidad o breaking changes si aplica (p. ej. cambios
  en el esquema de `sftp.json` o en comandos existentes)
```

---

## 3. Tipos de Cambios

| Tipo         | Uso                                          |
|:-------------|:---------------------------------------------|
| `Agregado`   | Nuevas funcionalidades o archivos             |
| `Cambiado`   | Modificaciones a funcionalidades existentes   |
| `Corregido`  | Corrección de bugs                            |
| `Removido`   | Funcionalidades o archivos eliminados         |
| `Obsoleto`   | Funcionalidades marcadas para futura remoción |
| `Seguridad`  | Correcciones de vulnerabilidades              |

---

## 4. Reglas Generales

1. **Todo cambio debe documentarse** al momento de realizarse, no después.
2. **Un archivo detallado por conjunto de cambios relacionados** — si en una sesión se hacen múltiples cambios al mismo componente, van en un solo archivo.
3. **Actualizar siempre el índice** (`documents/Changelogs/CHANGELOG.md`) al crear un archivo detallado.
4. Los documentos deben ser **legibles y claros**. Usar bloques de código para mostrar diferencias críticas si es necesario, manteniendo la brevedad.
5. Cuando el cambio corrige un bug reportado en el repositorio upstream, **enlazar el issue** correspondiente en la descripción.

---

*Este documento es la referencia para la IA y los desarrolladores sobre cómo gestionar el historial de cambios del proyecto.*
