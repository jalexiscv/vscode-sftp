# SFTP — extensão de sincronização para VS Code (fork corrigido)

🌍 [Español](README.md) (base) · [English](README.en.md) · [中文（简体）](README.zh-CN.md) · **Português (BR)** · [Français](README.fr.md) · [Deutsch](README.de.md)

[![Release](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![Licença: MIT](https://img.shields.io/badge/Licença-MIT-yellow.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**Fork corrigido e mantido por [@jalexiscv](https://github.com/jalexiscv)** da popular extensão de sincronização SFTP/FTP.<br>
Linhagem: fork de [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), por sua vez um fork do já não mantido [plugin SFTP do liximomo](https://github.com/liximomo/vscode-sftp.git).

- 📦 **Instalação (releases VSIX):** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Relatar problemas:** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Histórico completo de mudanças:** [CHANGELOG.md](CHANGELOG.md)

O VSCode-SFTP permite adicionar, editar ou excluir arquivos em um diretório local e sincronizá-los com um diretório de um servidor remoto usando diferentes protocolos de transferência, como FTP ou SSH. A configuração mais básica exige apenas algumas linhas, com um amplo leque de opções específicas disponíveis para atender às necessidades de qualquer usuário. Poderosa e rápida ao mesmo tempo, ajuda os desenvolvedores a economizar tempo ao permitir que usem um editor e um ambiente familiares.

## 📑 Índice

- [Por que este fork existe](#por-que-este-fork-existe)
- [O que atualizamos](#o-que-atualizamos)
- [O que esperamos desta versão](#o-que-esperamos-desta-versão)
- [Instalação](#instalação)
- [Documentação](#documentação)
- [Uso](#uso)
- [Configurações de exemplo](#configurações-de-exemplo)
- [Explorador Remoto](#explorador-remoto)
- [Depuração](#depuração)
- [FAQ](#faq)
- [Créditos e apoio aos autores originais](#créditos-e-apoio-aos-autores-originais)
- [Licença](#-licença) · [Autor](#-autor) · [Doações](#%EF%B8%8F-doações)

---

## Por que este fork existe

Lançamos esta versão porque o projeto original, embora excelente, chegou a um ponto em que já não conseguia servir aos seus usuários:

1. **O projeto upstream está efetivamente sem manutenção.** Seu mantenedor declarou em março de 2025 que não podia continuar trabalhando nele e que a [v1.16.3 (junho de 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) deveria ser considerada a última versão estável. Desde então, acumularam-se ~600 issues sem correção.
2. **A extensão quebrou nos VS Code modernos.** As versões recentes do VS Code incluem um runtime do Node.js no qual a dependência empacotada `ssh2` 1.13 falha com `TypeError: isDate is not a function`, fazendo falhar toda operação SFTP — o bug mais relatado do projeto (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **A branch de desenvolvimento do upstream nem sequer compilava.** Sua branch `develop` tinha erros de compilação de TypeScript e a suíte de testes quebrada, de modo que as correções da comunidade (várias enviadas como pull requests há anos) não tinham caminho para serem publicadas.
4. **Existia um problema de segurança sem solução.** Com a configuração padrão, sincronizar um projeto podia enviar o `.vscode/sftp.json` — com o host, o usuário e a senha do servidor — ao servidor remoto, muitas vezes dentro de um docroot público.

Em vez de deixar que uma ferramenta usada por milhares de desenvolvedores se degradasse, nós a bifurcamos, reparamos seus alicerces (build, testes, linter), corrigimos os bugs mais relatados e nos comprometemos a mantê-la funcionando.

## O que atualizamos

Cada correção foi verificada (build do webpack limpo, 42/42 testes, linter sem erros) antes de ser publicada. O detalhe de cada mudança está em [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — alicerces e correções críticas

| Área | Correção |
|------|------------|
| **Compatibilidade** | `ssh2` atualizado para 1.17.0: corrige *"isDate is not a function"* nos VS Code modernos e habilita formatos de chave OpenSSH modernos e algoritmos rsa-sha2 (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Segurança** | O `.vscode/sftp.json` (credenciais) nunca mais pode ser enviado ao servidor, independentemente da configuração de `ignore` |
| **Confiabilidade** | Reconexão automática após um fechamento do canal SFTP pelo lado do servidor, em vez de travar indefinidamente (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Corrigido o *"Error: Config Not Found"* / `uploadOnSave` que não funcionava quando o casing do caminho reportado diferia do workspace (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | Os padrões de `ignore` agora funcionam de verdade (o matcher gitignore recebia caminhos com separadores `\`) |
| **Configuração** | O `sftp.json` é recarregado quando muda fora do editor — p. ex., uma troca de branch do git (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Os nomes de arquivo não ASCII (chinês, acentos) já não chegam corrompidos nas listagens (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), sem sua regressão no SFTP) |
| **FTP** | As sobrescritas rejeitadas com 550 por servidores proftpd com `mod_rename` são repetidas de forma segura (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | A compilação do código foi restaurada, a infraestrutura de testes foi reparada (Jest 29, Node 22) e todas as violações de lint preexistentes foram limpas |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — segunda rodada

| Área | Correção |
|------|------------|
| **SSH** | `Open SSH in Terminal` agora usa a cadeia de `hop` configurada via ProxyJump do OpenSSH (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Explorador Remoto** | Os symlinks remotos que apontam para diretórios são navegáveis via SFTP — p. ex., deploys do tipo `current -> releases/N` (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` agora é acionado ao salvar documentos notebook como `.ipynb` |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — senhas seguras e CI

| Área | Mudança |
|------|---------|
| **Segurança** | **Salvamento seguro de senhas** com o SecretStorage do VS Code (o chaveiro do sistema): após uma conexão bem-sucedida a extensão oferece lembrar a senha digitada, injeta-a automaticamente nas conexões seguintes e a esquece se o servidor a rejeitar. Novo comando `SFTP: Forget Saved Passwords` e configuração `sftp.promptToSavePassword` |
| **Qualidade** | CI no GitHub Actions (lint, build e testes em cada push/PR) e release automatizada ao publicar uma tag |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — FTP moderno

| Área | Mudança |
|------|---------|
| **FTP** | **Backend FTP migrado do pacote `ftp` abandonado (~10 anos sem manutenção) para o [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)**: UTF-8 nativo, FTPS robusto e modo passivo confiável. Validado contra um servidor FTPS real com um novo teste de integração (baseline `ftp`: 7/8 com `read ECONNRESET`; `basic-ftp`: 8/8). Resolve o grupo de bugs de FTP do backlog (PASV, FTPS com FileZilla, nomes não-ASCII, ECONNRESET) |
| **Nota** | O `basic-ftp` suporta apenas o modo passivo; o modo ativo do FTP (`passive: false`) deixa de ser suportado |

## O que esperamos desta versão

- **Um substituto direto (drop-in).** O mesmo formato de `sftp.json`, os mesmos comandos, os mesmos fluxos de trabalho — as configurações existentes funcionam sem nenhuma migração.
- **Estabilidade sobre o tooling atual.** A extensão deve continuar funcionando nos VS Code e runtimes do Node.js atualizados, que é justamente onde o original quebrou.
- **Segurança por padrão.** Suas credenciais nunca saem da sua máquina como parte de uma sincronização, mesmo com uma lista `ignore` personalizada ou vazia.
- **Um projeto vivo.** Continuaremos fazendo a triagem do backlog do upstream (pedidos como proxies SOCKS5, chaves `.ppk` ou diff de pastas são candidatos para as próximas rodadas), e issues/PRs no [nosso tracker](https://github.com/jalexiscv/vscode-sftp/issues) são bem-vindos.
- **Qualidade verificável.** Nenhuma release é publicada sem build limpo, suíte de testes verde e linter sem erros; cada mudança fica documentada em [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

---

## Instalação

> ⚠️ **Desinstale ou desabilite primeiro qualquer outra extensão SFTP** (a do liximomo ou a do Natizyskunk): elas registram os mesmos comandos `sftp.*` e entrarão em conflito com esta.

1. Baixe o `sftp-x.y.z.vsix` mais recente na [página de Releases](https://github.com/jalexiscv/vscode-sftp/releases).
2. No VS Code, abra Extensões (Ctrl + Shift + X).
3. Abra o menu "Mais ações" (as reticências no topo) e escolha "Instalar do VSIX…".
4. Localize o arquivo VSIX e selecione-o.
5. Recarregue o VS Code.
6. Pronto!

Ou pela linha de comando:

```
code --install-extension sftp-1.18.0.vsix
```

## Documentação
- [Início](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Configurações](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Configuração comum](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [Configuração SFTP](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [Configuração FTP](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Comandos](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> O wiki do upstream (em inglês) continua sendo a referência para configurações e comandos: este fork mantém compatibilidade total de configuração.

## Uso
Se os arquivos mais recentes já estão em um servidor remoto, você pode começar com uma pasta local vazia, baixar o projeto e, a partir daí, sincronizar.

1. No `VS Code`, abra o diretório local que você quer sincronizar com o servidor remoto (ou crie um diretório vazio para baixar primeiro o conteúdo de uma pasta do servidor e editá-la localmente).
2. Pressione `Ctrl+Shift+P` no Windows/Linux ou `Cmd+Shift+P` no Mac para abrir a paleta de comandos e execute o comando `SFTP: config`.
3. Um arquivo de configuração básico chamado `sftp.json` aparecerá dentro do diretório `.vscode`; abra-o e edite os parâmetros com as informações do seu servidor remoto.

Por exemplo:
```json
{
    "name": "Nome do perfil",
    "host": "host_do_servidor_remoto",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "usuario",
    "remotePath": "/public_html/project", // <--- Este é o caminho que será baixado com "Download Project"
    "password": "senha",
    "uploadOnSave": false
}
```
O parâmetro `password` do `sftp.json` é opcional; se você o omitir, a senha será solicitada ao sincronizar.
_Nota:_ as barras invertidas e outros caracteres especiais devem ser escapados com uma barra invertida.

4. Salve e feche o arquivo `sftp.json`.
5. Pressione `Ctrl+Shift+P` no Windows/Linux ou `Cmd+Shift+P` no Mac para abrir a paleta de comandos.
6. Digite `sftp` e você verá os demais comandos disponíveis. Muitos deles também estão nos menus de contexto do explorador de arquivos do projeto.
7. Um bom comando para começar, se você quiser sincronizar com uma pasta remota, é o `SFTP: Download Project`: ele baixa o diretório indicado em `remotePath` do `sftp.json` para o seu diretório local aberto.
8. Feito — agora você pode editar localmente e, após cada salvamento, o arquivo será enviado para manter a cópia remota sincronizada com a local.
9. Aproveite!

Para explicações detalhadas, visite o [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Configurações de exemplo
Você pode ver a lista completa de opções de configuração [aqui](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Simples](#simples)
- [Perfis](#perfis)
- [Múltiplos contextos](#múltiplos-contextos)
- [Conexão com saltos (hopping)](#conexão-com-saltos-hopping)
- [Configuração nas configurações do usuário](#configuração-nas-configurações-do-usuário)

### Simples
```json
{
  "host": "host",
  "username": "usuario",
  "remotePath": "/remote/workspace"
}
```

### Perfis
```json
{
  "username": "usuario",
  "password": "senha",
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

_Nota:_ `context` e `watcher` só estão disponíveis no nível raiz.

Use `SFTP: Set Profile` para trocar de perfil.

### Múltiplos contextos
Os contextos **não devem ser iguais**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "usuario",
    "password": "senha",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "usuario",
    "password": "senha",
    "remotePath": "/remote/project/src"
  }
]
```

_Nota:_ `name` é obrigatório neste modo.

### Conexão com saltos (hopping)
Você pode se conectar a um servidor de destino através de um proxy com o protocolo ssh.

_Nota:_ a substituição de variáveis não funciona dentro de uma configuração `hop`.

#### Salto único
local -> salto -> destino
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // salto
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- O arquivo de chave é assumido na máquina local.

  "hop": {
    // destino
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- O arquivo de chave é assumido no salto.
  }
}
```

#### Saltos múltiplos
local -> saltoA -> saltoB -> destino
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // saltoA
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- O arquivo de chave é assumido na máquina local.

  "hop": [
    // saltoB
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- O arquivo de chave é assumido no saltoA.
    },

    // destino
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- O arquivo de chave é assumido no saltoB.
    }
  ]
}
```

### Configuração nas configurações do usuário
Você pode usar `remote` para indicar ao sftp que pegue a configuração do [remote-fs](https://github.com/liximomo/vscode-remote-fs).

Nas configurações do usuário:
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

No sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

## Explorador Remoto
![previa-do-explorador-remoto](assets/showcase/remote-explorer.png)

O Explorador Remoto permite explorar os arquivos do servidor. Você pode abri-lo assim:

1. Execute o comando `View: Show SFTP`.
2. Clique na visualização SFTP da barra de atividades.

Com o Explorador Remoto você só pode visualizar o conteúdo dos arquivos. Execute o comando `SFTP: Edit in Local` para editá-los localmente.

Desde a v1.16.5, os diretórios com link simbólico no remoto também são navegáveis.

### Seleção múltipla
Você pode selecionar vários arquivos/pastas de uma vez no servidor remoto para baixá-los ou enviá-los. Basta manter pressionado Ctrl ou Shift enquanto seleciona os arquivos desejados, assim como no explorador normal.

_Nota:_ se o explorador não for atualizado corretamente após **excluir** um arquivo, atualize manualmente a pasta pai.

### Ordenação
Você pode ordenar o Explorador Remoto adicionando o parâmetro `remoteExplorer.order` dentro do seu arquivo de configuração `sftp.json`.

No sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- O valor padrão é 0.
  }
}
```

## Depuração
1. Abra as configurações de usuário.
  - No Windows/Linux: `File > Preferences > Settings`
  - No macOS: `Code > Preferences > Settings`
2. Ative `sftp.debug` (`true`) e recarregue o VS Code.
3. Consulte os logs em `View > Output > sftp`.

## FAQ
Você pode ver todas as perguntas frequentes (em inglês) [aqui](./FAQ.md).

## Créditos e apoio aos autores originais
Este fork se apoia no trabalho de [@liximomo](https://github.com/liximomo) (autor original) e [@Natizyskunk](https://github.com/Natizyskunk) (mantenedor do fork do qual este deriva). Se esta extensão ajudou você ao longo desses anos, considere apoiá-los:

- Pague um café para o Natizyskunk: https://www.buymeacoffee.com/Natizyskunk
- PayPal: https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### Comunidade

- **Discussões**: Participe das conversas no [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions)
- **Contribuições**: Confira as [issues marcadas como "good first issue"](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue)

---

## 📜 Licença

Distribuído sob a Licença **MIT**. Veja [LICENSE](LICENSE) para mais informações.

> A licença MIT permite usar, copiar, modificar, mesclar, publicar, distribuir, sublicenciar e/ou vender cópias do software sem restrições, desde que o aviso de copyright seja incluído.

---

## 👨‍💻 Autor

**Jose Alexis Correa Valencia**
*Full Stack Developer & Software Architect*

Com mais de 25 anos de experiência em desenvolvimento de software empresarial, especializado em arquiteturas escaláveis e soluções PHP modernas.

- **GitHub**: [@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn**: [Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **Email**: jalexiscv@gmail.com
- **Localização**: Colômbia 🇨🇴

---

## ❤️ Doações

Se esta extensão ajudou você ou o seu negócio, considere apoiar seu desenvolvimento e manutenção contínuos.

| Método | Detalhes |
|--------|----------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi (Colômbia)** | `3117977281` |

### Benefícios do seu apoio

Sua doação ajuda a:
- ⚡ Acelerar o desenvolvimento de novas funcionalidades
- 📚 Criar mais documentação e exemplos
- 🧪 Melhorar a cobertura de testes
- 🐛 Atender mais correções do backlog de issues
- 🌍 Manter o projeto ativo e atualizado

*Obrigado pelo seu apoio!* 🙏
