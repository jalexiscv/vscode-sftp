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

Chaque correction a été vérifiée (build webpack propre, 42/42 tests, linter sans erreurs) avant publication. Le détail de chaque changement se trouve dans [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

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
code --install-extension sftp-1.20.0.vsix
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
