# SFTP — extension de synchronisation pour VS Code (fork corrigé)

🌍 [Español](README.md) (base) · [English](README.en.md) · [中文（简体）](README.zh-CN.md) · [Português (BR)](README.pt-BR.md) · **Français** · [Deutsch](README.de.md)

[![Release](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![Licence : MIT](https://img.shields.io/badge/Licence-MIT-yellow.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**Fork corrigé et maintenu par [@jalexiscv](https://github.com/jalexiscv)** de la populaire extension de synchronisation SFTP/FTP.<br>
Lignée : fork de [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), lui-même fork du [plugin SFTP de liximomo](https://github.com/liximomo/vscode-sftp.git), qui n'est plus maintenu.

- 📦 **Installation (releases VSIX) :** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Signaler des problèmes :** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Historique complet des modifications :** [CHANGELOG.md](CHANGELOG.md)

VSCode-SFTP vous permet d'ajouter, de modifier ou de supprimer des fichiers dans un répertoire local et de les synchroniser avec un répertoire d'un serveur distant à l'aide de différents protocoles de transfert comme FTP ou SSH. La configuration la plus basique ne nécessite que quelques lignes, avec un large éventail d'options spécifiques disponibles pour couvrir les besoins de n'importe quel utilisateur. À la fois puissante et rapide, elle aide les développeurs à gagner du temps en leur permettant d'utiliser un éditeur et un environnement familiers.

## 📑 Sommaire

- [Pourquoi ce fork existe](#pourquoi-ce-fork-existe)
- [Ce que nous avons mis à jour](#ce-que-nous-avons-mis-à-jour)
- [Nouveautés de la v1.30.0](#nouveautés-de-la-v1300)
- [Ce que nous attendons de cette version](#ce-que-nous-attendons-de-cette-version)
- [Installation](#installation)
- [Documentation](#documentation)
- [Utilisation](#utilisation)
- [Exemples de configuration](#exemples-de-configuration)
- [Explorateur distant](#explorateur-distant)
- [Débogage](#débogage)
- [FAQ](#faq)
- [Crédits et soutien aux auteurs originaux](#crédits-et-soutien-aux-auteurs-originaux)
- [Licence](#-licence) · [Auteur](#-auteur) · [Dons](#%EF%B8%8F-dons)

---

## Pourquoi ce fork existe

Nous avons lancé cette version parce que le projet original, tout excellent qu'il soit, est arrivé à un point où il ne pouvait plus servir ses utilisateurs :

1. **Le projet upstream est de fait sans maintenance.** Son mainteneur a déclaré en mars 2025 qu'il ne pouvait plus continuer à y travailler et que la [v1.16.3 (juin 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) devait être considérée comme la dernière version stable. Depuis, environ 600 issues se sont accumulées sans correction.
2. **L'extension s'est cassée sur les VS Code modernes.** Les VS Code récents embarquent un runtime Node.js dans lequel la dépendance empaquetée `ssh2` 1.13 échoue avec `TypeError: isDate is not a function`, faisant échouer toute opération SFTP — le bug le plus signalé du projet (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **La branche de développement de l'upstream ne compilait même pas.** Sa branche `develop` présentait des erreurs de compilation TypeScript et une suite de tests cassée, si bien que les corrections de la communauté (dont plusieurs envoyées sous forme de pull requests il y a des années) n'avaient aucun chemin vers la publication.
4. **Un problème de sécurité restait non résolu.** Avec la configuration par défaut, synchroniser un projet pouvait envoyer `.vscode/sftp.json` — avec l'hôte, l'utilisateur et le mot de passe du serveur — vers le serveur distant, souvent à l'intérieur d'un docroot public.

Plutôt que de laisser se dégrader un outil utilisé par des milliers de développeurs, nous l'avons forké, avons réparé ses fondations (build, tests, linter), corrigé les bugs les plus signalés et nous nous sommes engagés à le maintenir en état de marche.

## Ce que nous avons mis à jour

Chaque correction a été vérifiée (build webpack propre, 971 tests, linter sans erreurs) avant publication. Le détail de chaque changement se trouve dans [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — fondations et corrections critiques

| Domaine | Correction |
|------|------------|
| **Compatibilité** | `ssh2` mis à jour vers 1.17.0 : corrige *« isDate is not a function »* sur les VS Code modernes et prend en charge les formats de clé OpenSSH modernes ainsi que les algorithmes rsa-sha2 (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Sécurité** | `.vscode/sftp.json` (identifiants) ne peut plus jamais être envoyé vers le serveur, quelle que soit la configuration de `ignore` |
| **Fiabilité** | Reconnexion automatique après une fermeture du canal SFTP côté serveur, au lieu de rester bloqué indéfiniment (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Correction de *« Error: Config Not Found »* / `uploadOnSave` qui ne fonctionnait pas lorsque la casse du chemin rapporté différait de celle du workspace (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | Les motifs de `ignore` fonctionnent désormais vraiment (le matcher gitignore recevait des chemins avec des séparateurs `\`) |
| **Configuration** | `sftp.json` est rechargé lorsqu'il change en dehors de l'éditeur — p. ex. lors d'un changement de branche git (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Les noms de fichiers non ASCII (chinois, accents) n'arrivent plus corrompus dans les listages (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), sans sa régression sur SFTP) |
| **FTP** | Les écrasements rejetés avec 550 par des serveurs proftpd équipés de `mod_rename` sont réessayés de manière sûre (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | La compilation du code a été restaurée, l'infrastructure de tests réparée (Jest 29, Node 22) et toutes les violations de lint préexistantes nettoyées |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — deuxième série

| Domaine | Correction |
|------|------------|
| **SSH** | `Open SSH in Terminal` utilise désormais la chaîne de `hop` configurée via ProxyJump d'OpenSSH (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Explorateur distant** | Les liens symboliques distants pointant vers des répertoires sont navigables via SFTP — p. ex. des déploiements du type `current -> releases/N` (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` se déclenche désormais lors de l'enregistrement de documents notebook comme `.ipynb` |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — mots de passe sécurisés et CI

| Domaine | Changement |
|---------|------------|
| **Sécurité** | **Enregistrement sécurisé des mots de passe** avec le SecretStorage de VS Code (le trousseau du système) : après une connexion réussie, l'extension propose de mémoriser le mot de passe saisi, l'injecte automatiquement aux connexions suivantes et l'oublie si le serveur le rejette. Nouvelle commande `SFTP: Forget Saved Passwords` et paramètre `sftp.promptToSavePassword` |
| **Qualité** | CI GitHub Actions (lint, build et tests à chaque push/PR) et publication automatisée à la création d'un tag |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — FTP moderne

| Domaine | Changement |
|---------|------------|
| **FTP** | **Backend FTP migré du paquet `ftp` abandonné (~10 ans sans maintenance) vers [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)** : UTF-8 natif, FTPS robuste et mode passif fiable. Validé contre un serveur FTPS réel avec un nouveau test d'intégration (référence `ftp` : 7/8 avec `read ECONNRESET` ; `basic-ftp` : 8/8). Résout le groupe de bugs FTP du backlog (PASV, FTPS avec FileZilla, noms non-ASCII, ECONNRESET) |
| **Remarque** | `basic-ftp` ne prend en charge que le mode passif ; le mode actif FTP (`passive: false`) n'est plus pris en charge |

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — gestionnaire de connexions

| Domaine | Changement |
|---------|------------|
| **UI** | **Nouveau gestionnaire de connexions** (`SFTP: Open Connection Manager`, aussi via l'engrenage de la vue Remote Explorer) : panneau graphique pour créer, modifier, dupliquer, supprimer, tester et activer les connexions/profils de `sftp.json` sans éditer le JSON à la main. À l'enregistrement, les services se rechargent automatiquement ; « Tester la connexion » réutilise la vraie mécanique de connexion (y compris les mots de passe enregistrés) |
| **Qualité** | Mode `strict` de TypeScript activé (`noImplicitAny` différé) et 26 vraies erreurs de types corrigées, dont un crash latent de l'observateur d'état des profils |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — profil actif stable et exclusion des fichiers temporaires

| Domaine | Changement |
|---------|------------|
| **Transferts** | Tout fichier ou dossier dont le nom contient `.tmp` est désormais exclu en permanence des transferts (envois, `uploadOnSave` et sync), sur tous les serveurs et sans aucune configuration `ignore` |
| **Profils** | Le profil activé avec `SFTP: Set Profile` ou le gestionnaire de connexions ne « change plus tout seul » : les rechargements de `sftp.json` ne le réinitialisent plus au `defaultProfile`, et la sélection persiste entre les redémarrages de VSCode. `defaultProfile` devient seulement la valeur initiale et le repli si le profil actif disparaît |

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — miroir local-distant sûr

| Domaine | Changement |
|---------|------------|
| **Transferts** | Les fichiers temporaires ne sont jamais envoyés : une liste intégrée exclut les fichiers d'échange et de sauvegarde des éditeurs, les verrous d'Office, les restes de fusion, les téléchargements incomplets et les métadonnées du système, sur tous les serveurs et sans configuration (`ignoreTempFiles`, `tempFilePatterns`) |
| **Suppressions** | Les suppressions locales sont répercutées sur le serveur (`deleteRemoteOnLocalDelete`, actif par défaut), avec quatre garde-fous : confirmation modale au-delà de `deleteRemoteConfirmThreshold` (10), suppressions provoquées par git écartées, auto-suppression pendant `Sync Remote -> Local --delete` et corbeille distante |
| **Corbeille distante** | Avec `remoteTrash`, supprimer est un `rename` côté serveur vers un dossier de corbeille, réversible avec `SFTP: Undo Last Remote Deletion` et `SFTP: Restore from Remote Trash` ; `SFTP: Empty Remote Trash` la vide et les entrées expirées sont purgées après `retentionDays` |
| **Renommages** | `renameRemoteOnLocalRename` répercute renommages et déplacements comme un `rename` distant, sans renvoyer le fichier et sans aucun instant où le chemin manque sur le serveur |
| **Interface** | Vue d'activité avec l'historique de chaque transfert, suppression et renommage, et relances (`sftp.showActivityView`) ; mode pause (`SFTP: Pause/Resume Auto Sync`) qui suspend toute la synchronisation automatique |
| **Durcissement** | Deux passes de revue adversariale avant publication : garde-fou git évalué à la mise en file, un seul chemin de suppression, chemins de corbeille dangereux refusés, profil de la suppression respecté à la restauration et à la purge, purge qui balaie le répertoire distant lui-même |

### [v1.24.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.24.0) — changements externes et vérification des envois

| Domaine | Changement |
|---------|------------|
| **Changements externes** | Un index de synchronisation persistant retient, par serveur, quelle version de chaque fichier a été envoyée et vérifiée en dernier ; l'arborescence locale lui est comparée au démarrage, au rechargement de `sftp.json`, à la reprise, au retour du focus après cinq minutes, à la demande (`SFTP: Scan for External Changes`) et, en option, périodiquement (`watcher.pollInterval`), de sorte que les modifications faites hors de l'éditeur — ou VS Code fermé — sont envoyées via un plan sans lister le serveur. `SFTP: Rebuild Sync Index` amorce l'index à la première utilisation ; clés `externalChanges.scanOnStartup`, `scanOnResume`, `confirmThreshold` |
| **Un seul collecteur de changements** | `uploadOnSave` et le watcher n'envoient plus deux fois la même sauvegarde : les sauvegardes de l'éditeur partent immédiatement, les changements externes sont regroupés (700 ms) et dédoublonnés par chemin |
| **Plans d'envoi** | Chaque lot est un plan (origine, motif par fichier, état, tentatives, erreur) visible dans le groupe « Upload plans » de la vue d'activité, avec `SFTP: Preview Upload (Dry Run)`, `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` et `SFTP: Clear Upload Plans` ; la barre d'état affiche `↑N` en attente et `✗N` en échec. Au-delà de `externalChanges.confirmThreshold` (20), après une opération git ou quand le lot contient des fichiers inconnus de l'index, une boîte de dialogue modale demande d'abord (`Review plan`, `Upload N file(s)`, `Skip` — et `Skip` est mémorisé) |
| **Vérification des envois** | Chaque envoi compte les octets transmis et, avec `verifyUpload: "stat"` (par défaut), vérifie que la taille distante correspond exactement ; `"hash"` compare en plus une empreinte via SSH ou FTP et se rabat sur `stat` si le serveur ne sait pas la calculer. Les échecs transitoires sont retentés (`uploadRetries`, 2) ; les erreurs permanentes non |
| **Journal d'activité persistant** | Chaque tâche — venue d'une commande, d'une sauvegarde ou du watcher — est enregistrée avec le chemin distant et le résultat de la vérification, et survit aux rechargements de la fenêtre (`activity-log.json`) ; les échecs antérieurs au transfert (connexion, identifiants, permissions) apparaissent aussi |
| **Corrections et durcissement** | `uploadFile()` rejette quand le transfert échoue ; la suspension de la synchronisation automatique pendant les téléchargements est réellement appliquée ; les motifs `dir/` de `ignore` élaguent le sous-arbre ; les boucles de liens symboliques sont coupées ; les erreurs SFTP numériques sont décrites. Deux revues adversariales avant publication ; tant que l'index n'est pas amorcé, les analyses automatiques ne renvoient que ce que l'extension a elle-même envoyé |

### [v1.25.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.25.0) — exclusion d'envoi seule

| Domaine | Changement |
|---------|------------|
| **Exclusion d'envoi seule (`uploadExclude`)** | Une liste de motifs gitignore, avec la même syntaxe et le même ancrage que `ignore`, qui ne part jamais vers le serveur : `Upload File` / `Upload Folder` / `Upload Project`, `uploadOnSave`, le watcher, les analyses et les plans, `Upload Changed Files` et `Sync Local -> Remote` (avec `syncOption.delete`, la copie distante n'est pas supprimée non plus). Dans un profil, elle s'ajoute à la liste de base |
| **Le serveur garde sa copie** | Supprimer ou renommer en local un chemin exclu ne touche pas au serveur (`deleteRemoteOnLocalDelete`, `renameRemoteOnLocalRename`, `watcher.autoDelete`) ; `Rebuild Sync Index` l'élague des deux côtés |
| **Ce qui ne change pas** | Les téléchargements, `Sync Remote -> Local`, l'explorateur distant et le diff voient toujours ces chemins ; `Force Upload` ignore la liste, comme il ignore `ignore`. Une commande d'envoi sur un chemin exclu le signale par une notification et ne se connecte pas ; `Upload Changed Files` liste les fichiers mis de côté dans un groupe à part |
| **Correction** | Une suppression locale dont le motif `dir/` de `ignore` ne correspond qu'à un répertoire n'est plus répercutée sur le serveur : le chemin supprimé est désormais testé à la fois comme fichier et comme répertoire |

### [v1.26.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.26.0) — marquer comme envoyé et exclusions depuis l'interface

| Domaine | Changement |
|---------|------------|
| **Marquer comme envoyé (`Mark as uploaded`)** | Un quatrième bouton dans la boîte de confirmation de tout plan, et `Mark Plan as Uploaded` / `Mark as Uploaded` sur un plan ou un fichier dans la vue d'activité : les fichiers sont enregistrés dans l'index comme déjà présents sur le serveur, dans leur version actuelle, sans rien transférer, et ne sont plus proposés tant qu'ils ne changent pas. Un état propre `assumed`, distinct de `verified` dans les résumés, les rapports et les icônes |
| **Amorcer l'index sans lister le serveur** | `SFTP: Mark Local Files as Uploaded` (aussi `Mark all as uploaded` dans l'avis d'index non construit) parcourt l'arborescence locale, affiche le nombre et, une fois confirmé, amorce l'index avec tout ce qui est en local ; ensuite seul ce qui change est proposé. L'alternative rapide à `Rebuild Sync Index` pour les sites de dizaines de milliers de fichiers en FTP |
| **Exclusions d'envoi depuis l'interface** | Clic droit sur un dossier → `SFTP: Exclude from Upload` (et `SFTP: Include in Upload Again` sur un dossier exclu), `SFTP: Manage Upload Exclusions` pour revoir, ajouter ou retirer des entrées, et une liste avec `×` dans le gestionnaire de connexions. Tous écrivent la liste `uploadExclude` de `sftp.json` en respectant son format |
| **Sécurité** | La ligne `config at …` du canal de sortie masquait le mot de passe de la racine mais pas celui de chaque profil ; les deux sont désormais masqués |

### [v1.27.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.27.0) — limites pour les grands projets et stockage propre par version

| Domaine | Changement |
|---------|------------|
| **Limite par plan (`externalChanges.maxPlanItems`)** | Une analyse, un tick de sondage ou une rafale du watcher qui trouve plus de fichiers modifiés que la limite (2000 par défaut ; `0` la supprime) n'est plus transformée en plan : un avertissement indique le nombre et propose `Mark all as uploaded` (l'arborescence locale devient la référence) et `Manage upload exclusions` ; la troisième issue est d'envoyer le projet une fois puis de réanalyser. Les analyses automatiques de cette connexion attendent une analyse manuelle, une reconstruction, un marquage comme envoyé ou un rechargement de `sftp.json` ; le collecteur rejette la rafale avant le moindre `stat` et le signale une fois par session |
| **Vue d'activité paginée** | Un plan liste ses 200 premiers fichiers et une ligne `N more file(s)…` qui révèle la page suivante ; auparavant l'arbre matérialisait une ligne par élément à chaque rafraîchissement, plusieurs fois par fichier envoyé |
| **Index écrit calmement** | Pendant l'exécution d'un plan, l'index de synchronisation est enregistré une fois par minute au lieu d'une fois par seconde (chaque envoi vérifié le marquait modifié), puis une fois de plus à la fin ; un enregistrement explicite n'est jamais retenu |
| **Stockage propre par version** | La première fois qu'une nouvelle version s'active dans un espace de travail, l'index de synchronisation et le journal d'activité de la précédente sont supprimés avant d'être chargés (le canal de sortie l'indique) ; l'index repart vide et l'avis pour l'amorcer ou le reconstruire revient, comme à la première utilisation. Rien dans le projet n'est touché |

### [v1.28.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.28.0) — connexion résiliente

| Domaine | Changement |
|---------|------------|
| **Envois en attente, pas en échec** | À la perte de la connexion, la tâche interrompue et celles encore en file repassent à `pending` avec `on hold: <raison>`, le plan reste ouvert (les scans ne replanifient pas ces fichiers par-dessus), l'index n'est pas touché et il y a **un avertissement par serveur et par coupure** au lieu d'une boîte par fichier. Les commandes (`Upload Project`, `Sync…`) le signalent une fois, avec ce qui a été fait, interrompu et non tenté |
| **Reconnexion à délai croissant** | Chaque connexion mémorise ses tentatives échouées et retient les nouvelles 1 s, 2 s, 4 s… jusqu'à une minute (une minute au moins après un `421`) ; entre-temps, qui la demande reçoit `connection is down; next attempt in N s` sans qu'aucune socket ne soit ouverte. Au retour de la connexion, les plans en attente reprennent d'eux-mêmes ; sinon, ils réessaient avec ce délai jusqu'à dix fois puis attendent dans la vue d'activité |
| **Moins de connexions FTP** | Une connexion FTP sans commande depuis cinq minutes est fermée (le `NOOP` ne compte pas) et rouverte au prochain usage ; auparavant une par profil, par entrée de `sftp.json` et par fenêtre restait ouverte toute la session. Une commande qui meurt avec la socket le signale aussitôt, pas au prochain tick du keepalive ; changer de profil ferme la connexion du profil quitté ; un `close` tardif d'un client SSH mort n'abat plus la connexion qui l'a remplacé |
| **Moins de faux changements** | `.git`, `.svn` et `.hg` sont ignorés par défaut à toute profondeur (l'intégration git de l'éditeur réécrit `.git/index` et `FETCH_HEAD` à chaque `status` ; `"!.git"` dans `ignore` en récupère un), et un événement du watcher ou un enregistrement sur un fichier dont la taille et le mtime (à la seconde) sont ceux vérifiés par l'index n'est plus planifié : un événement n'est pas une modification |

### [v1.29.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.29.0) — empreinte de contenu

| Domaine | Changement |
|---------|------------|
| **Empreinte de contenu** | Chaque envoi vérifié enregistre dans l'index le SHA-1 des octets envoyés, calculé sur le flux lui-même (rien n'est lu deux fois) ; les téléchargements aussi. Un scan, un événement du watcher, un sondage ou un aperçu qui trouve un fichier de même taille et d'autre mtime le lit une fois, compare l'empreinte et, si elle correspond, le laisse tranquille et déplace l'entrée vers le nouveau mtime pour ne pas le relire ; seuls des octets différents le rendent `modified`. Une taille différente reste un changement sans lecture ; les fichiers de plus de 64 Mo gardent la règle taille et mtime |
| **Amorçage avec empreinte** | `SFTP: Rebuild Sync Index` et `SFTP: Mark Local Files as Uploaded` lisent les fichiers qu'ils enregistrent (`N fingerprinted` dans la progression, annulable), et `Mark as uploaded` et `Skip` sur un plan font de même avec les leurs : dès lors un `touch` ou un checkout identique n'est plus un changement. Le canal de sortie compte ce qui a été reconnu (`N file(s) rewritten with the same content, not planned`) |
| **`externalChanges.compareContent`** | Nouvelle clé, `true` par défaut. Désactivée, aucun fichier n'est lu et aucune empreinte n'est enregistrée ; l'extension se comporte exactement comme la 1.28.0 |
| **Index existants** | Les entrées antérieures n'ont pas d'empreinte et suivent l'ancienne règle jusqu'à ce qu'un envoi, un rebuild ou un « marquer comme envoyé » en enregistre une. Pour couvrir d'un coup un projet déjà synchronisé, lancez une fois `SFTP: Mark Local Files as Uploaded` (ou `Rebuild Sync Index`) par serveur |

**v1.29.1 (correctif).** Les fichiers de 0 octet se téléversent de nouveau en FTPS : face à un serveur en TLS 1.3 (Pure-FTPd, par exemple), chacun d'eux fermait la session avec une alerte `decode error` sur le socket de données et remettait le plan en attente, encore et encore. De plus, un fichier dont le téléversement perd la connexion trois fois de suite passe à `failed` et le plan continue avec le reste au lieu de rester bloqué dessus.

**v1.29.2 (correctif).** Une commande de dossier (`Upload Folder`, `Sync…`, `Download Folder`) interrompue par une perte de connexion ne s'arrête plus là, avec le reste de l'arborescence non envoyé et un dialogue par dossier sélectionné : elle attend le retour de la connexion, se reconnecte et reprend là où elle en était, sans renvoyer les fichiers déjà vérifiés, jusqu'à dix fois, comme le fait un plan. De plus, un dossier sélectionné avec l'un de ses sous-dossiers n'est parcouru qu'une fois ; auparavant chaque fichier sous les deux était envoyé deux fois en même temps.

## Nouveautés de la v1.30.0

La v1.30.0 comble une lacune de la distribution hors Marketplace : VS Code ne met à jour de lui-même que les extensions qui en proviennent, et une extension installée depuis un vsix restait telle quelle pour toujours. Désormais l'extension interroge elle-même GitHub pour la dernière release, signale une version plus récente et, si vous le demandez, la télécharge, la vérifie et l'installe.

| Nouveauté | Ce que cela apporte |
|-----------|---------------------|
| **Avis de nouvelle version** | Selon `sftp.updates.check` (`daily` par défaut : une fois toutes les 24 h ; `startup` : à chaque activation ; `off`), l'extension interroge la dernière release de [jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp/releases) 15 s après son activation et compare le tag à la version installée. S'il en existe une plus récente, elle propose `Install`, `Release notes` et `Skip this version`. Rien n'est installé sans votre accord ; une panne réseau ne laisse qu'une ligne `[updates]` dans le canal de sortie |
| **Installation vérifiée** | `Install` télécharge le vsix de la release dans le stockage global de l'extension, vérifie son SHA-256 contre le `.sha256` que chaque release publie désormais (une release qui n'en a pas est installée sans vérification, avec un avertissement), l'installe par le même mécanisme qu'*Install from VSIX…* et propose de recharger la fenêtre. Seul un vsix publié dans les releases de ce dépôt est accepté ; les brouillons et préversions sont ignorés, et un build local plus récent n'est jamais rétrogradé |
| **`SFTP: Check for Updates`** | Nouvelle commande qui interroge tout de suite, quel que soit le réglage, et répond dans tous les cas : à jour, pas de vsix, pas de réseau. Une version ignorée avec `Skip this version` n'est plus annoncée d'elle-même, mais la commande la propose toujours |
| **Ce qu'elle ne fait pas** | Rien n'est installé en arrière-plan et la fenêtre n'est jamais rechargée sans votre confirmation. Les releases antérieures à la 1.30.0 n'ont pas de somme de contrôle : l'avis apparaîtra à partir de la première release publiée après l'installation de celle-ci |

**v1.30.1 (correctif).** Un certificat FTPS que le client refuse (chaîne incomplète, auto-signé, expiré ou émis pour un autre nom) ne marque plus chaque fichier comme échoué et n'ouvre plus une boîte de dialogue par enregistrement avec l'erreur brute d'OpenSSL : il est traité comme une perte de connexion, les plans sont mis en attente, les tentatives sont retenues une minute et un seul avis par serveur dit ce qui ne va pas et la sortie (une chaîne complète sur le serveur, ou `"secureOptions": { "rejectUnauthorized": false }` pour l'accepter sans vérification).

## Ce que nous attendons de cette version

- **Un remplacement direct (drop-in).** Le même format de `sftp.json`, les mêmes commandes, les mêmes flux de travail — les configurations existantes fonctionnent sans aucune migration.
- **La stabilité sur l'outillage actuel.** L'extension doit continuer à fonctionner sur les VS Code et runtimes Node.js à jour, précisément là où l'original s'est cassé.
- **La sécurité par défaut.** Vos identifiants ne quittent jamais votre machine dans le cadre d'une synchronisation, même avec une liste `ignore` personnalisée ou vide.
- **Un projet vivant.** Nous continuerons à trier le backlog de l'upstream (des demandes comme les proxys SOCKS5, les clés `.ppk` ou le diff de dossiers sont candidates pour les prochaines séries), et les issues/PRs sur [notre tracker](https://github.com/jalexiscv/vscode-sftp/issues) sont les bienvenus.
- **Une qualité vérifiable.** Aucune release n'est publiée sans build propre, suite de tests au vert et linter sans erreurs ; chaque changement est documenté dans [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

---

## Installation

> ⚠️ **Désinstallez ou désactivez d'abord toute autre extension SFTP** (celle de liximomo ou celle de Natizyskunk) : elles enregistrent les mêmes commandes `sftp.*` et entreront en conflit avec celle-ci.

1. Téléchargez le `sftp-x.y.z.vsix` le plus récent depuis la [page des Releases](https://github.com/jalexiscv/vscode-sftp/releases).
2. Dans VS Code, ouvrez Extensions (Ctrl + Maj + X).
3. Ouvrez le menu « Autres actions » (les points de suspension en haut) et choisissez « Installer à partir d'un VSIX… ».
4. Localisez le fichier VSIX et sélectionnez-le.
5. Rechargez VS Code.
6. C'est prêt !

Ou depuis la ligne de commande :

```
code --install-extension sftp-1.30.1.vsix
```

## Documentation
- [Accueil](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Paramètres](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Configuration commune](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [Configuration SFTP](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [Configuration FTP](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Commandes](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> Le wiki de l'upstream (en anglais) reste la référence pour les paramètres et les commandes : ce fork conserve une compatibilité totale de configuration.

## Utilisation
Si les fichiers les plus récents se trouvent déjà sur un serveur distant, vous pouvez commencer avec un dossier local vide, télécharger le projet et, à partir de là, synchroniser.

1. Dans `VS Code`, ouvrez le répertoire local que vous souhaitez synchroniser avec le serveur distant (ou créez un répertoire vide où télécharger d'abord le contenu d'un dossier du serveur pour l'éditer localement).
2. Appuyez sur `Ctrl+Shift+P` sous Windows/Linux ou `Cmd+Shift+P` sous Mac pour ouvrir la palette de commandes et exécutez la commande `SFTP: config`.
3. Un fichier de configuration basique nommé `sftp.json` apparaîtra dans le répertoire `.vscode` ; ouvrez-le et modifiez les paramètres avec les informations de votre serveur distant.

Par exemple :
```json
{
    "name": "Nom du profil",
    "host": "hote_du_serveur_distant",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "utilisateur",
    "remotePath": "/public_html/project", // <--- C'est le chemin qui sera téléchargé avec "Download Project"
    "password": "motdepasse",
    "uploadOnSave": false
}
```
Le paramètre `password` de `sftp.json` est optionnel ; si vous l'omettez, le mot de passe vous sera demandé lors de la synchronisation.
_Remarque :_ les barres obliques inverses et autres caractères spéciaux doivent être échappés avec une barre oblique inverse.

4. Enregistrez et fermez le fichier `sftp.json`.
5. Appuyez sur `Ctrl+Shift+P` sous Windows/Linux ou `Cmd+Shift+P` sous Mac pour ouvrir la palette de commandes.
6. Tapez `sftp` et vous verrez le reste des commandes disponibles. Beaucoup d'entre elles figurent aussi dans les menus contextuels de l'explorateur de fichiers du projet.
7. Une bonne commande pour commencer, si vous voulez vous synchroniser avec un dossier distant, est `SFTP: Download Project` : elle télécharge le répertoire indiqué dans `remotePath` de `sftp.json` vers votre répertoire local ouvert.
8. Terminé — vous pouvez désormais éditer localement et, après chaque enregistrement, le fichier sera envoyé pour maintenir la copie distante synchronisée avec la copie locale.
9. Bonne utilisation !

Pour des explications détaillées, visitez le [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Exemples de configuration
Vous pouvez consulter la liste complète des options de configuration [ici](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Simple](#simple)
- [Profils](#profils)
- [Contextes multiples](#contextes-multiples)
- [Connexion par rebonds (hopping)](#connexion-par-rebonds-hopping)
- [Configuration dans les paramètres utilisateur](#configuration-dans-les-paramètres-utilisateur)
- [Suppressions et renommages sûrs](#suppressions-et-renommages-sûrs)
- [Changements externes et vérification des envois](#changements-externes-et-vérification-des-envois)

### Simple
```json
{
  "host": "host",
  "username": "utilisateur",
  "remotePath": "/remote/workspace"
}
```

### Profils
```json
{
  "username": "utilisateur",
  "password": "motdepasse",
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

_Remarque :_ `context` et `watcher` ne sont disponibles qu'au niveau racine.

Utilisez `SFTP: Set Profile` pour changer de profil.

### Contextes multiples
Les contextes **ne doivent pas être identiques**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "utilisateur",
    "password": "motdepasse",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "utilisateur",
    "password": "motdepasse",
    "remotePath": "/remote/project/src"
  }
]
```

_Remarque :_ `name` est obligatoire dans ce mode.

### Connexion par rebonds (hopping)
Vous pouvez vous connecter à un serveur cible à travers un proxy avec le protocole ssh.

_Remarque :_ la substitution de variables ne fonctionne pas à l'intérieur d'une configuration `hop`.

#### Rebond unique
local -> rebond -> cible
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // rebond
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- Le fichier de clé est supposé se trouver sur la machine locale.

  "hop": {
    // cible
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- Le fichier de clé est supposé se trouver sur le rebond.
  }
}
```

#### Rebonds multiples
local -> rebondA -> rebondB -> cible
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // rebondA
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- Le fichier de clé est supposé se trouver sur la machine locale.

  "hop": [
    // rebondB
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- Le fichier de clé est supposé se trouver sur le rebondA.
    },

    // cible
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- Le fichier de clé est supposé se trouver sur le rebondB.
    }
  ]
}
```

### Configuration dans les paramètres utilisateur
Vous pouvez utiliser `remote` pour indiquer à sftp de récupérer la configuration depuis [remote-fs](https://github.com/liximomo/vscode-remote-fs).

Dans les paramètres utilisateur :
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "utilisateur",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "utilisateur",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

Dans sftp.json :
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### Suppressions et renommages sûrs
```json
{
  "host": "host",
  "username": "utilisateur",
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

_Remarque :_ toutes ces valeurs sont celles que l'extension utilise déjà par défaut, sauf `tempFilePatterns`, `remoteTrash.path` (`.sftp-trash`) et `remoteTrash.retentionDays` (`7`) ; il suffit de les écrire pour les modifier. Un `path` absolu place la corbeille en dehors du docroot servi par le serveur web.

### Changements externes et vérification des envois
```json
{
  "host": "host",
  "username": "utilisateur",
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

_Remarque :_ `externalChanges`, `verifyUpload` et `uploadRetries` portent ici leurs valeurs par défaut ; le bloc `watcher` n'est pas nécessaire aux analyses (seulement pour réagir aux changements en direct et pour `pollInterval`). `verifyUpload: "hash"` ajoute le contrôle du contenu et un `pollInterval` en millisecondes active l'interrogation périodique.

### Dossiers qui appartiennent au serveur
```json
{
  "host": "host",
  "username": "utilisateur",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "ignore": [".git", "node_modules"],
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

_Note :_ `storage/` et `public/uploads/` ne sont jamais envoyés, et les supprimer en local ne les supprime jamais sur le serveur, mais ils restent téléchargeables (`Download Folder`, `Sync Remote -> Local`) ; `*.env` ne quitte jamais votre machine. `Force Upload` reste disponible pour le cas exceptionnel.

## Explorateur distant
![aperçu-explorateur-distant](assets/showcase/remote-explorer.png)

L'Explorateur distant vous permet de parcourir les fichiers du serveur. Vous pouvez l'ouvrir ainsi :

1. Exécutez la commande `View: Show SFTP`.
2. Cliquez sur la vue SFTP dans la barre d'activité.

Avec l'Explorateur distant, vous ne pouvez que consulter le contenu des fichiers. Exécutez la commande `SFTP: Edit in Local` pour les éditer en local.

Depuis la v1.16.5, les répertoires liés par des liens symboliques sur le serveur distant sont eux aussi navigables.

### Sélection multiple
Vous pouvez sélectionner plusieurs fichiers/dossiers à la fois sur le serveur distant pour les télécharger ou les envoyer. Maintenez simplement la touche Ctrl ou Maj enfoncée pendant que vous sélectionnez les fichiers souhaités, exactement comme dans l'explorateur habituel.

_Remarque :_ si l'explorateur ne se met pas à jour correctement après la **suppression** d'un fichier, actualisez manuellement le dossier parent.

### Tri
Vous pouvez trier l'Explorateur distant en ajoutant le paramètre `remoteExplorer.order` dans votre fichier de configuration `sftp.json`.

Dans sftp.json :
```json
{
  "remoteExplorer": {
    "order": 1 // <-- La valeur par défaut est 0.
  }
}
```

## Débogage
1. Ouvrez les paramètres utilisateur.
  - Sous Windows/Linux : `File > Preferences > Settings`
  - Sous macOS : `Code > Preferences > Settings`
2. Activez `sftp.debug` (`true`) et rechargez VS Code.
3. Consultez les journaux dans `View > Output > sftp`.

## FAQ
Vous pouvez consulter toutes les questions fréquentes (en anglais) [ici](./FAQ.md).

## Crédits et soutien aux auteurs originaux
Ce fork s'appuie sur le travail de [@liximomo](https://github.com/liximomo) (auteur original) et de [@Natizyskunk](https://github.com/Natizyskunk) (mainteneur du fork dont celui-ci dérive). Si cette extension vous a aidé pendant toutes ces années, envisagez de les soutenir :

- Offrez un café à Natizyskunk : https://www.buymeacoffee.com/Natizyskunk
- PayPal : https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### Communauté

- **Discussions** : rejoignez les conversations sur [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions)
- **Contributions** : consultez les [issues étiquetées « good first issue »](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue)

---

## 📜 Licence

Distribué sous la Licence **MIT**. Voir [LICENSE](LICENSE) pour plus d'informations.

> La licence MIT vous permet d'utiliser, de copier, de modifier, de fusionner, de publier, de distribuer, de sous-licencier et/ou de vendre des copies du logiciel sans restrictions, à condition d'inclure l'avis de copyright.

---

## 👨‍💻 Auteur

**Jose Alexis Correa Valencia**
*Full Stack Developer & Software Architect*

Fort de plus de 25 ans d'expérience dans le développement de logiciels d'entreprise, spécialisé dans les architectures évolutives et les solutions PHP modernes.

- **GitHub** : [@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn** : [Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **Email** : jalexiscv@gmail.com
- **Localisation** : Colombie 🇨🇴

---

## ❤️ Dons

Si cette extension vous a aidé, vous ou votre entreprise, envisagez de soutenir son développement et sa maintenance continue.

| Méthode | Détails |
|--------|----------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi (Colombie)** | `3117977281` |

### Les avantages de votre soutien

Votre don contribue à :
- ⚡ Accélérer le développement de nouvelles fonctionnalités
- 📚 Créer davantage de documentation et d'exemples
- 🧪 Améliorer la couverture de tests
- 🐛 Traiter davantage de corrections du backlog d'issues
- 🌍 Garder le projet actif et à jour

*Merci pour votre soutien !* 🙏
