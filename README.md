# pi-bash-bg

> 当前发布版本面向 **Windows** 使用，并已在 Windows 上验证。非 Windows 平台暂未纳入支持范围。

`bash` 跑太久不再卡死 tool loop：前台等约 5s（`timeout` 参数可调），超时即切后台并返回 `background task created` + `taskId`。

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

## 测试

```powershell
npm test
```

测试包含后端解析/状态单元测试、后台任务回归测试、扩展命令测试，以及当前机器已安装后端的真实执行测试。
