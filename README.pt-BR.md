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
- [Novidades da v1.30.0](#novidades-da-v1300)
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

Cada correção foi verificada (build do webpack limpo, 957 testes, linter sem erros) antes de ser publicada. O detalhe de cada mudança está em [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

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

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — gerenciador de conexões

| Área | Mudança |
|------|---------|
| **UI** | **Novo Gerenciador de Conexões** (`SFTP: Open Connection Manager`, também pela engrenagem da visão Remote Explorer): painel gráfico para criar, editar, duplicar, excluir, testar e ativar as conexões/perfis do `sftp.json` sem editar o JSON à mão. Ao salvar, os serviços recarregam sozinhos; "Testar conexão" reutiliza a mecânica real de conexão (incluindo senhas salvas) |
| **Qualidade** | Modo `strict` do TypeScript ativado (`noImplicitAny` adiado) e 26 erros reais de tipos corrigidos, incluindo um crash latente do observer de estado dos perfis |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — perfil ativo estável e exclusão de temporários

| Área | Mudança |
|------|---------|
| **Transferências** | Todo arquivo ou pasta cujo nome contenha `.tmp` fica permanentemente excluído das transferências (uploads, `uploadOnSave` e sync), em todos os servidores e sem configurar nada no `ignore` |
| **Perfis** | O perfil ativado com `SFTP: Set Profile` ou com o Gerenciador de Conexões não "muda mais sozinho": os recarregamentos do `sftp.json` deixam de restaurá-lo ao `defaultProfile`, e a seleção persiste entre reinicializações do VSCode. O `defaultProfile` passa a ser apenas o valor inicial e o recurso quando o perfil ativo desaparece |

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — espelho local-remoto seguro

| Área | Mudança |
|------|---------|
| **Transferências** | Os arquivos temporários nunca são enviados: uma lista integrada exclui os arquivos de swap e de backup dos editores, os bloqueios do Office, os restos de merge, os downloads incompletos e os metadados do sistema, em todos os servidores e sem configurar nada (`ignoreTempFiles`, `tempFilePatterns`) |
| **Exclusões** | As exclusões locais são replicadas no servidor (`deleteRemoteOnLocalDelete`, ativo por padrão), com quatro salvaguardas: confirmação modal acima de `deleteRemoteConfirmThreshold` (10), descarte das exclusões provocadas pelo git, autossupressão durante `Sync Remote -> Local --delete` e lixeira remota |
| **Lixeira remota** | Com `remoteTrash`, excluir é um `rename` do lado do servidor para uma pasta de lixeira, reversível com `SFTP: Undo Last Remote Deletion` e `SFTP: Restore from Remote Trash`; `SFTP: Empty Remote Trash` a esvazia e o que expirou é purgado depois dos `retentionDays` |
| **Renomeações** | `renameRemoteOnLocalRename` replica renomear e mover como um `rename` remoto, sem reenviar e sem nenhum instante em que o caminho falte no servidor |
| **UI** | Visão de atividade com o histórico de cada transferência, exclusão e renomeação, e repetições (`sftp.showActivityView`); modo pausa (`SFTP: Pause/Resume Auto Sync`) que suspende toda a sincronização automática |
| **Endurecimento** | Duas passagens de revisão adversarial antes de publicar: salvaguarda do git avaliada ao enfileirar, um único caminho de exclusão, caminhos de lixeira inseguros rejeitados, perfil da exclusão respeitado ao restaurar e purgar, purga que varre o próprio diretório remoto |

### [v1.24.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.24.0) — mudanças externas e verificação de envio

| Área | Mudança |
|------|---------|
| **Mudanças externas** | Um índice de sincronização persistente lembra, por servidor, qual versão de cada arquivo foi enviada e verificada pela última vez; a árvore local é comparada com ele ao iniciar, ao recarregar o `sftp.json`, ao retomar, ao recuperar o foco depois de cinco minutos, sob demanda (`SFTP: Scan for External Changes`) e, opcionalmente, por sondagem periódica (`watcher.pollInterval`), de modo que as edições feitas fora do editor — ou com o VS Code fechado — são enviadas por meio de um plano sem listar o servidor. `SFTP: Rebuild Sync Index` semeia o índice no primeiro uso; chaves `externalChanges.scanOnStartup`, `scanOnResume`, `confirmThreshold` |
| **Um único coletor de mudanças** | `uploadOnSave` e o watcher não enviam mais duas vezes o mesmo salvamento: os salvamentos do editor sobem imediatamente, as mudanças externas são agrupadas (700 ms) e deduplicadas por caminho |
| **Planos de envio** | Cada lote é um plano (origem, motivo por arquivo, estado, tentativas, erro) visível no grupo "Upload plans" da visão de atividade, com `SFTP: Preview Upload (Dry Run)`, `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` e `SFTP: Clear Upload Plans`; a barra de status mostra `↑N` pendentes e `✗N` com falha. Acima de `externalChanges.confirmThreshold` (20), depois de uma operação git ou quando o lote contém arquivos que o índice nunca viu, uma caixa de diálogo modal pergunta antes (`Review plan`, `Upload N file(s)`, `Skip` — e o `Skip` é lembrado) |
| **Verificação de envio** | Todo envio conta os bytes enviados e, com `verifyUpload: "stat"` (padrão), confere que o tamanho remoto coincide exatamente; `"hash"` compara ainda um digest via SSH ou FTP e degrada para `stat` se o servidor não souber calculá-lo. Falhas transitórias são repetidas (`uploadRetries`, 2); erros permanentes não |
| **Registro de atividade persistente** | Cada tarefa — venha de um comando, de um salvamento ou do watcher — é registrada com o caminho remoto e o resultado da verificação, e sobrevive aos recarregamentos da janela (`activity-log.json`); as falhas anteriores à transferência (conexão, credenciais, permissões) também aparecem |
| **Correções e endurecimento** | `uploadFile()` rejeita quando a transferência falha; a supressão da sincronização automática durante downloads passa a valer de fato; os padrões `dir/` do `ignore` podam a subárvore; laços de symlinks são cortados; erros SFTP numéricos são descritos. Duas revisões adversariais antes de publicar; enquanto o índice não é semeado, as varreduras automáticas só reenviam o que a própria extensão enviou |

### [v1.25.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.25.0) — exclusão só de envio

| Área | Mudança |
|------|---------|
| **Exclusão só de envio (`uploadExclude`)** | Uma lista de padrões gitignore, com a mesma sintaxe e ancoragem do `ignore`, que nunca viaja para o servidor: `Upload File` / `Upload Folder` / `Upload Project`, `uploadOnSave`, o watcher, varreduras e planos, `Upload Changed Files` e `Sync Local -> Remote` (com `syncOption.delete`, a cópia remota também não é apagada). Num perfil, soma-se à lista base |
| **O servidor mantém sua cópia** | Apagar ou renomear localmente um caminho excluído não toca no servidor (`deleteRemoteOnLocalDelete`, `renameRemoteOnLocalRename`, `watcher.autoDelete`); `Rebuild Sync Index` o poda dos dois lados |
| **O que não muda** | Downloads, `Sync Remote -> Local`, o explorador remoto e o diff continuam vendo esses caminhos; `Force Upload` ignora a lista, como ignora o `ignore`. Um comando de envio sobre um caminho excluído avisa numa notificação e não conecta; `Upload Changed Files` lista os arquivos separados num grupo próprio |
| **Correção** | Uma exclusão local cujo padrão `dir/` do `ignore` só casa como diretório não é mais espelhada no servidor: o caminho apagado agora é testado como arquivo e como diretório |

### [v1.26.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.26.0) — dar como enviado e exclusões pela interface

| Área | Mudança |
|------|---------|
| **Dar como enviado (`Mark as uploaded`)** | Um quarto botão no diálogo de confirmação de qualquer plano, e `Mark Plan as Uploaded` / `Mark as Uploaded` sobre um plano ou um arquivo na visão de atividade: os arquivos são registrados no índice como já presentes no servidor, na versão atual, sem transferir nada, e não voltam a ser propostos até mudarem. Estado próprio `assumed`, distinto de `verified` em resumos, relatórios e ícones |
| **Semear o índice sem listar o servidor** | `SFTP: Mark Local Files as Uploaded` (também `Mark all as uploaded` no aviso de índice não construído) percorre a árvore local, mostra a contagem e, ao confirmar, semeia o índice com tudo o que há em local; daí em diante só se propõe o que mudar. A alternativa rápida ao `Rebuild Sync Index` para sites com dezenas de milhares de arquivos por FTP |
| **Exclusões de envio pela interface** | Clique direito numa pasta → `SFTP: Exclude from Upload` (e `SFTP: Include in Upload Again` numa já excluída), `SFTP: Manage Upload Exclusions` para revisar, adicionar ou remover entradas, e uma lista com `×` no gerenciador de conexões. Tudo escreve a lista `uploadExclude` do `sftp.json`, respeitando seu formato |
| **Segurança** | A linha `config at …` do canal de saída mascarava a senha da raiz, mas não a de cada perfil; agora mascara ambas |

### [v1.27.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.27.0) — limites para projetos grandes e armazenamento limpo por versão

| Área | Mudança |
|------|---------|
| **Limite por plano (`externalChanges.maxPlanItems`)** | Uma varredura, um tick de sondagem ou uma rajada do watcher que encontra mais arquivos alterados que o limite (2000 por padrão; `0` o remove) não vira mais um plano: um aviso informa a contagem e oferece `Mark all as uploaded` (a árvore local passa a ser a referência) e `Manage upload exclusions`; a terceira saída é enviar o projeto uma vez e varrer de novo. As varreduras automáticas dessa conexão esperam uma varredura manual, um rebuild, um dar como enviado ou uma recarga do `sftp.json`; o coletor descarta a rajada antes de um único `stat` e avisa uma vez por sessão |
| **Visão de atividade paginada** | Um plano lista seus primeiros 200 arquivos e uma linha `N more file(s)…` que mostra a página seguinte; antes a árvore materializava uma linha por item a cada atualização, várias vezes por arquivo enviado |
| **Índice gravado com calma** | Enquanto um plano roda, o índice de sincronização é salvo uma vez por minuto em vez de uma vez por segundo (cada envio verificado o marcava como sujo), e mais uma vez ao terminar; um salvamento explícito nunca é retido |
| **Armazenamento limpo por versão** | Na primeira vez que uma versão nova é ativada num workspace, o índice de sincronização e o log de atividade da anterior são descartados antes de serem carregados (o canal de saída registra); o índice começa vazio e o aviso para semeá-lo ou reconstruí-lo volta, como no primeiro uso. Nada do projeto é tocado |

### [v1.28.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.28.0) — conexão resiliente

| Área | Mudança |
|------|---------|
| **Envios em espera, não falhos** | Ao perder a conexão, a tarefa interrompida e as que ainda estavam na fila voltam a `pending` com `on hold: <motivo>`, o plano continua aberto (as varreduras não planejam esses arquivos de novo por cima), o índice não é tocado e há **um aviso por servidor e por queda** em vez de um diálogo por arquivo. Os comandos (`Upload Project`, `Sync…`) informam uma vez, com o que foi feito, interrompido e não tentado |
| **Reconexão com espera crescente** | Cada conexão lembra suas tentativas falhas e retém as novas por 1 s, 2 s, 4 s… até um minuto (um minuto no mínimo após um `421`); enquanto isso quem a pedir recebe `connection is down; next attempt in N s` sem abrir um socket. Quando a conexão volta, os planos em espera retomam sozinhos; se não volta, tentam de novo com essa espera até dez vezes e depois aguardam na visão de atividade |
| **Menos conexões FTP** | Uma conexão FTP sem comandos por cinco minutos é fechada (o `NOOP` não conta) e reaberta no próximo uso; antes, uma por perfil, por entrada do `sftp.json` e por janela ficava viva a sessão inteira. Um comando que morre com o socket avisa na hora, não no próximo tick do keepalive; trocar de perfil fecha a conexão do perfil anterior; um `close` tardio de um cliente SSH morto não derruba mais a conexão que o substituiu |
| **Menos falsas mudanças** | `.git`, `.svn` e `.hg` são ignorados por padrão em qualquer profundidade (a integração git do editor reescreve `.git/index` e `FETCH_HEAD` a cada `status`; `"!.git"` em `ignore` recupera um deles), e um evento do watcher ou um salvamento sobre um arquivo cujo tamanho e mtime (ao segundo) são os que o índice verificou não é mais planejado: um evento não é uma edição |

### [v1.29.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.29.0) — impressão digital do conteúdo

| Área | Mudança |
|------|---------|
| **Impressão digital do conteúdo** | Cada upload verificado guarda no índice o SHA-1 dos bytes enviados, calculado sobre o próprio fluxo (nada é lido duas vezes); os downloads também. Um escaneamento, um evento do watcher, uma sondagem ou uma prévia que encontra um arquivo com o mesmo tamanho e outro mtime o lê uma vez, compara a impressão e, se coincidir, o deixa em paz e move a entrada para o mtime novo para não lê-lo de novo; só bytes diferentes o tornam `modified`. Um tamanho diferente continua sendo mudança sem leitura; arquivos acima de 64 MB mantêm a regra de tamanho e mtime |
| **Semeadura com impressão digital** | `SFTP: Rebuild Sync Index` e `SFTP: Mark Local Files as Uploaded` leem os arquivos que registram (progresso `N fingerprinted`, cancelável), e `Mark as uploaded` e `Skip` em um plano fazem o mesmo com os seus: a partir daí um `touch` ou um checkout idêntico já não é uma mudança. O canal de saída conta o que foi reconhecido (`N file(s) rewritten with the same content, not planned`) |
| **`externalChanges.compareContent`** | Chave nova, `true` por padrão. Desligada, nenhum arquivo é lido nem nenhuma impressão é anotada, e a extensão se comporta exatamente como a 1.28.0 |
| **Índices existentes** | As entradas anteriores não têm impressão digital e seguem a regra antiga até que um upload, um rebuild ou um marcar como enviado a anotem. Para cobrir de uma vez um projeto já sincronizado, execute uma vez `SFTP: Mark Local Files as Uploaded` (ou `Rebuild Sync Index`) por servidor |

**v1.29.1 (correção).** Arquivos de 0 bytes voltam a subir por FTPS: contra um servidor com TLS 1.3 (Pure-FTPd, por exemplo) cada um deles fechava a sessão com um alerta `decode error` no socket de dados e deixava o plano em espera repetidamente. Além disso, um arquivo em cujo envio a conexão cai três vezes seguidas passa a `failed` e o plano continua com o restante em vez de ficar retido nele.

**v1.29.2 (correção).** Um comando de pasta (`Upload Folder`, `Sync…`, `Download Folder`) interrompido por uma perda de conexão não termina mais ali, com o restante da árvore sem enviar e um diálogo por pasta selecionada: ele espera a conexão voltar, reconecta e continua de onde estava, sem reenviar os arquivos já verificados, até dez vezes, como faz um plano. Além disso, uma pasta selecionada junto com uma de suas subpastas é percorrida uma única vez; antes cada arquivo sob ambas era enviado duas vezes ao mesmo tempo.

## Novidades da v1.30.0

A v1.30.0 fecha uma lacuna da distribuição fora do Marketplace: o VS Code só atualiza por conta própria as extensões que vêm de lá, e uma instalada a partir de um vsix ficava como estava para sempre. Agora a própria extensão consulta a última release do GitHub, avisa quando há uma versão mais nova e, se você pedir, baixa, verifica e instala.

| Novidade | O que traz |
|----------|------------|
| **Aviso de versão nova** | Conforme `sftp.updates.check` (`daily` por padrão: uma vez a cada 24 h; `startup`: em cada ativação; `off`), a extensão consulta a última release de [jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp/releases) 15 s depois de ativar e compara a tag com a versão instalada. Se houver uma maior, oferece `Install`, `Release notes` e `Skip this version`. Nada é instalado sem você pedir; uma falha de rede só deixa uma linha `[updates]` no canal de saída |
| **Instalação verificada** | `Install` baixa o vsix da release para o armazenamento global da extensão, confere seu SHA-256 com o `.sha256` que cada release agora publica (uma release sem ele é instalada sem verificação, com aviso), instala pelo mesmo mecanismo de *Install from VSIX…* e oferece recarregar a janela. Só é aceito um vsix publicado nas releases deste repositório; rascunhos e pré-lançamentos são ignorados, e um build local mais novo nunca é rebaixado |
| **`SFTP: Check for Updates`** | Comando novo que consulta agora mesmo, independentemente da configuração, e responde em todos os casos: em dia, sem vsix ou sem rede. Uma versão pulada com `Skip this version` deixa de ser anunciada sozinha, mas o comando continua a oferecê-la |
| **O que não faz** | Nada é instalado em segundo plano nem a janela é recarregada sem a sua confirmação. As releases anteriores à 1.30.0 não têm checksum: o aviso aparecerá a partir da primeira release publicada depois de instalar esta |

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
code --install-extension sftp-1.30.0.vsix
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
- [Exclusões e renomeações seguras](#exclusões-e-renomeações-seguras)
- [Mudanças externas e verificação de envio](#mudanças-externas-e-verificação-de-envio)

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

### Exclusões e renomeações seguras
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

_Nota:_ todos esses valores são os que a extensão já usa por padrão, exceto `tempFilePatterns`, `remoteTrash.path` (`.sftp-trash`) e `remoteTrash.retentionDays` (`7`); só é preciso escrevê-los para alterá-los. Um `path` absoluto mantém a lixeira fora do docroot servido pelo servidor web.

### Mudanças externas e verificação de envio
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

_Nota:_ `externalChanges`, `verifyUpload` e `uploadRetries` levam aqui seus valores padrão; o bloco `watcher` não é necessário para as varreduras (só para reagir às mudanças ao vivo e para `pollInterval`). `verifyUpload: "hash"` acrescenta a checagem de conteúdo e um `pollInterval` em milissegundos ativa a sondagem periódica.

### Pastas que pertencem ao servidor
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

_Nota:_ `storage/` e `public/uploads/` nunca são enviados, e apagá-los localmente nunca os apaga no servidor, mas continuam podendo ser baixados (`Download Folder`, `Sync Remote -> Local`); `*.env` nunca sai da sua máquina. `Force Upload` continua disponível para o caso excepcional.

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
