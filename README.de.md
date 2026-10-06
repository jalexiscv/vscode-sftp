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
- [Neuerungen in v1.30.0](#neuerungen-in-v1300)
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

Jede Korrektur wurde vor der Veröffentlichung verifiziert (sauberer Webpack-Build, 957 Tests, Linter ohne Fehler). Die Details zu jeder Änderung finden sich in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

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

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — sicherer Lokal-Remote-Spiegel

| Bereich | Änderung |
|---------|----------|
| **Übertragungen** | Temporäre Dateien werden nie hochgeladen: Eine eingebaute Liste schließt Swap- und Backup-Dateien der Editoren, Office-Sperrdateien, Merge-Überbleibsel, unvollständige Downloads und System-Metadaten aus, auf allen Servern und ohne Konfiguration (`ignoreTempFiles`, `tempFilePatterns`) |
| **Löschungen** | Lokale Löschungen werden auf den Server gespiegelt (`deleteRemoteOnLocalDelete`, standardmäßig aktiv), mit vier Schutzmechanismen: modale Bestätigung oberhalb von `deleteRemoteConfirmThreshold` (10), durch Git verursachte Löschungen werden verworfen, Selbstunterdrückung während `Sync Remote -> Local --delete` und Remote-Papierkorb |
| **Remote-Papierkorb** | Mit `remoteTrash` ist Löschen ein serverseitiges `rename` in einen Papierkorb-Ordner, umkehrbar mit `SFTP: Undo Last Remote Deletion` und `SFTP: Restore from Remote Trash`; `SFTP: Empty Remote Trash` leert ihn, und Abgelaufenes wird nach `retentionDays` bereinigt |
| **Umbenennungen** | `renameRemoteOnLocalRename` spiegelt Umbenennen und Verschieben als serverseitiges `rename`, ohne erneuten Upload und ohne einen Moment, in dem der Pfad auf dem Server fehlt |
| **UI** | Aktivitätsansicht mit dem Verlauf jeder Übertragung, Löschung und Umbenennung samt Wiederholungen (`sftp.showActivityView`); Pausenmodus (`SFTP: Pause/Resume Auto Sync`), der die gesamte automatische Synchronisierung aussetzt |
| **Härtung** | Zwei adversariale Review-Durchgänge vor der Veröffentlichung: Git-Schutz beim Einreihen ausgewertet, ein einziger Löschpfad, unsichere Papierkorb-Pfade abgelehnt, Profil der Löschung beim Wiederherstellen und Bereinigen beachtet, Bereinigung, die das Remote-Verzeichnis selbst durchsucht |

### [v1.24.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.24.0) — externe Änderungen und Upload-Verifizierung

| Bereich | Änderung |
|---------|----------|
| **Externe Änderungen** | Ein persistenter Sync-Index merkt sich pro Server, welche Version jeder Datei zuletzt hochgeladen und verifiziert wurde; der lokale Baum wird beim Start, beim Neuladen von `sftp.json`, beim Fortsetzen, beim Zurückkehren des Fokus nach fünf Minuten, auf Abruf (`SFTP: Scan for External Changes`) und optional periodisch (`watcher.pollInterval`) damit verglichen, sodass Änderungen außerhalb des Editors — oder bei geschlossenem VS Code — über einen Plan hochgeladen werden, ohne den Server aufzulisten. `SFTP: Rebuild Sync Index` baut den Index bei der ersten Verwendung auf; Schlüssel `externalChanges.scanOnStartup`, `scanOnResume`, `confirmThreshold` |
| **Ein einziger Änderungssammler** | `uploadOnSave` und der Watcher laden dasselbe Speichern nicht mehr zweimal hoch: Editor-Speicherungen gehen sofort hoch, externe Änderungen werden gebündelt (700 ms) und pro Pfad dedupliziert |
| **Upload-Pläne** | Jeder Stapel ist ein Plan (Ursprung, Grund pro Datei, Status, Versuche, Fehler) in der Gruppe „Upload plans" der Aktivitätsansicht, mit `SFTP: Preview Upload (Dry Run)`, `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` und `SFTP: Clear Upload Plans`; die Statusleiste zeigt `↑N` ausstehende und `✗N` fehlgeschlagene Uploads. Oberhalb von `externalChanges.confirmThreshold` (20), nach einer Git-Operation oder wenn der Stapel dem Index unbekannte Dateien enthält, fragt zuerst ein modaler Dialog (`Review plan`, `Upload N file(s)`, `Skip` — und `Skip` wird gemerkt) |
| **Upload-Verifizierung** | Jeder Upload zählt die gesendeten Bytes und prüft mit `verifyUpload: "stat"` (Standard), dass die Remote-Größe exakt übereinstimmt; `"hash"` vergleicht zusätzlich einen Digest über SSH oder FTP und fällt auf `stat` zurück, wenn der Server ihn nicht berechnen kann. Vorübergehende Fehlschläge werden wiederholt (`uploadRetries`, 2), dauerhafte Fehler nicht |
| **Persistentes Aktivitätsprotokoll** | Jede Aufgabe — aus einem Befehl, einem Speichern oder dem Watcher — wird mit Remote-Pfad und Verifizierungsergebnis protokolliert und überlebt das Neuladen des Fensters (`activity-log.json`); auch Fehler vor der Übertragung (Verbindung, Zugangsdaten, Berechtigungen) erscheinen |
| **Korrekturen und Härtung** | `uploadFile()` lehnt ab, wenn die Übertragung fehlschlägt; die Unterdrückung der automatischen Synchronisierung während Downloads greift tatsächlich; `dir/`-Muster in `ignore` beschneiden den Teilbaum; Symlink-Schleifen werden unterbrochen; numerische SFTP-Fehler werden beschrieben. Zwei adversariale Reviews vor der Veröffentlichung; bis der Index aufgebaut ist, laden automatische Scans nur erneut hoch, was die Erweiterung selbst hochgeladen hat |

### [v1.25.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.25.0) — Nur-Upload-Ausschluss

| Bereich | Änderung |
|---------|----------|
| **Nur-Upload-Ausschluss (`uploadExclude`)** | Eine Liste von gitignore-Mustern, mit derselben Syntax und Verankerung wie `ignore`, die nie zum Server wandert: `Upload File` / `Upload Folder` / `Upload Project`, `uploadOnSave`, der Watcher, Scans und Pläne, `Upload Changed Files` und `Sync Local -> Remote` (mit `syncOption.delete` wird die Remote-Kopie auch nicht gelöscht). In einem Profil wird sie zur Basisliste hinzugefügt |
| **Der Server behält seine Kopie** | Einen ausgeschlossenen Pfad lokal zu löschen oder umzubenennen lässt den Server unberührt (`deleteRemoteOnLocalDelete`, `renameRemoteOnLocalRename`, `watcher.autoDelete`); `Rebuild Sync Index` beschneidet ihn auf beiden Seiten |
| **Was sich nicht ändert** | Downloads, `Sync Remote -> Local`, der Remote-Explorer und der Diff sehen diese Pfade weiterhin; `Force Upload` umgeht die Liste, wie es `ignore` umgeht. Ein Upload-Befehl auf einen ausgeschlossenen Pfad meldet das in einer Benachrichtigung und verbindet sich nicht; `Upload Changed Files` listet die beiseitegelegten Dateien in einer eigenen Gruppe |
| **Korrektur** | Eine lokale Löschung, deren `dir/`-Muster in `ignore` nur als Verzeichnis passt, wird nicht mehr auf den Server gespiegelt: Der gelöschte Pfad wird jetzt sowohl als Datei als auch als Verzeichnis geprüft |

### [v1.26.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.26.0) — Als hochgeladen markieren und Ausschlüsse aus der Oberfläche

| Bereich | Änderung |
|---------|----------|
| **Als hochgeladen markieren (`Mark as uploaded`)** | Ein vierter Button im Bestätigungsdialog jedes Plans sowie `Mark Plan as Uploaded` / `Mark as Uploaded` auf einem Plan oder einer Datei in der Aktivitätsansicht: Die Dateien werden im Index als bereits auf dem Server vorhanden vermerkt, in ihrer aktuellen Version, ohne Übertragung, und erst wieder vorgeschlagen, wenn sie sich ändern. Eigener Status `assumed`, in Zusammenfassungen, Berichten und Symbolen von `verified` unterschieden |
| **Index säen, ohne den Server aufzulisten** | `SFTP: Mark Local Files as Uploaded` (auch `Mark all as uploaded` im Hinweis zum nicht gebauten Index) durchläuft den lokalen Baum, zeigt die Anzahl und sät nach Bestätigung den Index mit allem, was lokal liegt; ab dann wird nur vorgeschlagen, was sich ändert. Die schnelle Alternative zu `Rebuild Sync Index` für Sites mit Zehntausenden Dateien über FTP |
| **Upload-Ausschlüsse aus der Oberfläche** | Rechtsklick auf einen Ordner → `SFTP: Exclude from Upload` (und `SFTP: Include in Upload Again` auf einem ausgeschlossenen), `SFTP: Manage Upload Exclusions` zum Prüfen, Hinzufügen und Entfernen von Einträgen sowie eine Liste mit `×` im Verbindungsmanager. Alle schreiben die Liste `uploadExclude` in `sftp.json` und behalten deren Formatierung bei |
| **Sicherheit** | Die Zeile `config at …` im Ausgabekanal maskierte das Passwort der Basis, nicht aber das jedes Profils; jetzt werden beide maskiert |

### [v1.27.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.27.0) — Grenzen für große Projekte und sauberer Speicher pro Version

| Bereich | Änderung |
|---------|----------|
| **Obergrenze pro Plan (`externalChanges.maxPlanItems`)** | Ein Scan, ein Polling-Tick oder ein Watcher-Schub, der mehr geänderte Dateien als die Grenze findet (standardmäßig 2000; `0` hebt sie auf), wird nicht mehr zu einem Plan: Eine Warnung nennt die Anzahl und bietet `Mark all as uploaded` (der lokale Baum wird zur Referenz) und `Manage upload exclusions`; der dritte Ausweg ist, das Projekt einmal hochzuladen und erneut zu scannen. Die automatischen Scans dieser Verbindung warten auf einen manuellen Scan, ein Rebuild, ein Als-hochgeladen-Markieren oder ein Neuladen von `sftp.json`; der Collector verwirft den Schub vor dem ersten `stat` und meldet das einmal pro Sitzung |
| **Seitenweise Aktivitätsansicht** | Ein Plan listet seine ersten 200 Dateien und eine Zeile `N more file(s)…`, die die nächste Seite zeigt; zuvor erzeugte der Baum bei jedem Refresh eine Zeile pro Element, mehrmals pro hochgeladener Datei |
| **Index ruhig geschrieben** | Während ein Plan läuft, wird der Sync-Index einmal pro Minute statt einmal pro Sekunde gespeichert (jeder verifizierte Upload markierte ihn als geändert) und noch einmal am Ende; ein explizites Speichern wird nie zurückgehalten |
| **Leerer Speicher pro Version** | Beim ersten Aktivieren einer neuen Version in einem Workspace werden Sync-Index und Aktivitätsprotokoll der vorherigen Version vor dem Laden verworfen (der Ausgabekanal protokolliert es); der Index startet leer und der Hinweis zum Säen oder Neuaufbau erscheint wieder wie beim ersten Gebrauch. Im Projekt selbst wird nichts angefasst |

### [v1.28.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.28.0) — widerstandsfähige Verbindung

| Bereich | Änderung |
|---------|----------|
| **Uploads zurückgestellt, nicht fehlgeschlagen** | Geht die Verbindung verloren, kehren die unterbrochene Aufgabe und die noch wartenden zu `pending` mit `on hold: <Grund>` zurück, der Plan bleibt offen (die Scans planen diese Dateien nicht noch einmal darüber), der Index bleibt unberührt, und es gibt **eine Warnung pro Server und Ausfall** statt eines Dialogs pro Datei. Befehle (`Upload Project`, `Sync…`) melden es einmal, mit dem Erledigten, Unterbrochenen und Nichtversuchten |
| **Wiederverbindung mit wachsender Wartezeit** | Jede Verbindung merkt sich ihre fehlgeschlagenen Versuche und hält neue 1 s, 2 s, 4 s… bis zu einer Minute zurück (mindestens eine Minute nach einem `421`); wer sie derweil anfordert, erhält `connection is down; next attempt in N s`, ohne dass ein Socket geöffnet wird. Kommt die Verbindung zurück, setzen sich die zurückgestellten Pläne von selbst fort; wenn nicht, versuchen sie es mit dieser Wartezeit bis zu zehnmal und warten dann in der Aktivitätsansicht |
| **Weniger FTP-Verbindungen** | Eine FTP-Verbindung ohne Befehl seit fünf Minuten wird geschlossen (das `NOOP` zählt nicht) und bei der nächsten Nutzung neu geöffnet; zuvor blieb eine pro Profil, pro `sftp.json`-Eintrag und pro Fenster die ganze Sitzung lang offen. Ein Befehl, der mit dem Socket stirbt, meldet es sofort statt beim nächsten Keepalive-Tick; ein Profilwechsel schließt die Verbindung des vorigen Profils; ein spätes `close` eines toten SSH-Clients reißt die Ersatzverbindung nicht mehr ab |
| **Weniger falsche Änderungen** | `.git`, `.svn` und `.hg` werden standardmäßig in jeder Tiefe ignoriert (die Git-Integration des Editors schreibt `.git/index` und `FETCH_HEAD` bei jedem `status` neu; `"!.git"` in `ignore` holt eines zurück), und ein Watcher-Ereignis oder ein Speichern für eine Datei, deren Größe und mtime (sekundengenau) die vom Index geprüften sind, wird nicht mehr geplant: ein Ereignis ist keine Bearbeitung |

### [v1.29.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.29.0) — Inhalts-Fingerabdruck

| Bereich | Änderung |
|---------|----------|
| **Inhalts-Fingerabdruck** | Jeder verifizierte Upload speichert im Index den SHA-1 der gesendeten Bytes, berechnet auf dem Datenstrom selbst (nichts wird zweimal gelesen); Downloads ebenso. Ein Scan, ein Watcher-Ereignis, ein Polling oder eine Vorschau, die eine Datei mit gleicher Größe und anderer mtime findet, liest sie einmal, vergleicht den Fingerabdruck und lässt sie bei Übereinstimmung in Ruhe, wobei der Eintrag auf die neue mtime gesetzt wird, damit sie nicht erneut gelesen wird; nur andere Bytes machen sie `modified`. Eine andere Größe ist weiterhin ohne Lesen eine Änderung; Dateien über 64 MB behalten die Regel aus Größe und mtime |
| **Seeding mit Fingerabdruck** | `SFTP: Rebuild Sync Index` und `SFTP: Mark Local Files as Uploaded` lesen die Dateien, die sie erfassen (`N fingerprinted` im Fortschritt, abbrechbar), und `Mark as uploaded` sowie `Skip` in einem Plan tun dasselbe mit ihren: Von da an ist ein `touch` oder ein identischer Checkout keine Änderung mehr. Der Ausgabekanal zählt das Erkannte (`N file(s) rewritten with the same content, not planned`) |
| **`externalChanges.compareContent`** | Neuer Schlüssel, standardmäßig `true`. Ausgeschaltet wird keine Datei gelesen und kein Fingerabdruck gespeichert; die Erweiterung verhält sich genau wie 1.28.0 |
| **Bestehende Indizes** | Früher geschriebene Einträge haben keinen Fingerabdruck und folgen der alten Regel, bis ein Upload, ein Rebuild oder ein „als hochgeladen markieren“ einen einträgt. Um ein bereits synchronisiertes Projekt auf einmal abzudecken, `SFTP: Mark Local Files as Uploaded` (oder `Rebuild Sync Index`) einmal pro Server ausführen |

**v1.29.1 (Korrektur).** 0-Byte-Dateien lassen sich wieder über FTPS hochladen: Gegen einen Server mit TLS 1.3 (etwa Pure-FTPd) schloss jede von ihnen die Sitzung mit einem `decode error`-Alert auf dem Daten-Socket und versetzte den Plan immer wieder in Wartestellung. Außerdem wird eine Datei, bei deren Upload die Verbindung dreimal in Folge abbricht, jetzt als `failed` markiert, und der Plan fährt mit dem Rest fort, statt an ihr hängen zu bleiben.

**v1.29.2 (Korrektur).** Ein Ordnerbefehl (`Upload Folder`, `Sync…`, `Download Folder`), den ein Verbindungsabbruch unterbricht, endet nicht mehr an dieser Stelle mit dem Rest des Baums unberührt und einem Dialog pro ausgewähltem Ordner: Er wartet, bis die Verbindung zurück ist, verbindet sich neu und macht dort weiter, wo er war, ohne die bereits bestätigten Dateien erneut zu senden, bis zu zehnmal, wie ein Plan. Außerdem wird ein Ordner, der zusammen mit einem seiner Unterordner ausgewählt wurde, nur einmal durchlaufen; bisher wurde jede Datei unter beiden zweimal gleichzeitig hochgeladen.

## Neuerungen in v1.30.0

v1.30.0 schließt eine Lücke der Verteilung außerhalb des Marketplace: VS Code aktualisiert von sich aus nur Erweiterungen, die von dort kommen, und eine aus einem vsix installierte blieb für immer so, wie sie war. Jetzt fragt die Erweiterung selbst GitHub nach der neuesten Release, meldet eine neuere Version und lädt sie auf Wunsch herunter, prüft sie und installiert sie.

| Neuerung | Was sie bringt |
|----------|----------------|
| **Hinweis auf neue Version** | Gemäß `sftp.updates.check` (`daily` als Standard: einmal alle 24 h; `startup`: bei jeder Aktivierung; `off`) fragt die Erweiterung 15 s nach der Aktivierung die neueste Release von [jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp/releases) ab und vergleicht das Tag mit der installierten Version. Gibt es eine neuere, bietet sie `Install`, `Release notes` und `Skip this version` an. Ohne Zustimmung wird nichts installiert; ein Netzwerkfehler hinterlässt nur eine Zeile `[updates]` im Ausgabekanal |
| **Verifizierte Installation** | `Install` lädt das vsix der Release in den globalen Speicher der Erweiterung, prüft seinen SHA-256 gegen die `.sha256`, die jede Release jetzt veröffentlicht (eine Release ohne sie wird ungeprüft installiert, mit Warnung), installiert es über denselben Mechanismus wie *Install from VSIX…* und bietet das Neuladen des Fensters an. Nur ein in den Releases dieses Repositorys veröffentlichtes vsix wird akzeptiert; Entwürfe und Vorabversionen werden ignoriert, ein neuerer lokaler Build wird nie herabgestuft |
| **`SFTP: Check for Updates`** | Neuer Befehl, der sofort nachfragt, unabhängig von der Einstellung, und in jedem Fall antwortet: aktuell, kein vsix, kein Netz. Eine mit `Skip this version` übersprungene Version wird nicht mehr von selbst gemeldet, der Befehl bietet sie aber weiterhin an |
| **Was sie nicht tut** | Nichts wird im Hintergrund installiert, und das Fenster wird nie ohne Bestätigung neu geladen. Releases vor 1.30.0 haben keine Prüfsumme: Der Hinweis erscheint ab der ersten Release, die nach der Installation dieser Version veröffentlicht wird |

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
code --install-extension sftp-1.30.0.vsix
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
- [Externe Änderungen und Upload-Verifizierung](#externe-änderungen-und-upload-verifizierung)

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

### Externe Änderungen und Upload-Verifizierung
```json
{
  "host": "host",
  "username": "benutzername",
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

_Hinweis:_ `externalChanges`, `verifyUpload` und `uploadRetries` tragen hier ihre Standardwerte; der `watcher`-Block ist für die Scans nicht nötig (nur, um auf Live-Änderungen zu reagieren, und für `pollInterval`). `verifyUpload: "hash"` ergänzt die Inhaltsprüfung, und ein `pollInterval` in Millisekunden schaltet das periodische Polling ein.

### Ordner, die dem Server gehören
```json
{
  "host": "host",
  "username": "benutzer",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "ignore": [".git", "node_modules"],
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

_Hinweis:_ `storage/` und `public/uploads/` werden nie hochgeladen, und sie lokal zu löschen löscht sie nie auf dem Server, aber sie lassen sich weiterhin herunterladen (`Download Folder`, `Sync Remote -> Local`); `*.env` verlässt deinen Rechner nie. `Force Upload` bleibt für den Ausnahmefall verfügbar.

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
