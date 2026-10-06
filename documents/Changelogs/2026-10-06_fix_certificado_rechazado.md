# Un certificado rechazado se trata como fallo de conexión, con aviso y salida

**Fecha:** 2026-10-06
**Área:** core, modules, fileHandlers, docs

## Descripción

El usuario reportó que, contra el perfil FTPS de `ftp.dtacenter.com`, cada
guardado terminaba en un plan con `0 verified, 1 failed` en medio segundo y,
cada pocos minutos, este error sin más contexto en el canal de salida:

```
[error] Error: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca
    at TLSSocket.onConnectSecure (node:internal/tls/wrap:1775:34)
```

Su hipótesis era que la extensión ignoraba el certificado del servidor. Es
lo contrario: la extensión lo valida y lo rechaza. Comprobado con
`openssl s_client -starttls ftp`, el servidor envía solo su certificado
final (emitido por el intermedio YR2 de Let's Encrypt) sin el intermedio, y
node, a diferencia de un navegador, no descarga intermedios por su cuenta;
además, el certificado está emitido para `server02651.cloudhostservers.com`
y no para `ftp.dtacenter.com`. Con `secure: true` y
`rejectUnauthorized: true` ninguna conexión puede establecerse: el handshake
de la conexión de control falla antes de transferir nada.

El defecto de la extensión estaba en cómo trataba ese fallo. El código
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` no figuraba en la clasificación de
`connectionHealth.ts`, así que un certificado rechazado contaba como error de
*un archivo*, no de la conexión: la puerta de reintentos no se activaba, cada
guardado reconectaba de inmediato, cada ítem se marcaba `failed` (y el índice
con él) y cada fallo abría un diálogo con el error crudo de OpenSSL y la
pista de node sobre `--use-system-ca`, que nadie puede aplicar desde un
extension host. Justo el comportamiento anterior a 1.28.0 que la conexión
resiliente eliminó para los errores de red.

Ahora un certificado rechazado es un fallo de conexión más:

- `isCertificateError` reconoce los códigos de OpenSSL/tls
  (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`,
  `DEPTH_ZERO_SELF_SIGNED_CERT`, `CERT_HAS_EXPIRED`,
  `ERR_TLS_CERT_ALTNAME_INVALID`…) y sus mensajes, y
  `isConnectionLostError` lo incluye: la transferencia no reintenta, el plan
  pone los ítems `on hold`, el índice no se toca y no hay diálogo por archivo.
- La puerta retiene los intentos **un minuto como mínimo**
  (`CERTIFICATE_BACKOFF_MS`): un reintento no arregla un certificado.
- La capa de conexión (`remoteFs.ts`) relanza el error como
  `CertificateRejectedError`, que conserva el `code`, nombra el host y dice
  la salida: `[ftp.dtacenter.com]: certificate rejected: unable to verify
  the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Have the server
  send its complete certificate chain, issued for this host name, or accept
  the certificate unverified with "secureOptions": { "rejectUnauthorized":
  false } in sftp.json.` La pista de node desaparece. El canal de salida
  registra `[connection] host: certificate rejected: …` una vez por intento.
- Los avisos del plan y de los comandos distinguen el caso: en lugar de
  `connection to host lost (…) … will resume when it is back`, dicen
  `SFTP: host: certificate rejected: … N upload(s) of server are on hold
  until the certificate or the configuration is fixed.` seguido de la
  salida. El agregado de un comando pasa de `Connection lost while trying to
  upload (…)` a `Could not upload (certificate rejected: …)`.
- `connectionFailureReason` unifica el motivo de una línea que usan los
  ítems en espera, los logs y los avisos: la forma corta de un certificado,
  el error de espera tal cual, y el mensaje con su código cuando el mensaje
  lo había perdido (la misma regla que ya aplicaba la puerta).

No se ofrece todavía un "confiar en este certificado" al estilo de FileZilla
(fijar la huella en la configuración); queda como posible mejora.

## Tipo de Cambio

- `Corregido`
- `Cambiado`

## Archivos Afectados

### [MODIFICADO] `src/core/connectionHealth.ts`
- `TLS_CERTIFICATE_ERROR_CODES`, `CERTIFICATE_ERROR_MESSAGE`,
  `NODE_SYSTEM_CA_HINT`, `CERTIFICATE_HINT`, `CERTIFICATE_BACKOFF_MS`.
- `isCertificateError`, `describeCertificateError` (una línea, sin la pista
  de node, con el código si el mensaje no lo trae), clase
  `CertificateRejectedError` (`code`, `connectionLost`, `host`, `reason`,
  `cause`).
- `isConnectionLostError` incluye los certificados;
  `ConnectionGate.recordFailure` aplica el mínimo de un minuto.
- `shortReason` pasa a ser `connectionFailureReason`, exportada, y respeta
  `CertificateRejectedError` y `ConnectionOnHoldError`.

### [MODIFICADO] `src/core/remoteFs.ts`
- El rechazo de `connect` con un error de certificado se envuelve en
  `CertificateRejectedError` con el host de la conexión y se registra con
  `logger.warn` antes de pasar por la puerta.

### [MODIFICADO] `src/modules/planRunner.ts`
- `holdAll`, el `on hold:` de los ítems en vuelo y el motivo de `holdPlan`
  usan `connectionFailureReason`; `notifyOutage` recibe el error y da el
  aviso de certificado en lugar del de caída.

### [MODIFICADO] `src/fileHandlers/transfer/resume.ts`
- `assertTransferSucceeded` compone el agregado con
  `connectionFailureReason` y, para un certificado, `Could not <action>
  (…)` más la salida; `notifyOutage` recibe el error y distingue el caso; el
  log de `on hold` usa el motivo corto.

### [MODIFICADO] `src/core/__tests__/connectionHealth-test.ts`
- Tabla de códigos de certificado como fallo de conexión, detección por
  mensaje y negativos; `describeCertificateError`,
  `CertificateRejectedError`, la retención de un minuto (error envuelto y
  crudo) y `connectionFailureReason`.

### [MODIFICADO] `src/core/__tests__/remoteFs-test.ts`
- Un `connect` rechazado por certificado llega como
  `CertificateRejectedError` con host y salida, retiene los intentos 60 s
  con el motivo corto, y una configuración corregida es otra identidad.

### [MODIFICADO] `src/modules/__tests__/planRunner-test.ts`
- Un certificado rechazado deja el plan en espera con el motivo corto y un
  único aviso que dice qué hacer.

### [MODIFICADO] `src/fileHandlers/transfer/__tests__/transferResume-test.ts`
- Un comando contra un certificado rechazado se retiene y reanuda como ante
  una caída; el agregado y el aviso dicen qué hacer; el log lleva el motivo
  corto.

### [MODIFICADO] `docs/common_configuration.md`, `docs/configuration.md`, `docs/ftp_configuration.md`
- Párrafo *A certificate the client refuses* en *Connection loss and
  reconnection* y nota bajo `secureOptions` con las dos salidas
  (`rejectUnauthorized: false` o `ca` con el intermedio).

## Impacto

- Un servidor FTPS con la cadena incompleta, un certificado autofirmado o
  caducado, o un nombre que no coincide ya no marca archivos como fallidos
  ni abre un diálogo por guardado: los planes quedan en espera, los
  intentos se retienen un minuto y hay un aviso por servidor que explica el
  problema y las dos salidas (arreglar el certificado en el servidor o
  `secureOptions.rejectUnauthorized: false`).
- El plan en espera se reanuda solo hasta diez veces (una por minuto, como
  tope de la puerta) y después queda pendiente en *Upload plans*; al
  corregir `sftp.json` o el servidor, el siguiente guardado o reanudación lo
  saca adelante.
- Sin cambios en el esquema de `sftp.json` ni en los comandos. Suite de 957
  a 971 tests.
