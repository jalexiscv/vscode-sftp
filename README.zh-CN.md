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

每项修复在发布前都经过验证（webpack 构建干净、42/42 测试通过、代码检查无错误）。每个变更的详细信息见 [documents/Changelogs](documents/Changelogs/CHANGELOG.md)。

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
code --install-extension sftp-1.19.0.vsix
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
