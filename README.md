# SFTP — extensión de sincronización para VS Code (fork corregido)

🌍 **Español** (base) · [English](README.en.md) · [中文（简体）](README.zh-CN.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

[![Release](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-yellow.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**Fork corregido y mantenido por [@jalexiscv](https://github.com/jalexiscv)** de la popular extensión de sincronización SFTP/FTP.<br>
Linaje: fork de [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), a su vez fork del ya no mantenido [plugin SFTP de liximomo](https://github.com/liximomo/vscode-sftp.git).

- 📦 **Instalación (releases VSIX):** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Reportar problemas:** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Historial completo de cambios:** [CHANGELOG.md](CHANGELOG.md)

VSCode-SFTP te permite agregar, editar o eliminar archivos en un directorio local y sincronizarlos con un directorio de un servidor remoto usando distintos protocolos de transferencia como FTP o SSH. La configuración más básica requiere solo unas pocas líneas, con un amplio abanico de opciones específicas disponibles para cubrir las necesidades de cualquier usuario. Potente y rápida a la vez, ayuda a los desarrolladores a ahorrar tiempo al permitirles usar un editor y un entorno familiares.

## 📑 Índice

- [Por qué existe este fork](#por-qué-existe-este-fork)
- [Qué actualizamos](#qué-actualizamos)
- [Novedades de la v1.29.0](#novedades-de-la-v1290)
- [Qué esperamos de esta versión](#qué-esperamos-de-esta-versión)
- [Instalación](#instalación)
- [Documentación](#documentación)
- [Uso](#uso)
- [Configuraciones de ejemplo](#configuraciones-de-ejemplo)
- [Explorador Remoto](#explorador-remoto)
- [Depuración](#depuración)
- [FAQ](#faq)
- [Créditos y apoyo a los autores originales](#créditos-y-apoyo-a-los-autores-originales)
- [Licencia](#-licencia) · [Autor](#-autor) · [Donaciones](#%EF%B8%8F-donaciones)

---

## Por qué existe este fork

Lanzamos esta versión porque el proyecto original, siendo excelente, llegó a un punto en el que ya no podía servir a sus usuarios:

1. **El proyecto upstream está efectivamente sin mantenimiento.** Su mantenedor declaró en marzo de 2025 que no podía seguir trabajando en él y que la [v1.16.3 (junio de 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) debía considerarse la última versión estable. Desde entonces se han acumulado ~600 issues sin corrección.
2. **La extensión se rompió en los VS Code modernos.** Los VS Code recientes incluyen un runtime de Node.js en el que la dependencia empaquetada `ssh2` 1.13 falla con `TypeError: isDate is not a function`, haciendo fallar toda operación SFTP — el bug más reportado del proyecto (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **La rama de desarrollo del upstream ni siquiera compilaba.** Su rama `develop` tenía errores de compilación de TypeScript y la suite de tests rota, de modo que las correcciones de la comunidad (varias enviadas como pull requests hace años) no tenían camino para publicarse.
4. **Existía un problema de seguridad sin resolver.** Con la configuración por defecto, sincronizar un proyecto podía subir `.vscode/sftp.json` — con el host, el usuario y la contraseña del servidor — al servidor remoto, a menudo dentro de un docroot público.

En lugar de dejar que una herramienta usada por miles de desarrolladores se degradara, la bifurcamos, reparamos sus cimientos (build, tests, linter), corregimos los bugs más reportados y nos comprometimos a mantenerla funcionando.

## Qué actualizamos

Cada corrección fue verificada (build de webpack limpio, 920 tests, linter sin errores) antes de publicarse. El detalle de cada cambio vive en [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — cimientos y correcciones críticas

| Área | Corrección |
|------|------------|
| **Compatibilidad** | `ssh2` actualizado a 1.17.0: corrige *"isDate is not a function"* en VS Code modernos y habilita formatos de clave OpenSSH modernos y algoritmos rsa-sha2 (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Seguridad** | `.vscode/sftp.json` (credenciales) ya no puede subirse nunca al servidor, sin importar la configuración de `ignore` |
| **Fiabilidad** | Reconexión automática tras un cierre del canal SFTP del lado del servidor, en vez de colgarse indefinidamente (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Corregido *"Error: Config Not Found"* / `uploadOnSave` que no funcionaba cuando el casing de la ruta reportada difería del workspace (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | Los patrones de `ignore` ahora funcionan de verdad (el matcher gitignore recibía rutas con separadores `\`) |
| **Configuración** | `sftp.json` se recarga cuando cambia fuera del editor — p. ej. un cambio de rama git (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Los nombres de archivo no ASCII (chino, acentos) ya no llegan corruptos en los listados (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), sin su regresión en SFTP) |
| **FTP** | Las sobrescrituras rechazadas con 550 por servidores proftpd con `mod_rename` se reintentan de forma segura (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | Se restauró la compilación del código, se reparó la infraestructura de tests (Jest 29, Node 22) y se limpiaron todas las violaciones de lint preexistentes |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — segunda ronda

| Área | Corrección |
|------|------------|
| **SSH** | `Open SSH in Terminal` ahora usa la cadena de `hop` configurada vía ProxyJump de OpenSSH (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Explorador Remoto** | Los symlinks remotos que apuntan a directorios son navegables sobre SFTP — p. ej. despliegues tipo `current -> releases/N` (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` ahora se dispara al guardar documentos notebook como `.ipynb` |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — contraseñas seguras y CI

| Área | Cambio |
|------|--------|
| **Seguridad** | **Guardado seguro de contraseñas** con SecretStorage de VS Code (el llavero del sistema): tras una conexión exitosa se ofrece recordar la contraseña tecleada, se inyecta automáticamente en conexiones siguientes y se olvida sola si el servidor la rechaza. Nuevo comando `SFTP: Forget Saved Passwords` y ajuste `sftp.promptToSavePassword` |
| **Calidad** | CI en GitHub Actions (lint, build y tests en cada push/PR) y release automatizada al publicar un tag |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — FTP moderno

| Área | Cambio |
|------|--------|
| **FTP** | **Backend FTP migrado del paquete `ftp` abandonado (~10 años sin mantenimiento) a [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)**: UTF-8 nativo, FTPS robusto y modo pasivo fiable. Validado contra un servidor FTPS real con un test de integración nuevo (baseline `ftp`: 7/8 con `read ECONNRESET`; `basic-ftp`: 8/8). Resuelve el grupo de bugs FTP del backlog (PASV, FTPS con FileZilla, nombres no ASCII, ECONNRESET) |
| **Nota** | `basic-ftp` solo soporta modo pasivo; el modo activo de FTP (`passive: false`) deja de estar soportado |

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — administrador de conexiones

| Área | Cambio |
|------|--------|
| **UI** | **Nuevo Administrador de Conexiones** (`SFTP: Open Connection Manager`, también en el engranaje de la vista Remote Explorer): panel gráfico para crear, editar, duplicar, eliminar, probar y activar las conexiones/perfiles de `sftp.json` sin editar el JSON a mano. Al guardar, los servicios se recargan solos; "Probar conexión" reutiliza la maquinaria real de conexión (incluidas las contraseñas guardadas) |
| **Calidad** | Modo `strict` de TypeScript activado (`noImplicitAny` diferido) y 26 errores reales de tipos corregidos, incluido un crash latente del observer de perfiles |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — perfil activo estable y exclusión de temporales

| Área | Cambio |
|------|--------|
| **Transferencias** | Todo archivo o carpeta cuyo nombre contenga `.tmp` queda excluido de forma permanente de las transferencias (subidas, `uploadOnSave` y sync), en todos los servidores y sin configurar nada en `ignore` |
| **Perfiles** | El perfil activado con `SFTP: Set Profile` o con el Administrador de Conexiones ya no "se cambia solo": las recargas de `sftp.json` dejan de restablecerlo al `defaultProfile` y la selección persiste entre reinicios de VSCode. `defaultProfile` pasa a ser solo el valor inicial y el respaldo si el perfil activo desaparece |

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — espejo local-remoto seguro

| Área | Cambio |
|------|--------|
| **Transferencias** | Los archivos temporales nunca se suben: una lista integrada excluye los archivos de intercambio y respaldo de los editores, los bloqueos de Office, los restos de merge, las descargas a medias y los metadatos del sistema, en todos los servidores y sin configurar nada (`ignoreTempFiles`, `tempFilePatterns`) |
| **Borrados** | Los borrados locales se replican en el servidor (`deleteRemoteOnLocalDelete`, activo por defecto), con cuatro salvaguardas: confirmación modal por encima de `deleteRemoteConfirmThreshold` (10), descarte de los borrados provocados por git, autosupresión durante `Sync Remote -> Local --delete` y papelera remota |
| **Papelera remota** | Con `remoteTrash`, borrar es un `rename` del lado del servidor hacia una papelera, reversible con `SFTP: Undo Last Remote Deletion` y `SFTP: Restore from Remote Trash`; `SFTP: Empty Remote Trash` la vacía y lo caducado se purga pasados los `retentionDays` |
| **Renombrados** | `renameRemoteOnLocalRename` replica renombrar y mover como un `rename` remoto, sin volver a subir y sin ningún instante en el que la ruta falte en el servidor |
| **UI** | Vista de actividad con el historial de cada transferencia, borrado y renombrado, y reintentos (`sftp.showActivityView`); modo pausa (`SFTP: Pause/Resume Auto Sync`) que suspende toda la sincronización automática |
| **Endurecimiento** | Dos pasadas de revisión adversarial antes de publicar: salvaguarda de git evaluada al encolar, un único camino de borrado, rutas de papelera inseguras rechazadas, perfil del borrado respetado al restaurar y purgar, purga que barre el propio directorio remoto |

### [v1.24.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.24.0) — cambios externos y verificación de carga

| Área | Cambio |
|------|--------|
| **Cambios externos** | Un índice de sincronización persistente recuerda, por servidor, qué versión de cada archivo se subió y verificó por última vez; el árbol local se compara con él al arrancar, al recargar `sftp.json`, al reanudar, al recuperar el foco tras cinco minutos, bajo demanda (`SFTP: Scan for External Changes`) y, opcionalmente, por sondeo periódico (`watcher.pollInterval`), de modo que lo editado fuera del editor —o con VS Code cerrado— se sube a través de un plan sin listar el servidor. `SFTP: Rebuild Sync Index` siembra el índice en el primer uso; claves `externalChanges.scanOnStartup`, `scanOnResume`, `confirmThreshold` |
| **Un solo recolector de cambios** | `uploadOnSave` y el watcher ya no suben dos veces el mismo guardado: los guardados del editor suben de inmediato, los cambios externos se agrupan (700 ms) y se deduplican por ruta |
| **Planes de carga** | Cada lote es un plan (origen, motivo por archivo, estado, intentos, error) visible en el grupo "Upload plans" de la vista de actividad, con `SFTP: Preview Upload (Dry Run)`, `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` y `SFTP: Clear Upload Plans`; la barra de estado muestra `↑N` pendientes y `✗N` fallidos. Por encima de `externalChanges.confirmThreshold` (20), tras una operación de git o cuando el lote contiene archivos que el índice nunca ha visto, un diálogo modal pregunta antes (`Review plan`, `Upload N file(s)`, `Skip`; `Skip` se recuerda) |
| **Verificación de carga** | Toda subida cuenta los bytes enviados y, con `verifyUpload: "stat"` (por defecto), comprueba que el tamaño remoto coincide exactamente; `"hash"` compara además un digest vía SSH o FTP y degrada a `stat` si el servidor no sabe calcularlo. Los fallos transitorios se reintentan (`uploadRetries`, 2); los permanentes no |
| **Registro de actividad persistente** | Cada tarea —venga de un comando, de un guardado o del watcher— se registra con su ruta remota y el resultado de la verificación, y sobrevive a las recargas de la ventana (`activity-log.json`); los fallos previos a la transferencia (conexión, credenciales, permisos) también aparecen |
| **Correcciones y endurecimiento** | `uploadFile()` rechaza cuando falla la transferencia; la supresión de la sincronización automática durante descargas se aplica de verdad; los patrones `dir/` de `ignore` podan el subárbol; se cortan los bucles de symlinks; los errores SFTP numéricos se describen. Dos revisiones adversariales antes de publicar; mientras el índice no está sembrado, los escaneos automáticos solo vuelven a subir lo que la propia extensión subió |

### [v1.25.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.25.0) — exclusión solo de subida

| Área | Cambio |
|------|--------|
| **Exclusión solo de subida (`uploadExclude`)** | Una lista de patrones gitignore, con la misma sintaxis y anclaje que `ignore`, que nunca viaja hacia el servidor: `Upload File` / `Upload Folder` / `Upload Project`, `uploadOnSave`, el watcher, los escaneos y planes, `Upload Changed Files` y `Sync Local -> Remote` (con `syncOption.delete`, la copia remota tampoco se borra). En un perfil se suma a la lista base |
| **El servidor conserva su copia** | Borrar o renombrar en local una ruta excluida no toca el servidor (`deleteRemoteOnLocalDelete`, `renameRemoteOnLocalRename`, `watcher.autoDelete`); `Rebuild Sync Index` la poda en ambos lados |
| **Lo que no cambia** | Las descargas, `Sync Remote -> Local`, el explorador remoto y el diff siguen viendo esas rutas; `Force Upload` omite la lista, como omite `ignore`. Un comando de subida sobre una ruta excluida lo avisa con una notificación y no conecta; `Upload Changed Files` lista los archivos apartados en un grupo propio |
| **Corrección** | Un borrado local cuyo patrón `dir/` de `ignore` solo casa como directorio ya no se replica en el servidor: la ruta borrada se evalúa ahora como archivo y como directorio |

### [v1.26.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.26.0) — dar por subido y exclusiones desde la interfaz

| Área | Cambio |
|------|--------|
| **Dar por subido (`Mark as uploaded`)** | Cuarto botón en el diálogo de confirmación de cualquier plan, y `Mark Plan as Uploaded` / `Mark as Uploaded` sobre un plan o un archivo en la vista de actividad: los archivos se registran en el índice como ya presentes en el servidor, en su versión actual, sin transferir nada, y no vuelven a proponerse hasta que cambien. Estado propio `assumed`, distinto de `verified` en resúmenes, informes e iconos |
| **Sembrar el índice sin listar el servidor** | `SFTP: Mark Local Files as Uploaded` (también `Mark all as uploaded` en el aviso de índice no construido) recorre el árbol local, muestra el recuento y, al confirmar, siembra el índice con todo lo que hay en local; a partir de ahí solo se propone lo que cambie. La alternativa rápida a `Rebuild Sync Index` para sitios con decenas de miles de archivos por FTP |
| **Exclusiones de subida desde la interfaz** | Clic derecho sobre una carpeta → `SFTP: Exclude from Upload` (y `SFTP: Include in Upload Again` sobre una ya excluida), `SFTP: Manage Upload Exclusions` para revisar, añadir o quitar entradas, y una lista con `×` en el administrador de conexiones. Todo escribe la lista `uploadExclude` de `sftp.json`, respetando su formato |
| **Seguridad** | El log `config at …` del canal de salida enmascaraba la contraseña de la raíz pero no la de cada perfil; ahora enmascara ambas |

### [v1.27.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.27.0) — límites para proyectos grandes y almacenamiento limpio por versión

| Área | Cambio |
|------|--------|
| **Tope por plan (`externalChanges.maxPlanItems`)** | Un escaneo, un sondeo o una ráfaga del watcher que encuentra más archivos cambiados que el tope (2000 por defecto; `0` lo quita) ya no se convierte en un plan: un aviso indica el conteo y ofrece `Mark all as uploaded` (el árbol local pasa a ser la referencia) y `Manage upload exclusions`; la tercera salida es subir el proyecto una vez y volver a escanear. Los escaneos automáticos de esa conexión esperan a un escaneo manual, a un rebuild, a un dar por subido o a una recarga de `sftp.json`; el recolector descarta la ráfaga antes de hacer un solo `stat` y lo avisa una vez por sesión |
| **Vista de actividad paginada** | Un plan lista sus primeros 200 archivos y una fila `N more file(s)…` que muestra la página siguiente; antes el árbol materializaba una fila por elemento en cada refresco, varias veces por archivo subido |
| **Índice escrito con calma** | Mientras corre un plan, el índice de sincronización se guarda una vez por minuto en lugar de una vez por segundo (cada subida verificada lo marcaba sucio), y una vez más al terminar; un guardado explícito no se retiene |
| **Almacenamiento limpio por versión** | La primera vez que una versión nueva se activa en un workspace, el índice de sincronización y el log de actividad de la versión anterior se descartan antes de cargarse (el canal de salida lo registra); el índice arranca vacío y vuelve el aviso para sembrarlo o reconstruirlo, como en el primer uso. Nada del proyecto se toca |

### [v1.28.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.28.0) — conexión resiliente

| Área | Cambio |
|------|--------|
| **Subidas en espera, no fallidas** | Al perderse la conexión, la tarea interrumpida y las que quedaban en cola vuelven a `pending` con `on hold: <motivo>`, el plan sigue abierto (los escaneos no vuelven a planificar esos archivos encima), el índice no se toca y hay **un aviso por servidor y caída** en lugar de un diálogo por archivo. Los comandos (`Upload Project`, `Sync…`) lo informan una vez, con lo hecho, lo interrumpido y lo no intentado |
| **Reconexión con espera creciente** | Cada conexión recuerda sus intentos fallidos y retiene los nuevos 1 s, 2 s, 4 s… hasta un minuto (un minuto como mínimo tras un `421`); mientras tanto quien la pida recibe `connection is down; next attempt in N s` sin abrir un socket. Al volver la conexión, los planes en espera se reanudan solos; si no vuelve, lo reintentan con esa espera hasta diez veces y luego aguardan en la vista de actividad |
| **Menos conexiones FTP** | Una conexión FTP sin comandos durante cinco minutos se cierra (el `NOOP` no cuenta) y se reabre con el siguiente uso; antes se mantenía viva una por perfil, por entrada de `sftp.json` y por ventana durante toda la sesión. Un comando que muere con el socket lo avisa al instante, no en el siguiente tick del keepalive; al cambiar de perfil se cierra la conexión del anterior; un `close` tardío de un cliente SSH muerto ya no tumba la conexión que lo reemplazó |
| **Menos falsos cambios** | `.git`, `.svn` y `.hg` se ignoran por defecto a cualquier profundidad (la integración git del editor reescribe `.git/index` y `FETCH_HEAD` en cada `status`; `"!.git"` en `ignore` lo recupera), y un evento del watcher o un guardado sobre un archivo cuyo tamaño y mtime (al segundo) son los que el índice verificó ya no se planifica: un evento no es una edición |

## Novedades de la v1.29.0

La v1.29.0 responde a un síntoma concreto: la extensión seguía proponiendo como "modificados" archivos cuyo contenido no había cambiado. La causa era la regla del índice —tamaño y mtime al segundo—, y el mtime se mueve por muchos motivos que no son una edición: un `git checkout`, `stash` o `pull` que deja el contenido idéntico, una copia o una restauración de copia de seguridad, un formateador o un paso de build que reescribe el mismo texto, un `touch`. Ahora el índice guarda una huella del contenido y un archivo solo cuenta como modificado si cambiaron sus bytes.

| Novedad | Qué aporta |
|---------|------------|
| **Huella de contenido** | Cada subida verificada guarda en el índice el SHA-1 de los bytes que envió, calculado sobre el propio flujo (nada se lee dos veces); las descargas también. Un escaneo, un evento del watcher, un sondeo o una vista previa que encuentra un archivo con el mismo tamaño y otro mtime lo lee una vez, compara la huella y, si coincide, lo deja en paz y mueve la entrada al mtime nuevo para no volver a leerlo; solo bytes distintos lo hacen `modified`. Un tamaño distinto sigue siendo cambio sin lectura; los archivos de más de 64 MB conservan la regla de tamaño y mtime |
| **Siembra con huella** | `SFTP: Rebuild Sync Index` y `SFTP: Mark Local Files as Uploaded` leen los archivos que registran (progreso `N fingerprinted`, cancelable), y `Mark as uploaded` y `Skip` en un plan hacen lo mismo con los suyos: a partir de ahí un `touch` o un checkout idéntico ya no es un cambio. El canal de salida cuenta lo reconocido (`N file(s) rewritten with the same content, not planned`) |
| **`externalChanges.compareContent`** | Clave nueva, `true` por defecto. Apagada, no se lee ningún archivo ni se anota huella alguna y la extensión se comporta exactamente como la 1.28.0 |
| **Índices existentes** | Las entradas anteriores no tienen huella y siguen la regla vieja hasta que una subida, un rebuild o un dar por subido se la anoten. Para cubrir de golpe un proyecto ya sincronizado, ejecuta una vez `SFTP: Mark Local Files as Uploaded` (o `Rebuild Sync Index`) por servidor |

**v1.29.1 (corrección).** Los archivos de 0 bytes vuelven a subir por FTPS: contra un servidor con TLS 1.3 (Pure-FTPd, por ejemplo) cada uno cerraba la sesión con una alerta `decode error` en el socket de datos y dejaba el plan en espera una y otra vez. Además, un archivo en cuya subida la conexión se cae tres veces seguidas pasa a `failed` y el plan continúa con el resto en lugar de quedarse retenido en él.

**v1.29.2 (corrección).** Un comando de carpeta (`Upload Folder`, `Sync…`, `Download Folder`) interrumpido por una pérdida de conexión ya no termina ahí con el resto del árbol sin subir y un diálogo por carpeta seleccionada: espera a que la conexión vuelva, reconecta y continúa donde iba, sin reenviar los archivos ya verificados, hasta diez veces, como hace un plan. Además, una carpeta seleccionada junto con una de sus subcarpetas se recorre una sola vez; antes cada archivo bajo ambas se subía dos veces a la vez.

## Qué esperamos de esta versión

- **Un reemplazo directo (drop-in).** El mismo formato de `sftp.json`, los mismos comandos, los mismos flujos de trabajo — las configuraciones existentes funcionan sin ninguna migración.
- **Estabilidad sobre el tooling actual.** La extensión debe seguir funcionando en los VS Code y runtimes de Node.js al día, que es justo donde el original se rompió.
- **Seguridad por defecto.** Tus credenciales nunca salen de tu máquina como parte de una sincronización, incluso con una lista `ignore` personalizada o vacía.
- **Un proyecto vivo.** Seguiremos triando el backlog del upstream (peticiones como proxies SOCKS5, claves `.ppk` o diff de carpetas son candidatas para próximas rondas), y los issues/PRs en [nuestro tracker](https://github.com/jalexiscv/vscode-sftp/issues) son bienvenidos.
- **Calidad verificable.** Ninguna release se publica sin build limpio, suite de tests en verde y linter sin errores; cada cambio queda documentado en [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

---

## Instalación

> ⚠️ **Desinstala o deshabilita primero cualquier otra extensión SFTP** (la de liximomo o la de Natizyskunk): registran los mismos comandos `sftp.*` y entrarán en conflicto con esta.

1. Descarga el `sftp-x.y.z.vsix` más reciente desde la [página de Releases](https://github.com/jalexiscv/vscode-sftp/releases).
2. En VS Code, abre Extensiones (Ctrl + Shift + X).
3. Abre el menú "Más acciones" (los puntos suspensivos arriba) y elige "Instalar desde VSIX…".
4. Localiza el archivo VSIX y selecciónalo.
5. Recarga VS Code.
6. ¡Listo!

O desde la línea de comandos:

```
code --install-extension sftp-1.29.2.vsix
```

## Documentación
- [Inicio](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Ajustes](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Configuración común](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [Configuración SFTP](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [Configuración FTP](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Comandos](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> El wiki del upstream (en inglés) sigue siendo la referencia para ajustes y comandos: este fork mantiene compatibilidad total de configuración.

## Uso
Si los archivos más recientes ya están en un servidor remoto, puedes empezar con una carpeta local vacía, descargar el proyecto y, a partir de ahí, sincronizar.

1. En `VS Code`, abre el directorio local que quieras sincronizar con el servidor remoto (o crea un directorio vacío donde descargar primero el contenido de una carpeta del servidor para editarla localmente).
2. Pulsa `Ctrl+Shift+P` en Windows/Linux o `Cmd+Shift+P` en Mac para abrir la paleta de comandos y ejecuta el comando `SFTP: config`.
3. Aparecerá un archivo de configuración básico llamado `sftp.json` dentro del directorio `.vscode`; ábrelo y edita los parámetros con la información de tu servidor remoto.

Por ejemplo:
```json
{
    "name": "Nombre del perfil",
    "host": "host_del_servidor_remoto",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "usuario",
    "remotePath": "/public_html/project", // <--- Esta es la ruta que se descargará con "Download Project"
    "password": "contraseña",
    "uploadOnSave": false
}
```
El parámetro `password` de `sftp.json` es opcional; si lo omites, se te pedirá la contraseña al sincronizar.
_Nota:_ las barras invertidas y otros caracteres especiales deben escaparse con una barra invertida.

4. Guarda y cierra el archivo `sftp.json`.
5. Pulsa `Ctrl+Shift+P` en Windows/Linux o `Cmd+Shift+P` en Mac para abrir la paleta de comandos.
6. Escribe `sftp` y verás el resto de comandos disponibles. Muchos de ellos también están en los menús contextuales del explorador de archivos del proyecto.
7. Uno bueno para empezar, si quieres sincronizar con una carpeta remota, es `SFTP: Download Project`: descarga el directorio indicado en `remotePath` de `sftp.json` a tu directorio local abierto.
8. Hecho — ya puedes editar localmente y, tras cada guardado, se subirá el archivo para mantener sincronizada la copia remota con la local.
9. ¡A disfrutar!

Para explicaciones detalladas visita el [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Configuraciones de ejemplo
Puedes ver la lista completa de opciones de configuración [aquí](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Simple](#simple)
- [Perfiles](#perfiles)
- [Contextos múltiples](#contextos-múltiples)
- [Conexión con saltos (hopping)](#conexión-con-saltos-hopping)
- [Configuración en los ajustes de usuario](#configuración-en-los-ajustes-de-usuario)
- [Borrados y renombrados seguros](#borrados-y-renombrados-seguros)
- [Cambios externos y verificación de carga](#cambios-externos-y-verificación-de-carga)

### Simple
```json
{
  "host": "host",
  "username": "usuario",
  "remotePath": "/remote/workspace"
}
```

### Perfiles
```json
{
  "username": "usuario",
  "password": "contraseña",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev",
      "uploadOnSave": true
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

_Nota:_ `context` y `watcher` solo están disponibles en el nivel raíz.

Usa `SFTP: Set Profile` para cambiar de perfil.

### Contextos múltiples
Los contextos **no deben ser iguales**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "usuario",
    "password": "contraseña",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "usuario",
    "password": "contraseña",
    "remotePath": "/remote/project/src"
  }
]
```

_Nota:_ `name` es obligatorio en este modo.

### Conexión con saltos (hopping)
Puedes conectarte a un servidor destino a través de un proxy con el protocolo ssh.

_Nota:_ la sustitución de variables no funciona dentro de una configuración `hop`.

#### Salto único
local -> salto -> destino
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // salto
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- El archivo de clave se asume en la máquina local.

  "hop": {
    // destino
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- El archivo de clave se asume en el salto.
  }
}
```

#### Saltos múltiples
local -> saltoA -> saltoB -> destino
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // saltoA
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- El archivo de clave se asume en la máquina local.

  "hop": [
    // saltoB
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- El archivo de clave se asume en el saltoA.
    },

    // destino
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- El archivo de clave se asume en el saltoB.
    }
  ]
}
```

### Configuración en los ajustes de usuario
Puedes usar `remote` para indicarle a sftp que tome la configuración de [remote-fs](https://github.com/liximomo/vscode-remote-fs).

En los ajustes de usuario:
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "usuario",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "usuario",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

En sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### Borrados y renombrados seguros
```json
{
  "host": "host",
  "username": "usuario",
  "remotePath": "/var/www/project",
  "ignoreTempFiles": true,
  "tempFilePatterns": ["*.generated.php"],
  "deleteRemoteOnLocalDelete": true,
  "deleteRemoteConfirmThreshold": 10,
  "renameRemoteOnLocalRename": true,
  "remoteTrash": {
    "enabled": true,
    "path": "/var/tmp/sftp-trash",
    "retentionDays": 14
  }
}
```

_Nota:_ todos estos valores son los que la extensión ya usa por defecto, salvo `tempFilePatterns`, `remoteTrash.path` (`.sftp-trash`) y `remoteTrash.retentionDays` (`7`); solo hace falta escribirlos para cambiarlos. Un `path` absoluto deja la papelera fuera del docroot que sirve el servidor web.

### Cambios externos y verificación de carga
```json
{
  "host": "host",
  "username": "usuario",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": false,
    "pollInterval": 0
  },
  "externalChanges": {
    "scanOnStartup": true,
    "scanOnResume": true,
    "confirmThreshold": 20,
    "maxPlanItems": 2000
  },
  "verifyUpload": "stat",
  "uploadRetries": 2
}
```

_Nota:_ `externalChanges`, `verifyUpload` y `uploadRetries` llevan aquí sus valores por defecto; el bloque `watcher` no es necesario para los escaneos (solo para reaccionar a los cambios en vivo y para `pollInterval`). `verifyUpload: "hash"` añade la comprobación de contenido y un `pollInterval` en milisegundos activa el sondeo periódico.

### Directorios que pertenecen al servidor
```json
{
  "host": "host",
  "username": "usuario",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "ignore": [".git", "node_modules"],
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

_Nota:_ `storage/` y `public/uploads/` nunca se suben, y borrarlos en local nunca los borra en el servidor, pero siguen pudiendo descargarse (`Download Folder`, `Sync Remote -> Local`); `*.env` no sale nunca de tu máquina. `Force Upload` sigue disponible para el caso excepcional.

## Explorador Remoto
![vista-previa-explorador-remoto](assets/showcase/remote-explorer.png)

El Explorador Remoto te permite explorar los archivos del servidor. Puedes abrirlo así:

1. Ejecuta el comando `View: Show SFTP`.
2. Haz clic en la vista SFTP de la barra de actividades.

Con el Explorador Remoto solo puedes ver el contenido de los archivos. Ejecuta el comando `SFTP: Edit in Local` para editarlos en local.

Desde la v1.16.5, los directorios enlazados simbólicamente en el remoto también son navegables.

### Selección múltiple
Puedes seleccionar varios archivos/carpetas a la vez en el servidor remoto para descargarlos o subirlos. Simplemente mantén pulsado Ctrl o Shift mientras seleccionas los archivos deseados, igual que en el explorador normal.

_Nota:_ si el explorador no se actualiza correctamente tras **eliminar** un archivo, refresca manualmente la carpeta padre.

### Orden
Puedes ordenar el Explorador Remoto agregando el parámetro `remoteExplorer.order` dentro de tu archivo de configuración `sftp.json`.

En sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- El valor por defecto es 0.
  }
}
```

## Depuración
1. Abre los ajustes de usuario.
  - En Windows/Linux: `File > Preferences > Settings`
  - En macOS: `Code > Preferences > Settings`
2. Activa `sftp.debug` (`true`) y recarga VS Code.
3. Consulta los logs en `View > Output > sftp`.

## FAQ
Puedes ver todas las preguntas frecuentes (en inglés) [aquí](./FAQ.md).

## Créditos y apoyo a los autores originales
Este fork se apoya en el trabajo de [@liximomo](https://github.com/liximomo) (autor original) y [@Natizyskunk](https://github.com/Natizyskunk) (mantenedor del fork del que este deriva). Si esta extensión te ha ayudado durante estos años, considera apoyarlos:

- Invítale un café a Natizyskunk: https://www.buymeacoffee.com/Natizyskunk
- PayPal: https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### Comunidad

- **Discusiones**: Únete a las conversaciones en [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions)
- **Contribuciones**: Revisa los [issues etiquetados como "good first issue"](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue)

---

## 📜 Licencia

Distribuido bajo la Licencia **MIT**. Ver [LICENSE](LICENSE) para más información.

> La licencia MIT te permite usar, copiar, modificar, fusionar, publicar, distribuir, sublicenciar y/o vender copias del software sin restricciones, siempre que se incluya el aviso de copyright.

---

## 👨‍💻 Autor

**Jose Alexis Correa Valencia**
*Full Stack Developer & Software Architect*

Con más de 25 años de experiencia en desarrollo de software empresarial, especializado en arquitecturas escalables y soluciones PHP modernas.

- **GitHub**: [@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn**: [Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **Email**: jalexiscv@gmail.com
- **Ubicación**: Colombia 🇨🇴

---

## ❤️ Donaciones

Si esta extensión te ha ayudado a ti o a tu negocio, considera apoyar su desarrollo y mantenimiento continuo.

| Método | Detalles |
|--------|----------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi (Colombia)** | `3117977281` |

### Beneficios de tu Soporte

Tu donación ayuda a:
- ⚡ Acelerar el desarrollo de nuevas funcionalidades
- 📚 Crear más documentación y ejemplos
- 🧪 Mejorar la cobertura de tests
- 🐛 Atender más correcciones del backlog de issues
- 🌍 Mantener el proyecto activo y actualizado

*¡Gracias por tu apoyo!* 🙏
