# SFTP — VS Code 同步扩展（修复版分支）

🌍 [Español](README.md) (base) · [English](README.en.md) · **中文（简体）** · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

[![发布版本](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![许可证: MIT](https://img.shields.io/badge/Licencia-MIT-yellow.svg)](LICENSE)
[![问题](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**由 [@jalexiscv](https://github.com/jalexiscv) 修复并维护的分支**，源自广受欢迎的 SFTP/FTP 同步扩展。<br>
渊源：派生自 [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)，后者又派生自已停止维护的 [liximomo 的 SFTP 插件](https://github.com/liximomo/vscode-sftp.git)。

- 📦 **安装（VSIX 发布版）：** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **报告问题：** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **完整更新历史：** [CHANGELOG.md](CHANGELOG.md)

VSCode-SFTP 允许你在本地目录中添加、编辑或删除文件，并通过 FTP 或 SSH 等多种传输协议将其与远程服务器上的目录同步。最基本的配置只需寥寥几行，同时还提供丰富的专项选项，可满足任何用户的需求。它既强大又快速，让开发者能够在熟悉的编辑器和环境中工作，从而节省时间。

## 📑 目录

- [为什么会有这个分支](#为什么会有这个分支)
- [我们更新了什么](#我们更新了什么)
- [v1.30.0 新功能](#v1300-新功能)
- [我们对这个版本的期望](#我们对这个版本的期望)
- [安装](#安装)
- [文档](#文档)
- [使用方法](#使用方法)
- [配置示例](#配置示例)
- [远程资源管理器](#远程资源管理器)
- [调试](#调试)
- [FAQ](#faq)
- [致谢与支持原作者](#致谢与支持原作者)
- [许可证](#-许可证) · [作者](#-作者) · [捐赠](#%EF%B8%8F-捐赠)

---

## 为什么会有这个分支

我们发布这个版本，是因为原项目虽然出色，却已经到了无法继续服务其用户的地步：

1. **上游项目实际上已无人维护。** 其维护者于 2025 年 3 月声明无法继续开发，并表示 [v1.16.3（2023 年 6 月）](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) 应被视为最后一个稳定版本。此后已累积约 600 个未修复的 issue。
2. **该扩展在现代 VS Code 中已经失效。** 较新的 VS Code 内置的 Node.js 运行时会使打包的 `ssh2` 1.13 依赖抛出 `TypeError: isDate is not a function`，导致所有 SFTP 操作失败——这是该项目被报告最多的 bug（上游 [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586)、[#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)）。
3. **上游的开发分支甚至无法编译。** 其 `develop` 分支存在 TypeScript 编译错误，测试套件也已损坏，导致社区的修复（其中多个以 pull request 形式提交已有数年）没有任何发布渠道。
4. **存在一个未解决的安全问题。** 在默认配置下，同步项目可能会把 `.vscode/sftp.json`——包含服务器主机、用户名和密码——上传到远程服务器，而且往往位于公开的文档根目录（docroot）内。

我们没有任由这个被成千上万开发者使用的工具继续退化，而是将其分支出来，修复了它的根基（构建、测试、代码检查），修正了报告最多的 bug，并承诺让它持续可用。

## 我们更新了什么

每项修复在发布前都经过验证（webpack 构建干净、957 项测试通过、代码检查无错误）。每个变更的详细信息见 [documents/Changelogs](documents/Changelogs/CHANGELOG.md)。

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — 根基与关键修复

| 领域 | 修复内容 |
|------|------------|
| **兼容性** | `ssh2` 升级到 1.17.0：修复现代 VS Code 中的 *"isDate is not a function"*，并启用现代 OpenSSH 密钥格式和 rsa-sha2 算法（上游 [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586)、[#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)、PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)） |
| **安全性** | `.vscode/sftp.json`（凭据）再也不可能被上传到服务器，无论 `ignore` 如何配置 |
| **可靠性** | 服务器端关闭 SFTP 通道后会自动重连，而不是无限期挂起（上游 PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)） |
| **Windows** | 修复了当系统报告的路径大小写与工作区不一致时出现的 *"Error: Config Not Found"* / `uploadOnSave` 失效问题（上游 PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)） |
| **Windows** | `ignore` 模式现在真正生效（此前 gitignore 匹配器收到的是使用 `\` 分隔符的路径） |
| **配置** | 当 `sftp.json` 在编辑器外部被修改时会重新加载——例如切换 git 分支（上游 PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)） |
| **FTP** | 非 ASCII 文件名（中文、重音字符）在列表中不再乱码（上游 PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443)，且不带其 SFTP 回归问题） |
| **FTP** | 被启用 `mod_rename` 的 proftpd 服务器以 550 拒绝的覆盖操作会安全地重试（上游 [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)） |
| **构建** | 恢复了代码编译，修复了测试基础设施（Jest 29、Node 22），并清理了所有既有的 lint 违规 |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — 第二轮

| 领域 | 修复内容 |
|------|------------|
| **SSH** | `Open SSH in Terminal` 现在会通过 OpenSSH 的 ProxyJump（`-J`）使用所配置的 `hop` 链（上游 [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)） |
| **远程资源管理器** | 指向目录的远程符号链接可以通过 SFTP 浏览——例如 `current -> releases/N` 之类的部署（上游 [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)） |
| **Notebooks** | 保存 `.ipynb` 等 notebook 文档时现在会触发 `uploadOnSave` |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — 安全密码与 CI

| 领域 | 变更 |
|------|------|
| **安全** | 通过 VS Code SecretStorage（操作系统钥匙串）**安全保存密码**：连接成功后会询问是否记住输入的密码，之后的连接自动注入，服务器拒绝时自动遗忘。新增 `SFTP: Forget Saved Passwords` 命令和 `sftp.promptToSavePassword` 设置 |
| **质量** | GitHub Actions CI（每次 push/PR 运行 lint、构建和测试），并在打 tag 时自动打包发布 |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — 现代化 FTP

| 领域 | 变更 |
|------|------|
| **FTP** | **将 FTP 后端从已废弃的 `ftp` 包（约 10 年无人维护）迁移到 [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)**：原生 UTF-8、稳健的 FTPS 和可靠的被动模式。通过针对真实 FTPS 服务器的新集成测试验证（`ftp` 基线：7/8，出现 `read ECONNRESET`；`basic-ftp`：8/8）。解决了 backlog 中的 FTP 缺陷群（PASV、FileZilla 的 FTPS、非 ASCII 名称、ECONNRESET） |
| **注意** | `basic-ftp` 仅支持被动模式；不再支持 FTP 主动模式（`passive: false`） |

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — 连接管理器

| 领域 | 变更 |
|------|------|
| **界面** | **全新连接管理器**（`SFTP: Open Connection Manager`，也可通过 Remote Explorer 视图的齿轮按钮打开）：图形化面板，可创建、编辑、复制、删除、测试和激活 `sftp.json` 中的连接/配置文件，无需手动编辑 JSON。保存后服务自动重载；"测试连接"复用真实连接机制（包括已保存的密码） |
| **质量** | 启用 TypeScript `strict` 模式（`noImplicitAny` 暂缓），修复 26 个真实类型错误，其中包括配置文件状态观察器的一处潜在崩溃 |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — 稳定的活动配置与临时文件排除

| 领域 | 变更 |
|------|------|
| **传输** | 名称中包含 `.tmp` 的任何文件或文件夹现在都会被永久排除在传输之外（上传、`uploadOnSave` 和同步），适用于所有服务器，无需任何 `ignore` 配置 |
| **配置文件** | 通过 `SFTP: Set Profile` 或连接管理器激活的配置文件不再"自行切换"：重新加载 `sftp.json` 不会再将其重置为 `defaultProfile`，并且所选配置在 VSCode 重启后依然保留。`defaultProfile` 仅作为初始值，以及活动配置文件消失时的回退值 |

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — 安全的本地-远程镜像

| 领域 | 变更 |
|------|------|
| **传输** | 临时文件永远不会被上传：内置列表排除编辑器的交换与备份文件、Office 锁文件、合并残留、未完成的下载和系统元数据，适用于所有服务器且无需配置（`ignoreTempFiles`、`tempFilePatterns`） |
| **删除** | 本地删除会同步到服务器（`deleteRemoteOnLocalDelete`，默认开启），并有四道防线：超过 `deleteRemoteConfirmThreshold`（10）时弹出模态确认、丢弃由 git 引起的删除、在 `Sync Remote -> Local --delete` 期间自我抑制、远程回收站 |
| **远程回收站** | 启用 `remoteTrash` 后，删除是服务器端向回收站目录的一次 `rename`，可用 `SFTP: Undo Last Remote Deletion` 和 `SFTP: Restore from Remote Trash` 恢复；`SFTP: Empty Remote Trash` 清空回收站，过期条目在 `retentionDays` 之后自动清理 |
| **重命名** | `renameRemoteOnLocalRename` 把重命名和移动同步为服务器端的 `rename`，无需重新上传，也不会出现路径在服务器上短暂缺失的时刻 |
| **界面** | 活动视图记录每次传输、删除和重命名并支持重试（`sftp.showActivityView`）；暂停模式（`SFTP: Pause/Resume Auto Sync`）暂停全部自动同步 |
| **加固** | 发布前进行了两轮对抗性审查：git 防线改为入队时评估、删除只有一条路径、拒绝不安全的回收站路径、恢复和清理时尊重删除时所用的配置文件、清理会扫描远程目录本身 |

### [v1.24.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.24.0) — 外部变更与上传验证

| 领域 | 变更 |
|------|------|
| **外部变更** | 一个持久化的同步索引按服务器记住每个文件最后一次上传并验证的版本；在启动时、重新加载 `sftp.json` 时、恢复时、窗口在五分钟后重新获得焦点时、按需执行（`SFTP: Scan for External Changes`）时以及可选的定时轮询（`watcher.pollInterval`）时，都会把本地目录树与该索引比较，因此在编辑器之外——或在 VS Code 关闭期间——做的改动会通过计划上传，而无需列出服务器。`SFTP: Rebuild Sync Index` 在首次使用时建立索引；配置键 `externalChanges.scanOnStartup`、`scanOnResume`、`confirmThreshold` |
| **统一的变更收集器** | `uploadOnSave` 和 watcher 不再把同一次保存上传两次：编辑器的保存立即上传，外部变更会被合批（700 ms）并按路径去重 |
| **上传计划** | 每个批次都是一个计划（来源、每个文件的原因、状态、尝试次数、错误），显示在活动视图的 "Upload plans" 分组中，并配有 `SFTP: Preview Upload (Dry Run)`、`SFTP: Upload Plan`、`SFTP: Export Last Upload Report` 和 `SFTP: Clear Upload Plans`；状态栏显示 `↑N` 个待上传和 `✗N` 个失败。超过 `externalChanges.confirmThreshold`（20）、发生 git 操作之后或批次包含索引从未见过的文件时，会先弹出模态对话框（`Review plan`、`Upload N file(s)`、`Skip`——且 `Skip` 会被记住） |
| **上传验证** | 每次上传都会统计已发送的字节数，并在 `verifyUpload: "stat"`（默认）下检查远程大小是否完全一致；`"hash"` 还会通过 SSH 或 FTP 比较摘要，服务器无法计算时降级为 `stat`。暂时性失败会重试（`uploadRetries`，2 次）；永久性错误不会 |
| **持久化的活动记录** | 每个任务——无论来自命令、保存还是 watcher——都会连同远程路径和验证结果被记录，并在窗口重新加载后保留（`activity-log.json`）；传输开始前的失败（连接、凭据、权限）也会显示 |
| **修复与加固** | `uploadFile()` 在传输失败时会拒绝；下载期间对自动同步的抑制真正生效；`ignore` 中的 `dir/` 模式会整体剪除子树；切断符号链接循环；数字形式的 SFTP 错误有了描述。发布前进行了两轮对抗性评审；在索引建立之前，自动扫描只会重新上传扩展自己上传过的文件 |

### [v1.25.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.25.0) — 仅上传排除

| 领域 | 变更 |
|------|------|
| **仅上传排除（`uploadExclude`）** | 一组 gitignore 模式，语法和锚定方式与 `ignore` 相同，但永远不会传到服务器：`Upload File` / `Upload Folder` / `Upload Project`、`uploadOnSave`、watcher、扫描与计划、`Upload Changed Files` 以及 `Sync Local -> Remote`（启用 `syncOption.delete` 时，远程副本也不会被删除）。在 profile 中它会追加到基础列表上 |
| **服务器保留自己的副本** | 在本地删除或重命名被排除的路径不会影响服务器（`deleteRemoteOnLocalDelete`、`renameRemoteOnLocalRename`、`watcher.autoDelete`）；`Rebuild Sync Index` 会在两侧一并剪除它 |
| **不变的部分** | 下载、`Sync Remote -> Local`、远程资源管理器和对比仍然能看到这些路径；`Force Upload` 会绕过该列表，就像它绕过 `ignore` 一样。对被排除路径执行上传命令时会弹出通知说明，并且不会建立连接；`Upload Changed Files` 会把被搁置的文件单独列成一组 |
| **修复** | 本地删除的路径若只在 `ignore` 的 `dir/` 模式中按目录匹配，将不再被镜像到服务器：被删除的路径现在会同时按文件和按目录进行测试 |

### [v1.26.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.26.0) — 视为已上传与界面中的排除

| 领域 | 变更 |
|------|------|
| **视为已上传（`Mark as uploaded`）** | 任何计划的确认对话框新增第四个按钮，活动视图中的计划或文件上也有 `Mark Plan as Uploaded` / `Mark as Uploaded`：文件以当前版本记入索引，视为已在服务器上，不传输任何内容，直到再次变更前不会被提议。独立的 `assumed` 状态，在摘要、报告和图标中与 `verified` 区分 |
| **无需列出服务器即可播种索引** | `SFTP: Mark Local Files as Uploaded`（索引未构建提示中的 `Mark all as uploaded` 同样可用）遍历本地目录树，显示数量，确认后用本地现有的一切播种索引；此后只提议发生变更的文件。对于通过 FTP 管理数万个文件的站点，这是 `Rebuild Sync Index` 的快速替代方案 |
| **在界面中管理上传排除** | 右键文件夹 → `SFTP: Exclude from Upload`（已排除的文件夹上则显示 `SFTP: Include in Upload Again`），`SFTP: Manage Upload Exclusions` 用于查看、添加或删除条目，连接管理器中也有带 `×` 的列表。它们都写入 `sftp.json` 的 `uploadExclude` 列表并保留其格式 |
| **安全** | 输出通道中的 `config at …` 行只遮蔽了根级密码，未遮蔽每个 profile 的密码；现在两者都会被遮蔽 |

### [v1.27.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.27.0) — 大型项目的上限与按版本清理存储

| 领域 | 变更 |
|------|------|
| **每个计划的上限（`externalChanges.maxPlanItems`）** | 扫描、轮询或 watcher 突发事件发现的变更文件超过上限（默认 2000；`0` 表示不限）时不再生成计划：警告给出数量，并提供 `Mark all as uploaded`（以本地目录树为基准）和 `Manage upload exclusions`；第三条出路是上传一次项目再重新扫描。该连接的自动扫描会等待手动扫描、重建索引、视为已上传或重新加载 `sftp.json`；收集器在执行任何 `stat` 之前就丢弃突发事件，并且每个会话只提示一次 |
| **分页的活动视图** | 计划先列出前 200 个文件，再以一行 `N more file(s)…` 展开下一页；此前每次刷新树都会为每个条目生成一行，每上传一个文件就刷新多次 |
| **从容写入索引** | 计划运行期间，同步索引每分钟保存一次，而不是每秒一次（每个已验证的上传都会将其标记为脏），结束时再保存一次；显式保存从不被延迟 |
| **每个版本的干净存储** | 新版本在某个工作区首次激活时，会在加载前丢弃上一版本的同步索引和活动日志（输出通道会记录）；索引从空开始，播种或重建索引的提示会再次出现，如同首次使用。项目内的任何内容都不会被触碰 |

### [v1.28.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.28.0) — 弹性连接

| 领域 | 变更 |
|------|------|
| **上传进入等待，而非失败** | 连接丢失时，被中断的任务和仍在队列中的任务回到 `pending`，错误为 `on hold: <原因>`，计划保持打开（扫描不会在其上重复规划这些文件），索引不被触碰，并且**每个服务器每次断线只有一条警告**，而不是每个文件一个对话框。命令（`Upload Project`、`Sync…`）只报告一次，说明已完成、被中断和未尝试的数量 |
| **递增延迟的重连** | 每个连接记住失败的尝试，并把新的尝试延后 1 秒、2 秒、4 秒……最多一分钟（`421` 之后至少一分钟）；期间请求该连接的一方会立刻收到 `connection is down; next attempt in N s`，不会打开套接字。连接恢复后，等待中的计划自动恢复；若未恢复，则按该延迟最多重试十次，之后在活动视图中等待 |
| **更少的 FTP 连接** | 五分钟没有命令的 FTP 连接会被关闭（`NOOP` 不算），下次使用时重新打开；此前每个配置文件、每个 `sftp.json` 条目、每个窗口各保持一条连接直到会话结束。随套接字一起中断的命令会立即报告，而不是等到下一次 keepalive；切换配置文件会关闭前一个配置文件的连接；已断开的 SSH 客户端迟到的 `close` 不再拆掉替代它的连接 |
| **更少的误报更改** | `.git`、`.svn` 和 `.hg` 在任何深度默认被忽略（编辑器的 git 集成每次 `status` 都会重写 `.git/index` 和 `FETCH_HEAD`；在 `ignore` 中写 `"!.git"` 可恢复），对大小和 mtime（精确到秒）与索引已验证版本一致的文件，watcher 事件或保存不再规划上传：事件不等于编辑 |

### [v1.29.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.29.0) — 内容指纹

| 领域 | 变更 |
|------|------|
| **内容指纹** | 每次经过验证的上传都会在索引中记录所发送字节的 SHA-1，直接在数据流上计算（任何文件都不会被读两次）；下载同样如此。扫描、watcher 事件、轮询或预览发现一个大小相同但 mtime 不同的文件时，会读取一次并比较指纹：一致则不再处理，并把索引条目移到新的 mtime，以免再次读取；只有字节不同才算 `modified`。大小不同仍然无需读取即视为变更；超过 64 MB 的文件保留大小加 mtime 的规则 |
| **带指纹的索引播种** | `SFTP: Rebuild Sync Index` 和 `SFTP: Mark Local Files as Uploaded` 会读取它们记录的文件（进度显示 `N fingerprinted`，可取消），计划中的 `Mark as uploaded` 和 `Skip` 对各自的文件也一样：从此以后 `touch` 或内容相同的 checkout 不再是变更。输出通道会统计识别出的数量（`N file(s) rewritten with the same content, not planned`） |
| **`externalChanges.compareContent`** | 新配置项，默认 `true`。关闭后不读取任何文件，也不记录任何指纹，扩展的行为与 1.28.0 完全一致 |
| **已有的索引** | 此前写入的条目没有指纹，会沿用旧规则，直到某次上传、重建或"标记为已上传"为其记录指纹。要一次性覆盖已同步的项目，请对每个服务器运行一次 `SFTP: Mark Local Files as Uploaded`（或 `Rebuild Sync Index`） |

**v1.29.1（修复）。** 0 字节的文件可以重新通过 FTPS 上传：面对使用 TLS 1.3 的服务器（例如 Pure-FTPd），每个空文件都会让数据套接字收到 `decode error` 警报并关闭会话，使计划一次又一次进入等待。此外，如果某个文件在上传时连续三次导致连接中断，它会被标记为 `failed`，计划继续处理其余文件，而不再被它卡住。

**v1.29.2（修复）。** 被连接中断打断的文件夹命令（`Upload Folder`、`Sync…`、`Download Folder`）不再就此终止、留下其余目录树未上传并为每个选中的文件夹弹出一个对话框：它会等待连接恢复，重新连接并从中断处继续，不会重新发送已经验证过的文件，最多重试十次，与计划的行为一致。此外，与其子文件夹一同选中的文件夹只会被遍历一次；以前两者之下的每个文件都会被同时上传两次。

## v1.30.0 新功能

v1.30.0 补上了在 Marketplace 之外分发的一个缺口：VS Code 只会自动更新来自 Marketplace 的扩展，从 vsix 安装的扩展会永远保持原样。现在扩展会自行向 GitHub 查询最新 release，在有新版本时提醒你，并在你确认后下载、校验并安装。

| 新功能 | 作用 |
|--------|------|
| **新版本提醒** | 按照 `sftp.updates.check`（默认 `daily`：每 24 小时一次；`startup`：每次激活；`off`），扩展在激活 15 秒后查询 [jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp/releases) 的最新 release，并把标签与已安装版本比较。若有更新的版本，会提供 `Install`、`Release notes` 和 `Skip this version`。未经你同意不会安装任何东西；网络故障只会在输出通道留下一行 `[updates]` |
| **经过校验的安装** | `Install` 把 release 的 vsix 下载到扩展的全局存储，用每个 release 现在发布的 `.sha256` 校验其 SHA-256（没有校验和的 release 会在警告后不经校验地安装），通过与 *Install from VSIX…* 相同的机制安装，并提示重新加载窗口。只接受本仓库 release 中发布的 vsix；草稿和预发布版本会被忽略，更新的本地构建也不会被降级 |
| **`SFTP: Check for Updates`** | 新命令，无论设置如何都立即查询，并在所有情况下给出答复：已是最新、没有 vsix 或没有网络。用 `Skip this version` 跳过的版本不再自动提醒，但该命令仍会提供它 |
| **它不会做的事** | 不会在后台安装任何东西，也不会在未经你确认的情况下重新加载窗口。1.30.0 之前的 release 没有校验和：提醒会从安装本版本之后发布的第一个 release 开始出现 |

## 我们对这个版本的期望

- **直接替换（drop-in）。** 相同的 `sftp.json` 格式、相同的命令、相同的工作流——现有配置无需任何迁移即可使用。
- **在当前工具链上保持稳定。** 该扩展必须在最新的 VS Code 和 Node.js 运行时上持续可用，而这正是原版失效的地方。
- **默认安全。** 你的凭据永远不会作为同步的一部分离开你的机器，即使 `ignore` 列表是自定义的或为空。
- **一个活跃的项目。** 我们会继续梳理上游的积压需求（SOCKS5 代理、`.ppk` 密钥或文件夹对比等请求是下一轮的候选），并欢迎在[我们的问题跟踪器](https://github.com/jalexiscv/vscode-sftp/issues)提交 issue/PR。
- **可验证的质量。** 任何版本发布前都必须构建干净、测试套件全部通过、代码检查无错误；每个变更都记录在 [documents/Changelogs](documents/Changelogs/CHANGELOG.md) 中。

---

## 安装

> ⚠️ **请先卸载或禁用任何其他 SFTP 扩展**（liximomo 或 Natizyskunk 的版本）：它们注册相同的 `sftp.*` 命令，会与本扩展冲突。

1. 从 [Releases 页面](https://github.com/jalexiscv/vscode-sftp/releases)下载最新的 `sftp-x.y.z.vsix`。
2. 在 VS Code 中打开扩展面板（Ctrl + Shift + X）。
3. 打开"更多操作"菜单（顶部的省略号），选择"从 VSIX 安装…"。
4. 找到该 VSIX 文件并选中它。
5. 重新加载 VS Code。
6. 完成！

或者通过命令行：

```
code --install-extension sftp-1.30.0.vsix
```

## 文档
- [首页](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [设置](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [通用配置](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP 配置](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP 配置](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [命令](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> 上游的 wiki（英文）仍然是设置和命令的参考资料：本分支保持完全的配置兼容性。

## 使用方法
如果最新的文件已经在远程服务器上，你可以从一个空的本地文件夹开始，下载项目，然后从那里开始同步。

1. 在 `VS Code` 中，打开你想与远程服务器同步的本地目录（或创建一个空目录，先把服务器上某个文件夹的内容下载下来，以便在本地编辑）。
2. 在 Windows/Linux 上按 `Ctrl+Shift+P`，在 Mac 上按 `Cmd+Shift+P` 打开命令面板，并执行 `SFTP: config` 命令。
3. `.vscode` 目录中会出现一个名为 `sftp.json` 的基础配置文件；打开它，并用你的远程服务器信息编辑各项参数。

例如：
```json
{
    "name": "配置名称",
    "host": "远程服务器主机",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "用户名",
    "remotePath": "/public_html/project", // <--- 这是使用 "Download Project" 时将下载的路径
    "password": "密码",
    "uploadOnSave": false
}
```
`sftp.json` 中的 `password` 参数是可选的；如果省略，同步时会提示你输入密码。
_注意：_ 反斜杠和其他特殊字符必须用反斜杠转义。

4. 保存并关闭 `sftp.json` 文件。
5. 在 Windows/Linux 上按 `Ctrl+Shift+P`，在 Mac 上按 `Cmd+Shift+P` 打开命令面板。
6. 输入 `sftp`，即可看到其余可用命令。其中许多命令也出现在项目文件资源管理器的右键菜单中。
7. 如果你想与远程文件夹同步，一个很好的起点是 `SFTP: Download Project`：它会把 `sftp.json` 中 `remotePath` 指定的目录下载到你打开的本地目录。
8. 完成——现在你可以在本地编辑，每次保存后文件都会被上传，使远程副本与本地保持同步。
9. 尽情享受吧！

详细说明请访问 [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki)。

## 配置示例
完整的配置选项列表见[这里](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration)。

- [简单配置](#简单配置)
- [多配置（Profiles）](#多配置profiles)
- [多上下文](#多上下文)
- [跳板连接（hopping）](#跳板连接hopping)
- [用户设置中的配置](#用户设置中的配置)
- [安全的删除与重命名](#安全的删除与重命名)
- [外部变更与上传验证](#外部变更与上传验证)

### 简单配置
```json
{
  "host": "host",
  "username": "用户名",
  "remotePath": "/remote/workspace"
}
```

### 多配置（Profiles）
```json
{
  "username": "用户名",
  "password": "密码",
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

_注意：_ `context` 和 `watcher` 只能在根级别使用。

使用 `SFTP: Set Profile` 切换配置。

### 多上下文
各个上下文**不能相同**。
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "用户名",
    "password": "密码",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "用户名",
    "password": "密码",
    "remotePath": "/remote/project/src"
  }
]
```

_注意：_ 此模式下 `name` 为必填项。

### 跳板连接（hopping）
你可以使用 ssh 协议通过代理连接到目标服务器。

_注意：_ 变量替换在 `hop` 配置内不起作用。

#### 单跳板
本地 -> 跳板 -> 目标
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // 跳板
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- 密钥文件假定位于本地计算机上。

  "hop": {
    // 目标
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- 密钥文件假定位于跳板机上。
  }
}
```

#### 多跳板
本地 -> 跳板A -> 跳板B -> 目标
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // 跳板A
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- 密钥文件假定位于本地计算机上。

  "hop": [
    // 跳板B
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- 密钥文件假定位于跳板A上。
    },

    // 目标
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- 密钥文件假定位于跳板B上。
    }
  ]
}
```

### 用户设置中的配置
你可以使用 `remote` 让 sftp 从 [remote-fs](https://github.com/liximomo/vscode-remote-fs) 获取配置。

在用户设置中：
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "用户名",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "用户名",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

在 sftp.json 中：
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### 安全的删除与重命名
```json
{
  "host": "host",
  "username": "用户名",
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

_注意：_ 除了 `tempFilePatterns`、`remoteTrash.path`（默认 `.sftp-trash`）和 `remoteTrash.retentionDays`（默认 `7`）之外，上面这些都是扩展已经采用的默认值；只有需要修改时才必须写出来。使用绝对 `path` 可以把回收站放在 Web 服务器提供的站点根目录之外。

### 外部变更与上传验证
```json
{
  "host": "host",
  "username": "用户名",
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

_注意：_ 这里的 `externalChanges`、`verifyUpload` 和 `uploadRetries` 都是默认值；扫描不需要 `watcher` 块（它只用于响应实时变更和 `pollInterval`）。`verifyUpload: "hash"` 增加内容校验，以毫秒为单位的 `pollInterval` 则开启定时轮询。

### 属于服务器的文件夹
```json
{
  "host": "host",
  "username": "user",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "ignore": [".git", "node_modules"],
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

_注：_ `storage/` 和 `public/uploads/` 永远不会被上传，在本地删除它们也永远不会删除服务器上的副本，但它们仍然可以被下载（`Download Folder`、`Sync Remote -> Local`）；`*.env` 永远不会离开你的电脑。`Force Upload` 仍可用于例外情况。

## 远程资源管理器
![远程资源管理器预览](assets/showcase/remote-explorer.png)

远程资源管理器让你浏览服务器上的文件。你可以这样打开它：

1. 执行 `View: Show SFTP` 命令。
2. 点击活动栏中的 SFTP 视图。

在远程资源管理器中你只能查看文件内容。执行 `SFTP: Edit in Local` 命令即可在本地编辑文件。

自 v1.16.5 起，远程的符号链接目录同样可以浏览。

### 多选
你可以在远程服务器上一次选择多个文件/文件夹进行下载或上传。只需在选择所需文件时按住 Ctrl 或 Shift，就像在普通资源管理器中一样。

_注意：_ 如果**删除**文件后资源管理器没有正确刷新，请手动刷新其父文件夹。

### 排序
你可以通过在 `sftp.json` 配置文件中添加 `remoteExplorer.order` 参数来对远程资源管理器进行排序。

在 sftp.json 中：
```json
{
  "remoteExplorer": {
    "order": 1 // <-- 默认值为 0。
  }
}
```

## 调试
1. 打开用户设置。
  - Windows/Linux：`File > Preferences > Settings`
  - macOS：`Code > Preferences > Settings`
2. 启用 `sftp.debug`（设为 `true`）并重新加载 VS Code。
3. 在 `View > Output > sftp` 中查看日志。

## FAQ
你可以在[这里](./FAQ.md)查看所有常见问题（英文）。

## 致谢与支持原作者
本分支建立在 [@liximomo](https://github.com/liximomo)（原作者）和 [@Natizyskunk](https://github.com/Natizyskunk)（本分支所派生分支的维护者）的工作之上。如果这个扩展这些年来帮助过你，请考虑支持他们：

- 请 Natizyskunk 喝杯咖啡：https://www.buymeacoffee.com/Natizyskunk
- PayPal：https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### 社区

- **讨论**：加入 [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions) 参与交流
- **贡献**：查看[标记为 "good first issue" 的 issue](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue)

---

## 📜 许可证

基于 **MIT** 许可证分发。更多信息见 [LICENSE](LICENSE)。

> MIT 许可证允许你不受限制地使用、复制、修改、合并、发布、分发、再许可和/或出售本软件的副本，前提是保留版权声明。

---

## 👨‍💻 作者

**Jose Alexis Correa Valencia**
*全栈开发者与软件架构师*

拥有超过 25 年的企业级软件开发经验，专注于可扩展架构和现代 PHP 解决方案。

- **GitHub**：[@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn**：[Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **邮箱**：jalexiscv@gmail.com
- **所在地**：哥伦比亚 🇨🇴

---

## ❤️ 捐赠

如果这个扩展帮助了你或你的企业，请考虑支持它的持续开发和维护。

| 方式 | 详情 |
|--------|----------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi（哥伦比亚）** | `3117977281` |

### 你的支持带来的好处

你的捐赠有助于：
- ⚡ 加速新功能的开发
- 📚 编写更多文档和示例
- 🧪 提高测试覆盖率
- 🐛 处理更多 issue 积压中的修复
- 🌍 保持项目活跃和持续更新

*感谢你的支持！* 🙏
