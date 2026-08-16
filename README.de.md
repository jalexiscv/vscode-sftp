# SFTP — Synchronisierungs-Erweiterung für VS Code (korrigierter Fork)

🌍 [Español](README.md) (base) · [English](README.en.md) · [中文（简体）](README.zh-CN.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · **Deutsch**

[![Release](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-yellow.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**Korrigierter und von [@jalexiscv](https://github.com/jalexiscv) gepflegter Fork** der beliebten SFTP/FTP-Synchronisierungs-Erweiterung.<br>
Herkunft: Fork von [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), seinerseits ein Fork des nicht mehr gepflegten [SFTP-Plugins von liximomo](https://github.com/liximomo/vscode-sftp.git).

- 📦 **Installation (VSIX-Releases):** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Probleme melden:** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Vollständiges Änderungsprotokoll:** [CHANGELOG.md](CHANGELOG.md)

Mit VSCode-SFTP kannst du Dateien in einem lokalen Verzeichnis hinzufügen, bearbeiten oder löschen und sie über verschiedene Übertragungsprotokolle wie FTP oder SSH mit einem Verzeichnis auf einem Remote-Server synchronisieren. Die einfachste Konfiguration benötigt nur wenige Zeilen, und ein breites Spektrum spezifischer Optionen steht bereit, um die Bedürfnisse jedes Nutzers abzudecken. Leistungsstark und schnell zugleich, hilft sie Entwicklern Zeit zu sparen, indem sie einen vertrauten Editor und eine vertraute Umgebung nutzen können.

## 📑 Inhaltsverzeichnis

- [Warum es diesen Fork gibt](#warum-es-diesen-fork-gibt)
- [Was wir aktualisiert haben](#was-wir-aktualisiert-haben)
- [Neuerungen in v1.22.0](#neuerungen-in-v1220)
- [Was wir von dieser Version erwarten](#was-wir-von-dieser-version-erwarten)
- [Installation](#installation)
- [Dokumentation](#dokumentation)
- [Verwendung](#verwendung)
- [Beispielkonfigurationen](#beispielkonfigurationen)
- [Remote-Explorer](#remote-explorer)
- [Debugging](#debugging)
- [FAQ](#faq)
- [Credits und Unterstützung der ursprünglichen Autoren](#credits-und-unterstützung-der-ursprünglichen-autoren)
- [Lizenz](#-lizenz) · [Autor](#-autor) · [Spenden](#%EF%B8%8F-spenden)

---

## Warum es diesen Fork gibt

Wir haben diese Version veröffentlicht, weil das ursprüngliche Projekt — so hervorragend es war — einen Punkt erreicht hatte, an dem es seinen Nutzern nicht mehr dienen konnte:

1. **Das Upstream-Projekt ist faktisch unbetreut.** Sein Betreuer erklärte im März 2025, dass er nicht weiter daran arbeiten könne und dass die [v1.16.3 (Juni 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) als letzte stabile Version zu betrachten sei. Seitdem haben sich ~600 unkorrigierte Issues angesammelt.
2. **Die Erweiterung funktionierte in modernen VS-Code-Versionen nicht mehr.** Aktuelle VS-Code-Versionen enthalten eine Node.js-Laufzeit, in der die gebündelte Abhängigkeit `ssh2` 1.13 mit `TypeError: isDate is not a function` fehlschlägt, wodurch jede SFTP-Operation scheitert — der am häufigsten gemeldete Bug des Projekts (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **Der Entwicklungszweig des Upstreams ließ sich nicht einmal kompilieren.** Sein `develop`-Branch hatte TypeScript-Kompilierungsfehler und eine kaputte Test-Suite, sodass Korrekturen aus der Community (mehrere davon vor Jahren als Pull Requests eingereicht) keinen Weg zur Veröffentlichung hatten.
4. **Es gab ein ungelöstes Sicherheitsproblem.** Mit der Standardkonfiguration konnte das Synchronisieren eines Projekts `.vscode/sftp.json` — mit Host, Benutzer und Passwort des Servers — auf den Remote-Server hochladen, oft in ein öffentliches Docroot.

Statt zuzulassen, dass ein von Tausenden Entwicklern genutztes Werkzeug verfällt, haben wir es geforkt, sein Fundament repariert (Build, Tests, Linter), die am häufigsten gemeldeten Bugs behoben und uns verpflichtet, es funktionsfähig zu halten.

## Was wir aktualisiert haben

Jede Korrektur wurde vor der Veröffentlichung verifiziert (sauberer Webpack-Build, 187/187 Tests, Linter ohne Fehler). Die Details zu jeder Änderung finden sich in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — Fundament und kritische Korrekturen

| Bereich | Korrektur |
|------|------------|
| **Kompatibilität** | `ssh2` auf 1.17.0 aktualisiert: behebt *"isDate is not a function"* in modernen VS-Code-Versionen und ermöglicht moderne OpenSSH-Schlüsselformate sowie rsa-sha2-Algorithmen (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Sicherheit** | `.vscode/sftp.json` (Zugangsdaten) kann nun nie mehr auf den Server hochgeladen werden, unabhängig von der `ignore`-Konfiguration |
| **Zuverlässigkeit** | Automatische Wiederverbindung nach einem serverseitigen Schließen des SFTP-Kanals, statt endlos zu hängen (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Behoben: *"Error: Config Not Found"* / nicht funktionierendes `uploadOnSave`, wenn sich die Groß-/Kleinschreibung des gemeldeten Pfads vom Workspace unterschied (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | Die `ignore`-Muster funktionieren jetzt wirklich (der gitignore-Matcher erhielt Pfade mit `\`-Trennzeichen) |
| **Konfiguration** | `sftp.json` wird neu geladen, wenn es sich außerhalb des Editors ändert — z. B. bei einem Git-Branch-Wechsel (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Nicht-ASCII-Dateinamen (Chinesisch, Akzente) kommen in den Verzeichnislisten nicht mehr beschädigt an (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), ohne dessen SFTP-Regression) |
| **FTP** | Von proftpd-Servern mit `mod_rename` mit 550 abgelehnte Überschreibungen werden sicher erneut versucht (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | Die Kompilierung des Codes wurde wiederhergestellt, die Test-Infrastruktur repariert (Jest 29, Node 22) und alle vorbestehenden Lint-Verstöße bereinigt |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — zweite Runde

| Bereich | Korrektur |
|------|------------|
| **SSH** | `Open SSH in Terminal` verwendet jetzt die konfigurierte `hop`-Kette über OpenSSH ProxyJump (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Remote-Explorer** | Remote-Symlinks, die auf Verzeichnisse zeigen, sind über SFTP navigierbar — z. B. Deployments wie `current -> releases/N` (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` wird jetzt beim Speichern von Notebook-Dokumenten wie `.ipynb` ausgelöst |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — sichere Passwörter und CI

| Bereich | Änderung |
|---------|----------|
| **Sicherheit** | **Sicheres Speichern von Passwörtern** mit dem SecretStorage von VS Code (dem Schlüsselbund des Systems): Nach einer erfolgreichen Verbindung bietet die Erweiterung an, das eingegebene Passwort zu merken, injiziert es bei späteren Verbindungen automatisch und vergisst es, wenn der Server es ablehnt. Neuer Befehl `SFTP: Forget Saved Passwords` und Einstellung `sftp.promptToSavePassword` |
| **Qualität** | GitHub-Actions-CI (Lint, Build und Tests bei jedem Push/PR) und automatisierte Releases beim Setzen eines Tags |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — modernes FTP

| Bereich | Änderung |
|---------|----------|
| **FTP** | **FTP-Backend vom aufgegebenen Paket `ftp` (~10 Jahre ohne Wartung) auf [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp) migriert**: natives UTF-8, robustes FTPS und zuverlässiger Passivmodus. Gegen einen echten FTPS-Server mit einem neuen Integrationstest validiert (`ftp`-Baseline: 7/8 mit `read ECONNRESET`; `basic-ftp`: 8/8). Behebt das FTP-Fehlercluster des Backlogs (PASV, FTPS mit FileZilla, Nicht-ASCII-Namen, ECONNRESET) |
| **Hinweis** | `basic-ftp` unterstützt nur den Passivmodus; der aktive FTP-Modus (`passive: false`) wird nicht mehr unterstützt |

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — Verbindungsmanager

| Bereich | Änderung |
|---------|----------|
| **UI** | **Neuer Verbindungsmanager** (`SFTP: Open Connection Manager`, auch über das Zahnrad der Remote-Explorer-Ansicht): grafisches Panel zum Erstellen, Bearbeiten, Duplizieren, Löschen, Testen und Aktivieren der Verbindungen/Profile aus `sftp.json`, ohne das JSON von Hand zu bearbeiten. Beim Speichern werden die Dienste automatisch neu geladen; „Verbindung testen" nutzt die echte Verbindungslogik (inklusive gespeicherter Passwörter) |
| **Qualität** | TypeScript-`strict`-Modus aktiviert (`noImplicitAny` zurückgestellt) und 26 echte Typfehler behoben, darunter ein latenter Absturz im Profilstatus-Observer |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — stabiles aktives Profil und Ausschluss temporärer Dateien

| Bereich | Änderung |
|---------|----------|
| **Übertragungen** | Jede Datei und jeder Ordner, deren Name `.tmp` enthält, wird dauerhaft von den Übertragungen ausgeschlossen (Uploads, `uploadOnSave` und Sync), auf allen Servern und ohne jegliche `ignore`-Konfiguration |
| **Profile** | Das mit `SFTP: Set Profile` oder dem Verbindungsmanager aktivierte Profil „wechselt nicht mehr von selbst": das Neuladen von `sftp.json` setzt es nicht mehr auf das `defaultProfile` zurück, und die Auswahl bleibt über VSCode-Neustarts hinweg erhalten. `defaultProfile` ist nur noch der Anfangswert und die Rückfallebene, wenn das aktive Profil verschwindet |

## Neuerungen in v1.22.0

Bei v1.22.0 geht es darum, dass der Server wirklich abbildet, was lokal passiert — und dass auf deinem Rechner bleibt, was ihn nie hätte verlassen dürfen.

| Neuerung | Was sie bringt |
|----------|----------------|
| **Temporäre Dateien werden nie hochgeladen** | Eine eingebaute Liste schließt Swap- und Backup-Dateien der Editoren (vim, emacs), Sperrdateien von Office und LibreOffice, Merge-Überbleibsel (`*.orig`, `*.rej`, `*.bak`), unvollständige Downloads (`*.part`, `*.crdownload`) und System-Metadaten (`.DS_Store`, `Thumbs.db`, `desktop.ini`) aus — auf allen Servern und ohne jede Konfiguration. Mit `ignoreTempFiles` abschaltbar und mit `tempFilePatterns` erweiterbar; Abhängigkeits-Lockdateien wie `composer.lock` werden normal übertragen |
| **Lokale Löschungen werden auf den Server gespiegelt** | `deleteRemoteOnLocalDelete` (standardmäßig aktiv) erfasst Dateien und Ordner, egal ob du im VS-Code-Explorer, in einem Terminal oder mit einem externen Werkzeug löschst, und braucht kein `watcher.files`-Glob. Vier Schutzmechanismen verhindern böse Überraschungen (siehe unten) |
| **Remote-Papierkorb mit Rückgängig** | Mit `remoteTrash` ist ein Löschen ein serverseitiges `rename` in einen Papierkorb-Ordner: Das kostet keine Bandbreite und lässt sich mit `SFTP: Undo Last Remote Deletion` zurücknehmen. Dazu kommen `SFTP: Restore from Remote Trash` und `SFTP: Empty Remote Trash`; abgelaufene Einträge werden nach `retentionDays` von selbst bereinigt |
| **Umbenennen und Verschieben werden als `rename` gespiegelt** | `renameRemoteOnLocalRename` benennt auf dem Server um, statt die Datei erneut hochzuladen und die alte zu löschen: Die Datei behält ihre Remote-Identität, und es gibt keinen Moment, in dem der Pfad in einem produktiven Document-Root fehlt |
| **Aktivitätsansicht** | Eine zweite Ansicht in der SFTP-Seitenleiste mit dem Verlauf jeder Übertragung, Löschung und Umbenennung: Typ, Status, Uhrzeit, Pfad, Profil, Dauer und Fehler. Fehlgeschlagene Vorgänge lassen sich einzeln oder alle auf einmal wiederholen; ausblendbar über die Einstellung `sftp.showActivityView` |
| **Pausenmodus** | `SFTP: Pause/Resume Auto Sync` setzt die gesamte automatische Synchronisierung aus — `uploadOnSave`, `downloadOnOpen`, den Watcher sowie die Spiegelung von Löschungen und Umbenennungen — während explizite Befehle weiterhin funktionieren. Der Zustand wird pro Workspace gespeichert und in der Statusleiste angezeigt |

### Die vier Schutzmechanismen beim Löschen

| Schutzmechanismus | Verhalten |
|-------------------|-----------|
| **Sammelbestätigung** | Ein Stapel größer als `deleteRemoteConfirmThreshold` (Standard 10) öffnet einen modalen Dialog mit der Dateiliste und tut ohne Bestätigung nichts |
| **Git-Bewusstsein** | Löschungen, die durch eine Git-Operation ausgelöst wurden (checkout, rebase, merge, stash…), werden verworfen: Ein Branch-Wechsel rührt den Server nie an |
| **Selbstunterdrückung** | Löschungen, die das eigene `Sync Remote -> Local --delete` beim Aufräumen überzähliger lokaler Dateien verursacht, werden unterdrückt, statt zum Server zurückzuprallen |
| **Remote-Papierkorb** | Mit `remoteTrash` ist eine Löschung ein umkehrbares Verschieben in den Papierkorb des Servers statt eines `unlink` |

## Was wir von dieser Version erwarten

- **Ein direkter Ersatz (drop-in).** Dasselbe `sftp.json`-Format, dieselben Befehle, dieselben Arbeitsabläufe — bestehende Konfigurationen funktionieren ohne jegliche Migration.
- **Stabilität auf aktuellem Tooling.** Die Erweiterung muss auf aktuellen VS-Code-Versionen und Node.js-Laufzeiten weiter funktionieren — genau dort, wo das Original kaputtging.
- **Sicherheit als Standard.** Deine Zugangsdaten verlassen deine Maschine niemals als Teil einer Synchronisierung, selbst mit einer angepassten oder leeren `ignore`-Liste.
- **Ein lebendiges Projekt.** Wir werden den Backlog des Upstreams weiter triagieren (Wünsche wie SOCKS5-Proxys, `.ppk`-Schlüssel oder Ordner-Diff sind Kandidaten für kommende Runden), und Issues/PRs in [unserem Tracker](https://github.com/jalexiscv/vscode-sftp/issues) sind willkommen.
- **Nachprüfbare Qualität.** Kein Release wird ohne sauberen Build, grüne Test-Suite und fehlerfreien Linter veröffentlicht; jede Änderung wird in [documents/Changelogs](documents/Changelogs/CHANGELOG.md) dokumentiert.

---

## Installation

> ⚠️ **Deinstalliere oder deaktiviere zuerst jede andere SFTP-Erweiterung** (die von liximomo oder die von Natizyskunk): Sie registrieren dieselben `sftp.*`-Befehle und geraten mit dieser in Konflikt.

1. Lade die neueste `sftp-x.y.z.vsix` von der [Releases-Seite](https://github.com/jalexiscv/vscode-sftp/releases) herunter.
2. Öffne in VS Code die Erweiterungen (Ctrl + Shift + X).
3. Öffne das Menü "Weitere Aktionen" (die Auslassungspunkte oben) und wähle "Aus VSIX installieren…".
4. Suche die VSIX-Datei und wähle sie aus.
5. Lade VS Code neu.
6. Fertig!

Oder über die Kommandozeile:

```
code --install-extension sftp-1.22.0.vsix
```

## Dokumentation
- [Startseite](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Einstellungen](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Allgemeine Konfiguration](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP-Konfiguration](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP-Konfiguration](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Befehle](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> Das Upstream-Wiki (auf Englisch) bleibt die Referenz für Einstellungen und Befehle: Dieser Fork behält volle Konfigurationskompatibilität bei.

## Verwendung
Wenn die aktuellsten Dateien bereits auf einem Remote-Server liegen, kannst du mit einem leeren lokalen Ordner beginnen, das Projekt herunterladen und von dort aus synchronisieren.

1. Öffne in `VS Code` das lokale Verzeichnis, das du mit dem Remote-Server synchronisieren möchtest (oder erstelle ein leeres Verzeichnis, in das du zuerst den Inhalt eines Server-Ordners herunterlädst, um ihn lokal zu bearbeiten).
2. Drücke `Ctrl+Shift+P` unter Windows/Linux oder `Cmd+Shift+P` auf dem Mac, um die Befehlspalette zu öffnen, und führe den Befehl `SFTP: config` aus.
3. Eine grundlegende Konfigurationsdatei namens `sftp.json` erscheint im Verzeichnis `.vscode`; öffne sie und trage in die Parameter die Daten deines Remote-Servers ein.

Zum Beispiel:
```json
{
    "name": "Profilname",
    "host": "host_des_remote_servers",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "benutzername",
    "remotePath": "/public_html/project", // <--- Dies ist der Pfad, der mit "Download Project" heruntergeladen wird
    "password": "passwort",
    "uploadOnSave": false
}
```
Der Parameter `password` in `sftp.json` ist optional; lässt du ihn weg, wirst du beim Synchronisieren nach dem Passwort gefragt.
_Hinweis:_ Backslashes und andere Sonderzeichen müssen mit einem Backslash maskiert werden.

4. Speichere und schließe die Datei `sftp.json`.
5. Drücke `Ctrl+Shift+P` unter Windows/Linux oder `Cmd+Shift+P` auf dem Mac, um die Befehlspalette zu öffnen.
6. Tippe `sftp`, um die übrigen verfügbaren Befehle zu sehen. Viele davon finden sich auch in den Kontextmenüs des Datei-Explorers des Projekts.
7. Ein guter Einstieg, wenn du mit einem Remote-Ordner synchronisieren möchtest, ist `SFTP: Download Project`: Er lädt das in `remotePath` von `sftp.json` angegebene Verzeichnis in dein geöffnetes lokales Verzeichnis herunter.
8. Fertig — du kannst nun lokal bearbeiten, und nach jedem Speichern wird die Datei hochgeladen, um die Remote-Kopie mit der lokalen synchron zu halten.
9. Viel Spaß!

Ausführliche Erklärungen findest du im [Wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Beispielkonfigurationen
Die vollständige Liste der Konfigurationsoptionen findest du [hier](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Einfach](#einfach)
- [Profile](#profile)
- [Mehrere Kontexte](#mehrere-kontexte)
- [Verbindung mit Sprüngen (Hopping)](#verbindung-mit-sprüngen-hopping)
- [Konfiguration in den Benutzereinstellungen](#konfiguration-in-den-benutzereinstellungen)
- [Sicheres Löschen und Umbenennen](#sicheres-löschen-und-umbenennen)

### Einfach
```json
{
  "host": "host",
  "username": "benutzername",
  "remotePath": "/remote/workspace"
}
```

### Profile
```json
{
  "username": "benutzername",
  "password": "passwort",
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

_Hinweis:_ `context` und `watcher` sind nur auf der obersten Ebene verfügbar.

Verwende `SFTP: Set Profile`, um das Profil zu wechseln.

### Mehrere Kontexte
Die Kontexte **dürfen nicht identisch sein**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "benutzername",
    "password": "passwort",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "benutzername",
    "password": "passwort",
    "remotePath": "/remote/project/src"
  }
]
```

_Hinweis:_ `name` ist in diesem Modus erforderlich.

### Verbindung mit Sprüngen (Hopping)
Du kannst dich über einen Proxy mit dem SSH-Protokoll mit einem Zielserver verbinden.

_Hinweis:_ Die Variablenersetzung funktioniert innerhalb einer `hop`-Konfiguration nicht.

#### Einzelner Sprung
lokal -> Sprung -> Ziel
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // Sprung
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- Die Schlüsseldatei wird auf der lokalen Maschine erwartet.

  "hop": {
    // Ziel
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- Die Schlüsseldatei wird auf dem Sprung-Server erwartet.
  }
}
```

#### Mehrere Sprünge
lokal -> SprungA -> SprungB -> Ziel
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // SprungA
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- Die Schlüsseldatei wird auf der lokalen Maschine erwartet.

  "hop": [
    // SprungB
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- Die Schlüsseldatei wird auf SprungA erwartet.
    },

    // Ziel
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- Die Schlüsseldatei wird auf SprungB erwartet.
    }
  ]
}
```

### Konfiguration in den Benutzereinstellungen
Du kannst `remote` verwenden, um sftp anzuweisen, die Konfiguration aus [remote-fs](https://github.com/liximomo/vscode-remote-fs) zu übernehmen.

In den Benutzereinstellungen:
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "benutzername",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "benutzername",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

In sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### Sicheres Löschen und Umbenennen
```json
{
  "host": "host",
  "username": "benutzername",
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

_Hinweis:_ Alle diese Werte sind jene, die die Erweiterung bereits standardmäßig verwendet, außer `tempFilePatterns`, `remoteTrash.path` (`.sftp-trash`) und `remoteTrash.retentionDays` (`7`); du musst sie nur eintragen, um sie zu ändern. Ein absoluter `path` hält den Papierkorb außerhalb des vom Webserver ausgelieferten Document-Roots.

## Remote-Explorer
![remote-explorer-vorschau](assets/showcase/remote-explorer.png)

Der Remote-Explorer ermöglicht dir, die Dateien des Servers zu durchsuchen. Du kannst ihn so öffnen:

1. Führe den Befehl `View: Show SFTP` aus.
2. Klicke auf die SFTP-Ansicht in der Aktivitätsleiste.

Mit dem Remote-Explorer kannst du nur den Inhalt der Dateien ansehen. Führe den Befehl `SFTP: Edit in Local` aus, um sie lokal zu bearbeiten.

Seit v1.16.5 sind auch symbolisch verlinkte Verzeichnisse auf dem Remote-Server navigierbar.

### Mehrfachauswahl
Du kannst mehrere Dateien/Ordner auf dem Remote-Server gleichzeitig auswählen, um sie herunter- oder hochzuladen. Halte einfach Ctrl oder Shift gedrückt, während du die gewünschten Dateien auswählst — genau wie im normalen Explorer.

_Hinweis:_ Wenn der Explorer nach dem **Löschen** einer Datei nicht korrekt aktualisiert wird, aktualisiere den übergeordneten Ordner manuell.

### Sortierung
Du kannst den Remote-Explorer sortieren, indem du den Parameter `remoteExplorer.order` in deiner Konfigurationsdatei `sftp.json` hinzufügst.

In sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- Der Standardwert ist 0.
  }
}
```

## Debugging
1. Öffne die Benutzereinstellungen.
  - Unter Windows/Linux: `File > Preferences > Settings`
  - Unter macOS: `Code > Preferences > Settings`
2. Aktiviere `sftp.debug` (`true`) und lade VS Code neu.
3. Sieh dir die Logs unter `View > Output > sftp` an.

## FAQ
Alle häufig gestellten Fragen (auf Englisch) findest du [hier](./FAQ.md).

## Credits und Unterstützung der ursprünglichen Autoren
Dieser Fork baut auf der Arbeit von [@liximomo](https://github.com/liximomo) (ursprünglicher Autor) und [@Natizyskunk](https://github.com/Natizyskunk) (Betreuer des Forks, von dem dieser abstammt) auf. Wenn dir diese Erweiterung in all den Jahren geholfen hat, erwäge, sie zu unterstützen:

- Spendiere Natizyskunk einen Kaffee: https://www.buymeacoffee.com/Natizyskunk
- PayPal: https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### Community

- **Diskussionen**: Beteilige dich an den Gesprächen in den [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions)
- **Beiträge**: Sieh dir die [mit "good first issue" gekennzeichneten Issues](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue) an

---

## 📜 Lizenz

Veröffentlicht unter der **MIT**-Lizenz. Siehe [LICENSE](LICENSE) für weitere Informationen.

> Die MIT-Lizenz erlaubt dir, Kopien der Software ohne Einschränkungen zu verwenden, zu kopieren, zu verändern, zusammenzuführen, zu veröffentlichen, zu verbreiten, zu unterlizenzieren und/oder zu verkaufen, sofern der Copyright-Hinweis enthalten ist.

---

## 👨‍💻 Autor

**Jose Alexis Correa Valencia**
*Full Stack Developer & Software Architect*

Mit über 25 Jahren Erfahrung in der Entwicklung von Unternehmenssoftware, spezialisiert auf skalierbare Architekturen und moderne PHP-Lösungen.

- **GitHub**: [@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn**: [Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **E-Mail**: jalexiscv@gmail.com
- **Standort**: Kolumbien 🇨🇴

---

## ❤️ Spenden

Wenn diese Erweiterung dir oder deinem Unternehmen geholfen hat, erwäge, ihre laufende Entwicklung und Pflege zu unterstützen.

| Methode | Details |
|--------|----------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi (Kolumbien)** | `3117977281` |

### Vorteile deiner Unterstützung

Deine Spende hilft dabei:
- ⚡ Die Entwicklung neuer Funktionen zu beschleunigen
- 📚 Mehr Dokumentation und Beispiele zu erstellen
- 🧪 Die Testabdeckung zu verbessern
- 🐛 Mehr Korrekturen aus dem Issue-Backlog anzugehen
- 🌍 Das Projekt aktiv und aktuell zu halten

*Danke für deine Unterstützung!* 🙏
