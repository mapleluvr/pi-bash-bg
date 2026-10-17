![pi-bash-bg](assets/pi-bash-bg-title.png)

<div align="center">

*长命令转后台，工具循环不再被前台等待占住。*

<img src="https://img.shields.io/badge/version-0.2.0-EB0404?labelColor=181818" alt="Version: 0.2.0">
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-181818" alt="platform: Windows | Linux">
<img src="https://img.shields.io/badge/license-MIT-FDFDFD?labelColor=181818" alt="License: MIT">

<br>
<br>

<a href="#快速开始">快速开始</a> ｜
<a href="#核心思路">核心思路</a> ｜
<a href="#工具语义">工具</a> ｜
<a href="#shell-后端">Shell 后端</a> ｜
<a href="#项目结构">项目结构</a> ｜
<a href="#支持范围">支持范围</a>

</div>

---

> [!IMPORTANT]
> 两个平台共用同一套后台语义，后端模型不同：Windows 默认 `auto` 自动解析 PowerShell / Git Bash，需要时用 `/bash-select` 覆盖；Linux 固定使用系统 Bash，不注册 `/bash-select`。

内置 `bash` 没有默认超时，长命令会一直占住当前工具调用；传 `timeout` 也只是在超时后杀掉命令。本扩展把等待预算和进程生命周期分开：前台等约 5s（`timeout` 可调），超时即转后台并返回 `background task created` + `taskId`，命令继续运行。

## 核心思路

| 情况 | 内置 `bash` | 本扩展 |
| --- | --- | --- |
| 不传 `timeout` 的长命令 | 等到命令结束 | 约 5s 后转后台，返回 `taskId` |
| 传了 `timeout` 且超时 | 杀掉命令并报错，命令不会继续 | 不杀，转后台，后续用 `bg_logs` 取回 |

超过等待阈值只切换为后台任务，不把命令当作失败，也不重新执行。

| 想知道什么 | 应检查什么 |
| --- | --- |
| 命令是否进入后台？ | `background task created` 回执与 `taskId` |
| 任务是否结束？ | `bg_status` 或有界等待 `bg_join` 的状态 |
| 实际做了什么？ | `bg_logs` 日志及命令自身的输出；创建任务不等于执行成功 |

## 当前功能

- 覆盖内置 `bash`：短命令同步返回，长命令自动转后台。
- 显式创建、查询、读日志、等待或终止后台任务。
- 前台取消时清理任务树；保留 Pi 的 PATH 与会话环境变量。
- Windows：`auto` 按固定顺序解析后端，可用 `/bash-select` 覆盖并持久保存。
- Linux：固定使用系统 Bash，无需也没有 `/bash-select`。

## 快速开始

### 1. 准备与加载

需要 Pi 和 Bash（Linux），或 PowerShell 7 / Git Bash / Windows PowerShell 5.1 之一（Windows）。下面在本仓库根目录执行：

```bash
npm ci
pi install -l .     # 只对当前项目生效
# 或：pi install ./   # 用户级，写入 ~/.pi/agent/settings.json
```

`-l` 把包声明写入当前项目的 `.pi/settings.json`，加载前需要信任该项目。本地包的依赖由调用者安装。

Linux 无需选择步骤，重新打开 Pi 后 `bash` 工具即通过系统 Bash 执行。Windows 的 `auto` 通常也已够用。

### 2. 运行并观察

让 Agent 使用 `bash` 工具运行下面的命令：

```bash
node -e 'setTimeout(() => console.log(1), 7000)'
```

默认约 5 秒后应返回 `taskId`。随后让 Agent 使用 `bg_join`，显式给出等待预算，再用 `bg_logs` 读取输出。这里的 `bg_*` 是 Pi 工具，不是 Shell 可执行文件。

## Shell 后端

后端由扩展直接启动，使用 `shell: false`。因此 `bash` 工具中的命令必须按当前后端的语法书写。

### Linux

- 只有一种后端：系统 Bash。发现顺序为 `PATH` 中的 `bash`，其次是 `/bin/bash`、`/usr/bin/bash`、`/usr/local/bin/bash`、`/opt/homebrew/bin/bash`、`/run/current-system/sw/bin/bash`。
- 用 `bash --version` 探测；探测失败或不是 Bash 的候选会被跳过。
- 不接受相对路径；`cmd.exe` 相关规则不适用。
- 后端选择、状态文件与 `/bash-select` 在 Linux 上都不参与：即使存在 Windows 时期写下的 `pi-bash-bg.json`，也会被忽略并使用 `auto`。
- 前台取消与 `bg_kill` 通过杀掉子进程所属进程组（`detached` + 进程组信号）清理整棵任务树。

### Windows

`bash` 工具支持以下执行后端，默认 `auto` 优先级为：

1. PowerShell 7
2. Git Bash
3. Windows PowerShell 5.1

`cmd.exe` 不是可用后端，也不会作为回退。没有任何支持的后端时，工具会返回明确的安装/路径错误。

### 选择后端（仅 Windows）

`auto` 默认即可用；需要固定到某个后端时再选择。

交互选择：

```text
/bash-select
```

非交互选择：

```text
/bash-select auto
/bash-select pwsh7
/bash-select gitbash
/bash-select powershell51
/bash-select C:\\absolute\\path\\to\\bash.exe
```

选择立即覆盖当前会话中的 `bash` 工具元数据和执行后端，不需要 `/reload`。选择会写入扩展状态文件：

```text
<PI_CODING_AGENT_DIR>\pi-bash-bg.json
```

如果未设置 `PI_CODING_AGENT_DIR`，默认位置是用户目录下的 `.pi\agent\pi-bash-bg.json`。状态文件采用版本化 JSON 和临时文件加 rename 的原子写入；文件损坏、后端失效或路径指向 `cmd.exe` 时会发出 warning 并回退到 `auto`。

自定义路径必须指向 Bash 或 PowerShell executable。`cmd.exe`、不存在的路径和无法分类的程序都会被拒绝。

## 工具语义

入口（创建后台任务）：

- `bash {command, timeout?, background?}`（覆盖内置）：`background: true` 直接建任务；否则前台等到 `timeout ?? 5s`（秒），超时转后台返回 `background task created`，短命令保持原样同步返回。非零退出码（前台）仍抛错，与内置一致。
- `bg_run {command, name?}`：显式建后台任务，立即返回 `taskId`，不受前台阈值影响。

组织（查询/收尾）：`bg_status {taskId?}`、`bg_logs {taskId, maxBytes?}`、`bg_kill {taskId}`、`bg_join {taskId, timeoutSeconds}`。`bg_join` 的等待上限是强制的：`timeoutSeconds` 必填，服务端钳制在 1~3600 秒；等待超时返回 `still running`，不会杀任务。

中断：

- 中止 `bash` 的前台等待（ESC/signal）会杀掉任务树、不泄漏，并抛出 `Command aborted`。
- 中止 `bg_join` 只停止等待，任务继续运行，之后仍可用 `bg_status` / `bg_kill`。

输出落盘：系统临时目录下的 `pi-bash-bg/<id>.log`（Linux 通常 `/tmp/pi-bash-bg`，Windows 为 `%TEMP%\pi-bash-bg`），`bg_logs` 默认返回最后 20KB（按 UTF-8 字节截断，不切断字符）。子进程环境默认带 `PYTHONUNBUFFERED=1`（外层显式设置优先）。同时保留核心 shell 语义：PATH 前置 Pi bin 目录，并在有会话上下文时注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。

### 会话边界

后台任务属于当前 Pi 会话，不是常驻服务：

- `session_shutdown` 时运行中的任务会被终止。
- 任务表在内存中，重启后 `bg_status` 不再认识旧的 `taskId`；日志文件仍留在临时目录。

## 配置

- `PI_BASH_BG_THRESHOLD_MS`：`bash` 的前台等待毫秒数（默认 5000），不影响 `bg_run`。
- `PI_CODING_AGENT_DIR`：Pi agent 状态目录；Windows 的扩展状态文件位于该目录下的 `pi-bash-bg.json`（Linux 不读取）。

## 项目结构

```text
pi-bash-bg/
├── index.ts          # 工具与 /bash-select 注册（命令仅 Windows）
├── src/
│   ├── backends.ts   # 平台感知的后端发现与选择
│   ├── exec.ts       # 前台等待 / 后台转换
│   ├── operations.ts
│   ├── registry.ts   # 任务与日志
│   └── state.ts      # 后端状态存储
├── tests/
├── docs/plans/bash-select.md
├── docs/plans/linux-support.md
└── assets/           # README 标题图
```

## 支持范围

| 场景 | 当前边界 |
| --- | --- |
| Linux + 系统 Bash | 支持；固定 `auto`，无 `/bash-select` |
| Windows + PowerShell 7 / Git Bash / Windows PowerShell 5.1 | 支持；`auto` 默认可用，`/bash-select` 可覆盖 |
| `cmd.exe` | 不支持，不作为回退 |
| 会话结束 | 运行中任务被终止，任务表不跨会话 |
| 等待超时 | 不杀任务，也不表示任务成功 |
| 命令语法 | 必须匹配当前后端，工具名 `bash` 不意味着固定使用 Bash |

## 设计文档

- 后端选择方案见 [bash-select 设计](docs/plans/bash-select.md)。
- Linux 适配方案见 [linux-support 设计](docs/plans/linux-support.md)。

## 参与开发

<a id="测试"></a>

在安装依赖后运行：

```bash
npm test
```

测试包含后端解析/状态单元测试、后台任务回归测试、扩展命令测试，以及当前机器已安装后端的真实执行测试。Windows 专属用例在 Linux 上标记为 skip，Linux 专属用例在 Windows 上标记为 skip。

## 许可证

`package.json` 声明为 MIT；当前 checkout 未附独立 `LICENSE` 文件。

---

<div align="center">

**等待有界，任务可查，结果以实际输出为准。**

</div>
