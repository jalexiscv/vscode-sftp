## FTP(s) configuration

### secure
Set to true for both control and data connection encryption. <br>
Set to `control` for control encryption only, or `implicit` for implicitly encrypted control connection (this mode is deprecated in modern times, but usually uses port 990).

| Key | Value | Default |
| --- | --- | --- |
| *secure* | *mixed* | `false` |

```json
{
  "secure": control
}
```

### secureOptions
Additional options to be passed to `tls.connect()`.

| 💡 Note |
| :--- |
| *See [TLS connect options callback](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).* | 

| Key | Value |
| --- | --- |
| *secureOptions* | *object* |

```json
{
  "secureOptions": {
    "enableTrace": true
  }
}
```

### Idle connections
Since 1.28.0 an FTP control connection that has not run a command for **five minutes** is closed (the keepalive `NOOP` does not count as use) and reopened, at the cost of one login, by the next operation. Shared hosts cap the sessions per IP — often 4 to 8 — and a connection per profile, per `sftp.json` entry and per window kept alive for the whole session is what used that cap up and earned `421 Too many connections`. A command that fails because the socket died reports the drop at once, and new attempts are then held for a growing delay (a minute at least after a `421`): see [Connection loss and reconnection](common_configuration.md#connection-loss-and-reconnection).
