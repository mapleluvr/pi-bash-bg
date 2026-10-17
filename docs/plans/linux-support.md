# Linux / POSIX 适配

状态：已实现；单元测试与真实系统 Bash 集成测试通过（`npm test`）。

## 目标

让 `pi-bash-bg` 在 Linux / macOS 上可用，同时不引入 Windows 那套后端选择负担：

- POSIX 上**不注册 `/bash-select`**，也不读取/写入后端状态文件。
- `bash` 工具固定通过系统 Bash 执行，仍保留前台阈值、自动转后台和全部 `bg_*` 工具。
- Windows 行为保持不变：`/bash-select`、`auto` 顺序（PowerShell 7 > Git Bash > PowerShell 5.1）、`cmd.exe` 禁止规则。

## 后端模型

`src/backends.ts` 增加平台判断：

```ts
export function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

export type BackendId = "auto" | "bash" | "gitbash" | "pwsh7" | "powershell51" | "custom";
```

- `bash`：POSIX 系统 Bash 的候选 id；Windows 永远不会发现该 id。
- `autoBackendOrder()` 按平台返回顺序：Windows 为 `pwsh7 > gitbash > powershell51`，POSIX 为 `bash`。
- `AUTO_BACKEND_ORDER` 仍导出，值为当前平台顺序（保持旧调用方可用）。

## 发现

POSIX 走 `discoverPosixBash()`：

1. 直接扫描 `PATH`（不再调用 `which`，精简容器里通常没有它，也省一次进程）。
2. 追加固定路径：`/bin/bash`、`/usr/bin/bash`、`/usr/local/bin/bash`、`/opt/homebrew/bin/bash`、`/run/current-system/sw/bin/bash`。
3. 用 `bash --version` 探测，首行需匹配 `GNU bash` / `bash`；探测失败即跳过。
4. 去重键用 `realpathSync`，让 `/bin/bash` 与 `/usr/bin/bash` 这类符号链接合并为一个候选。
5. 参数固定 `-c`（argv 传输），不使用旧 WSL 的 `-s` + stdin 分支。

Windows 发现逻辑与之前一致，仅把 `gitBashCandidate` 重命名为 `bashCandidate` 以复用标签逻辑（`gitbash` 仍显示 "Git Bash"）。

## 解析

- `resolveBackend("auto", candidates)`：
  - POSIX：优先 `id === "bash"` 的可用候选，否则接受任意 `kind === "bash"` 的可用候选（便于测试注入与自定义包装）。全部不可用时抛出 `No shell backend available. Tried: Bash (/bin/bash, /usr/bin/bash, PATH).`
  - Windows：保持原有固定顺序与错误文案（含 `cmd.exe is not a fallback`）。
- 显式选择（`bash`/`gitbash`/…）仍按 id 匹配；POSIX 上这些分支不可达，因为命令未注册。

## 扩展装配

`index.ts`：

- `effectiveState()`：POSIX 上忽略 `stateStore.read()` 的结果，一律使用 `{ backend: "auto" }`，因此 Windows 时期遗留的 `pi-bash-bg.json`（例如 `pwsh7`）不会污染 Linux 运行；状态 warning 也不再冒泡到工具输出。
- `pi.registerCommand("bash-select", …)` 仅在 `isWindowsPlatform()` 时注册；POSIX 上补全、交互选择和参数解析代码都不可达。
- `ensureBackend()` 的兜底错误文案按平台区分。
- 其余注册（`bash`、`bg_run`、`bg_status`、`bg_logs`、`bg_kill`、`bg_join`）与执行路径完全共用。

## 执行与清理

`src/operations.ts` 原本已按平台分支，本次未改语义，仅确认：

- POSIX 子进程以 `detached: true` 启动，成为进程组组长；`killProcessTree()` 用 `process.kill(-pid, "SIGKILL")` 杀整组，失败再退回单进程 `SIGKILL`。
- Windows 仍使用绝对路径的 `System32\taskkill.exe /T /F`。
- `createExecutionEnv()` 在 POSIX 上把 `~/.pi/agent/bin` 前置到 `PATH`，并注入 `PI_*` 会话变量。

## 测试

- `tests/backends.test.ts`：Windows 专属顺序/发现用例用 `{ skip: posixOnly }`；新增 POSIX 发现、`auto` 解析、注入候选、失败文案、探测失败跳过等用例。
- `tests/extension-select.test.ts`：新增「POSIX 不注册 `/bash-select`」「POSIX 忽略 Windows 状态文件」「POSIX 忽略状态 warning」；Windows 选择用例改为 skip。
- `tests/integration.test.ts`：新增真实系统 Bash 执行用例（`$BASH_VERSION`、`$0` 必须是发现到的绝对路径）；Windows 后端用例保持 skip 语义。
- `tests/backends.test.ts` 的「未知可执行文件被拒绝」在 POSIX 上先 `chmod 0o755`，否则会先被「不可执行」分支拦下，测不到分类逻辑。

## 未做的部分

- 不提供 POSIX 的 Shell 选择（没有 `/bash-select`，也没有状态文件）。若将来需要 zsh/fish 支持，应作为新的后端 id 加入 `discoverPosixBash()` 与 `autoBackendOrder()`，而不是恢复命令。
- 不改变 Windows 的 `auto` 顺序、`cmd.exe` 禁止规则和状态文件格式。
