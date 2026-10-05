![pi-bash-bg](assets/pi-bash-bg-title.png)

<div align="center">

*长命令转后台，工具循环不再被前台等待占住。*

<img src="https://img.shields.io/badge/version-0.1.0-EB0404?labelColor=181818" alt="Version: 0.1.0">
<img src="https://img.shields.io/badge/platform-Windows-181818" alt="platform: Windows">
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
> 当前发布版本面向 **Windows** 使用，并已在 Windows 上验证。非 Windows 平台暂未纳入支持范围。

`bash` 跑太久不再卡死 tool loop：前台等约 5s（`timeout` 参数可调），超时即切后台并返回 `background task created` + `taskId`。

## 核心思路

前台等待预算与进程生命周期分开：超过等待阈值只切换为后台任务，不把命令当作失败，也不重新执行。

| 想知道什么 | 应检查什么 |
| --- | --- |
| 命令是否进入后台？ | `background task created` 回执与 `taskId` |
| 任务是否结束？ | `bg_status` 或有界等待 `bg_join` 的状态 |
| 实际做了什么？ | `bg_logs` 日志及命令自身的输出；创建任务不等于执行成功 |

## 当前功能

- 覆盖内置 `bash`：短命令同步返回，长命令自动转后台。
- 显式创建、查询、读日志、等待或终止后台任务。
- 用 `/bash-select` 切换当前会话的 Shell，并持久保存选择。
- 前台取消时清理任务树；保留 Pi 的 PATH 与会话环境变量。

## 快速开始

### 1. 准备与加载

需要 Windows、Pi 和至少一种受支持的 Shell。下面在本仓库根目录执行：

```powershell
npm ci
pi install -l .
```

`-l` 把包声明写入当前项目的 `.pi/settings.json`；加载前需要信任该项目。本地包的依赖由调用者安装。重新打开 Pi 后选择后端：

```text
/bash-select auto
```

### 2. 运行并观察

让 Agent 使用 `bash` 工具运行下面的命令（适用于支持的 PowerShell / Git Bash 后端）：

```text
node -e 'setTimeout(() => console.log(1), 7000)'
```

默认约 5 秒后应返回 `taskId`。随后让 Agent 使用 `bg_join`，显式给出等待预算，再用 `bg_logs` 读取输出。这里的 `bg_*` 是 Pi 工具，不是 Shell 可执行文件。

## Shell 后端

`bash` 工具支持以下执行后端，默认 `auto` 优先级为：

1. PowerShell 7
2. Git Bash
3. Windows PowerShell 5.1

`cmd.exe` 不是可用后端，也不会作为回退。没有任何支持的后端时，工具会返回明确的安装/路径错误。

后端由扩展直接启动，使用 `shell: false`。因此 `bash` 工具中的命令必须按当前后端语法书写；切换到 PowerShell 后使用 PowerShell 语法，切换到 Git Bash 后使用 Bash 语法。

### 选择后端

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

- `bash {command, timeout?, background?}`（覆盖内置）：`background: true` 直接建任务；否则前台等到 `timeout ?? 5s`，超时转后台返回 `background task created`，短命令保持原样同步返回。非零退出码（前台）仍抛错，与内置一致。
- `bg_run {command, name?}`：显式建后台任务，立即返回 `taskId`。

组织（查询/收尾）：`bg_status {taskId?}`、`bg_logs {taskId, maxBytes?}`、`bg_kill {taskId}`、`bg_join {taskId, timeoutSeconds}`。`bg_join` 的等待上限是强制的：`timeoutSeconds` 必填，服务端钳制在 1~3600 秒；等待超时返回 `still running`，不会杀任务。

命名注意：`bg_wait` 已被 pi-subagents 占用（等待 subagent runs），shell 任务的等待工具叫 `bg_join`，两者注册表不互通。

中断：ESC/signal 中止前台等待时杀掉任务树、不泄漏，并抛出 `Command aborted`。

输出落盘：`$TMPDIR/pi-bash-bg/<id>.log`，`bg_logs` 默认返回最后 20KB。子进程环境默认带 `PYTHONUNBUFFERED=1`（外层显式设置优先）。同时保留核心 shell 语义：PATH 前置 Pi bin 目录，并在有会话上下文时注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。

## 配置

- `PI_BASH_BG_THRESHOLD_MS`：默认前台等待毫秒数（默认 5000）。
- `PI_CODING_AGENT_DIR`：Pi agent 状态目录；扩展状态文件位于该目录下的 `pi-bash-bg.json`。

## 项目结构

```text
pi-bash-bg/
├── index.ts          # 工具与 /bash-select 注册
├── src/
│   ├── backends.ts   # 后端发现与选择
│   ├── exec.ts       # 前台等待 / 后台转换
│   ├── operations.ts
│   ├── registry.ts   # 任务与日志
│   └── state.ts      # 后端状态存储
├── tests/
├── docs/plans/bash-select.md
└── assets/           # README 标题图
```

## 支持范围

| 场景 | 当前边界 |
| --- | --- |
| Windows + PowerShell 7 / Git Bash / Windows PowerShell 5.1 | 当前支持范围 |
| `cmd.exe` | 不支持，不作为回退 |
| 非 Windows 平台 | 暂未纳入支持范围 |
| 等待超时 | 不杀任务，也不表示任务成功 |
| 命令语法 | 必须匹配所选后端，工具名 `bash` 不意味着固定使用 Bash |

## 设计文档

后端选择方案见 [bash-select 设计](docs/plans/bash-select.md)。

## 参与开发

<a id="测试"></a>

在安装依赖后运行：

```powershell
npm test
```

测试包含后端解析/状态单元测试、后台任务回归测试、扩展命令测试，以及当前机器已安装后端的真实执行测试。

## 许可证

`package.json` 声明为 MIT；当前 checkout 未附独立 `LICENSE` 文件。

---

<div align="center">

**等待有界，任务可查，结果以实际输出为准。**

</div>
