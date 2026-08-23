# Verificación de carga por hash (`verifyUpload: "hash"`) con degradación automática

**Fecha:** 2026-08-22
**Área:** core

## Descripción

Fase 5 de
[02-analisis-cambios-externos-y-verificacion-carga.md](../02-analisis-cambios-externos-y-verificacion-carga.md)
(§3.5, nivel 2). La verificación por `stat` de
[2026-08-22_feat_verificacion_carga.md](2026-08-22_feat_verificacion_carga.md)
demuestra que el archivo remoto tiene el tamaño correcto; no que tenga el
contenido correcto. Un proxy transparente, un hook del servidor que reescribe
lo subido o una corrupción silenciosa que conserve el tamaño pasan esa prueba.
El nivel `hash` compara además un digest del archivo remoto con el del local.

El coste de calcular ese digest corre a cargo del servidor, y no todos pueden:
en SFTP hace falta una cuenta con shell (una cuenta solo-SFTP o un
`internal-sftp` enjaulado rechazan `exec`); en FTP hace falta que el servidor
anuncie un comando de digest en `FEAT`. Por eso el nivel `hash` **degrada** en
lugar de fallar: si el servidor no puede hashear, la subida se da por verificada
al nivel `stat` (que ya pasó), se deja constancia en `verification.reason` y se
avisa una sola vez por conexión. Solo un digest **distinto** es un fallo de
verificación, y entra en los reintentos de `uploadRetries` como cualquier otro.

### Algoritmos y comandos remotos

`HashAlgorithm` es `'sha256' | 'sha1' | 'md5' | 'crc32'`. Cada sistema de
archivos declara el más fuerte que sabe calcular (`supportsHash()`, sondeado
una vez por conexión y cacheado; las subidas en paralelo comparten la sonda) y
lo calcula bajo demanda (`hashFile(path, algorithm)`, hex en minúsculas).

| FS | Cómo | Orden de preferencia |
| :--- | :--- | :--- |
| Local | `crypto.createHash` en streaming; `crc32` con una tabla propia (Node solo trae `zlib.crc32` desde la v22) | Responde a cualquiera de los cuatro; `sha256` si se le pregunta a solas |
| SFTP | `SSHClient.exec` de una herramienta de checksum en el host final (con `hop`, el del último salto). La sonda ejecuta cada herramienta contra `/dev/null` y solo la acepta si devuelve el digest de la entrada vacía: así se comprueba a la vez que existe y que su salida se sabe leer (BusyBox no acepta `--version`) | `sha256sum` → `shasum -a 256` → `openssl dgst -sha256` → `md5sum`. Ninguna, o `exec` rechazado → `null` |
| FTP | `FEAT` una vez; el comando elegido se envía por la cola de concurrencia 1 del cliente. `HASH` (draft-bryan-ftpext-hash) negocia el algoritmo con `OPTS HASH <nombre>` salvo que ya sea el predeterminado (`*`); un `OPTS` rechazado pasa al siguiente candidato | `XSHA256` → `HASH SHA-256` → `XSHA1` → `HASH SHA-1` → `XMD5` → `HASH MD5` → `XCRC` → `HASH CRC32`. Nada en `FEAT` → `null` |

Al hashear en SFTP la ruta va entrecomillada para `sh` (comillas simples; `'`
se escapa como `'\''`), se exige código de salida 0 y se parsea el hex del
primer token (`sha256sum`, `shasum`, `md5sum`; se admite la `\` con que
coreutils ≥ 9 prefija los nombres escapados) o de lo que sigue a `= `
(`openssl`), validando longitud y alfabeto. En FTP se toma del texto de la
respuesta el primer token que sea hex de la longitud del algoritmo (`250
<hex>`, `250 <hex> <ruta>`, `213 SHA-256 0-<n> <hex> <ruta>`), y se pasa a
minúsculas (`XCRC` responde en mayúsculas).

### Secuencia en `TransferTask`

1. Ack del protocolo, conteo de bytes y verificación `stat` (tamaño remoto
   exacto, aviso de `mtime`), como hasta ahora. Un tamaño distinto falla ya
   aquí, sin pedir digest.
2. `supportsHash()` del FS destino. `null` (o una sonda que lanza) →
   `verification = { level: 'stat', ok: true, reason: 'hash not available on
   this server, verified by size' }` y un `logger.warn` la primera vez para ese
   FS (`WeakSet` por instancia, es decir, por conexión).
3. `hashFile` del destino (ruta final, nunca el `.new` de `useTempFile`) y del
   origen **en paralelo**. Si cualquiera lanza → `{ level: 'stat', ok: true,
   reason: 'hash check failed (<msg>), verified by size' }` con `warn` (no se
   reintenta: la subida es buena hasta donde `stat` alcanza).
4. Iguales → `{ level: 'hash', ok: true, algorithm }`. Distintos →
   `TransferVerificationError` con `reason` `hash mismatch (<algo>: local
   <8 hex>…, remote <8 hex>…)` y `verification = { level: 'hash', ok: false,
   reason, algorithm }`; `run()` reintenta y, agotados los intentos, rechaza.

## Tipo de Cambio

- `Agregado`

## Archivos Afectados

### [MODIFICADO] `src/core/fs/fileSystem.ts`
- `HashAlgorithm`, `HASH_HEX_LENGTH`, `isHashDigest()`.
- `supportsHash(): Promise<HashAlgorithm | null>` (por defecto `null`) y
  `hashFile(path, algorithm): Promise<string>` (por defecto rechaza con `hash
  not supported`), no abstractos.

### [NUEVO] `src/core/fs/crc32.ts`
- `Crc32` incremental (tabla IEEE 802.3, `update(chunk)` / `digest()` hex de 8
  dígitos) sin dependencias nuevas.

### [MODIFICADO] `src/core/fs/localFileSystem.ts`
- Docblock de clase (Conventions.md §5.1).
- `supportsHash()` → `'sha256'`; `hashFile` en streaming con `crypto` o
  `Crc32`.

### [MODIFICADO] `src/core/remote-client/sshClient.ts`
- `ExecResult` y `exec(command, timeout = 30000)`: `Client.exec` de ssh2 sobre
  `_client` (la conexión del último salto), recoge `stdout`/`stderr`/código de
  salida al cerrarse el canal, rechaza si el servidor rehúsa el `exec`, si el
  cliente no está conectado o al vencer el timeout (cerrando el canal). Un
  código distinto de 0 es respuesta, no rechazo.

### [MODIFICADO] `src/core/fs/sftpFileSystem.ts`
- Docblock de clase (§5.1).
- `SFTP_HASH_COMMANDS`, `quoteForShell()`, `supportsHash()` / `hashFile()` con
  la sonda cacheada por instancia y compartida entre llamadas concurrentes.

### [MODIFICADO] `src/core/fs/ftpFileSystem.ts`
- `FTP_HASH_COMMANDS`, `parseFtpDigest()`, `supportsHash()` / `hashFile()` con
  `FEAT` una vez, negociación `OPTS HASH` y todo a través de `run()`.

### [MODIFICADO] `src/core/transferTask.ts`
- `VerifyUploadLevel` admite `'hash'`; `TransferVerification.algorithm?`.
- `_verifyHash()` y `_degradeToStat()`; `_verificationError()` acepta campos
  extra; `_verifyLevel()` respeta `'hash'`. El resto de la clase no cambia.

### [MODIFICADO] `src/modules/config.ts`, `schema/definitions.json`
- `verifyUpload` acepta `'hash'` (Joi y `enum`), con la descripción ampliada
  sobre la degradación. El valor por defecto sigue siendo `'stat'`.

### [NUEVO] `src/core/__tests__/transferTaskHash-test.ts`
- 9 casos sobre el harness `memfs` + `LocalRemoteFileSystem`: digest
  coincidente (nivel `hash`, `algorithm`, `statSize` sigue llamándose),
  `useTempFile` hashea la ruta final, digest distinto (falla tras los
  reintentos con el `reason` de hash), tamaño distinto sin pedir digest,
  servidor sin hash (degradación, aviso una vez por FS), sonda que lanza,
  `hashFile` que lanza (degradación sin reintento), `'stat'` no pide digest,
  descargas ignoran `verifyUpload`.

### [NUEVO] `src/core/fs/__tests__/localFileSystem-test.ts`
- Vectores conocidos (`sha256('')`, `sha1('abc')`, `md5('abc')`,
  `crc32('123456789') === 'cbf43926'`), archivo de varios chunks, archivo
  ausente, `Crc32` por trozos y relleno a 8 dígitos.

### [NUEVO] `src/core/fs/__tests__/sftpFileSystem-test.ts`
- Elección y cacheo de la herramienta (orden, salida no fiable, `exec`
  rechazado, sonda compartida), entrecomillado para `sh`, prefijo `\` de
  coreutils, parseo de `openssl`, `md5sum` como último recurso, errores del
  comando y salida inesperada, `quoteForShell`.

### [NUEVO] `src/core/remote-client/__tests__/sshClient-test.ts`
- `exec` con un `Client` simulado: stdout/stderr/código, código ≠ 0, cierre
  sin estado, señal, `exec` rehusado, excepción síncrona, error de canal,
  timeout (cierra el canal e ignora lo que llegue después).

### [MODIFICADO] `src/core/fs/__tests__/ftpFileSystem-test.ts`
- `supportsHash` según `FEAT` simulado (preferencias, `HASH` con y sin
  `OPTS`, `OPTS` rechazado, nombres sin distinguir mayúsculas, `FEAT` vacío o
  fallido, sonda compartida), `hashFile` (`XSHA256`, `XMD5`/`XSHA1`, `XCRC`
  en mayúsculas, `HASH`, ruta con aspecto de hex, algoritmo no elegido,
  respuesta sin digest, 550) y `parseFtpDigest`.

### [MODIFICADO] `src/modules/__tests__/config-test.ts`
- `'hash'` pasa de rechazado a aceptado, sin cambiar el valor por defecto.

## Impacto

- **Opcional, sin cambio de comportamiento por defecto**: `verifyUpload` sigue
  en `"stat"`. Quien quiera la comprobación de contenido lo fija en
  `sftp.json`:

  ```json
  {
    "verifyUpload": "hash"
  }
  ```

- **Coste** por archivo subido, además del `stat`: en SFTP un canal `exec`
  (el servidor lee el archivo entero para hashearlo) más la lectura local; en
  FTP un comando de control (`XSHA256 …`, `HASH …`) más la lectura local. Las
  sondas (`sha256sum /dev/null`…, `FEAT`) se pagan una vez por conexión.
- **Degradación**: un servidor sin shell (SFTP) o sin comandos de digest
  (FTP) no rompe nada; la subida queda verificada por tamaño, con
  `verification.reason` explicándolo y un aviso en el canal de salida la
  primera vez. Lo mismo si el comando falla para un archivo concreto (permisos
  del shell distintos de los del SFTP, timeout de 30 s en un archivo enorme).
- Solo afecta a subidas; las descargas siguen contando bytes. Con `hop`, el
  `exec` corre en el host final (es la misma conexión que abre el canal SFTP);
  no se ha podido probar contra un servidor real con saltos.
- Sin cambios en comandos ni en la documentación de usuario; `docs/`, README
  y `CHANGELOG.md` raíz se actualizarán en la fase de cierre.
