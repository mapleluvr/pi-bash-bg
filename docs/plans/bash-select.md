# `/bash-select` 变更计划

状态：已实现；代码、单元测试和真实后端集成测试已完成，最终验收结果见文末。

来源：`D:\Pi\research\pi-setup\bash-select-proposal.md`

## 实施结果

- 已实现固定 `auto` 顺序、显式 `shell: false` executor、版本化状态、`/bash-select` 和即时工具元数据刷新。
- `cmd.exe` 未进入后端模型、发现、补全、状态或执行路径；自定义路径和真实 probe 也拒绝 cmd 副本/重命名文件。
- 后台任务保留原有阈值、日志、kill/join 语义，并通过真实 PowerShell 7、Git Bash、Windows PowerShell 5.1 执行测试。
- `npm test` 当前 55 项测试全部通过；当前机器真实执行了 PowerShell 7、Git Bash、Windows PowerShell 5.1，并验证了 PowerShell/Git Bash 语法、`shell: false`、状态持久化、warning、流式更新和 Windows 进程树终止。


为 `pi-bash-bg` 的 `bash` 工具增加可持久化的执行后端选择，并保留现有前台等待、自动转后台和 `bg_*` 工具语义。

硬约束：

- `auto` 的解析顺序固定为 **PowerShell 7 > Git Bash > PowerShell 5.1**。
- **任何路径都不得使用 `cmd.exe`**：不加入后端枚举，不加入发现结果，不加入补全或 UI 选项，不作为回退，也拒绝把自定义路径指向 `cmd.exe`。
- `bash` 工具名保持不变，避免破坏默认工具集合、已有系统提示词和 `bg_*` 说明。
- 默认无状态文件时使用 `auto`，但 `auto` 只在上述三个后端中选择；三个后端都不可用时明确失败。
- 不改 `read`、`write`、`edit`、`ls`、`grep`、`find`；不新增原生 `powershell` 工具；不启用 `user_bash` 统一。
- 不修改 `settings.json` 的 `shellPath`。扩展状态与核心 bash 的设置保持两个明确、互不覆盖的来源。

提案中“将 `cmd.exe` 作为显式候选项”的部分由本硬约束覆盖，实施时删除而不是保留为手动逃生路径。

## 2. 当前实现基线

- `index.ts` 注册 `bash`、`bg_run`、`bg_status`、`bg_logs`、`bg_kill`、`bg_join`，并注册 `/bash-select`；`bash` 元数据和执行器由当前后端状态驱动。
- `src/registry.ts` 通过显式 `BackendExecutor` 启动任务，保留日志、状态和进程树终止语义，不再使用 `spawn(..., { shell: true })`。
- `src/exec.ts` 负责启动任务、等待阈值、处理中断、流式更新和转后台。
- `tests/` 覆盖后端发现/状态、执行器、后台任务、扩展命令和当前机器真实后端执行。
- `package.json` 当前只有 `npm test`，没有额外构建或类型检查脚本。
- 变更计划文件位于 `docs/plans/bash-select.md`。

## 3. 文件变更计划

### 3.1 新增 `src/backends.ts`

集中定义后端模型、发现、版本探测和解析逻辑：

```ts
type BackendId = "auto" | "gitbash" | "pwsh7" | "powershell51" | "custom";

type BackendKind = "bash" | "powershell";

interface BackendCandidate {
  id: Exclude<BackendId, "auto" | "custom"> | "custom";
  kind: BackendKind;
  label: string;
  path: string;
  args: string[];
  commandTransport: "argv" | "stdin";
  version?: string;
}
```

实现要求：

- 使用显式 `spawnSync`/`spawn` 探测和执行，不依赖 SDK 根入口的运行时 value import；当前 SDK 的可选依赖可能使根入口加载失败，因此插件内部保留参数、PATH 和 probe 适配逻辑。所有探测均为显式进程调用，不使用 `shell: true`。
- Git Bash 发现顺序覆盖 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、`%ProgramFiles%\Git\usr\bin\bash.exe` 和 PATH 中的 `bash.exe`，去重后保留可执行文件。
- PowerShell 7 只接受 `pwsh.exe` 且版本主版本号至少为 7；Windows PowerShell 5.1 只接受 `powershell.exe` 且版本探测主版本号为 5；探测失败的候选会被跳过。
- 探测版本使用 `spawnSync`、`windowsHide: true`、5 秒上限；版本探测失败不能让整个发现流程崩溃。
- `auto` 必须按 `pwsh7`、`gitbash`、`powershell51` 的固定顺序解析，不受发现列表顺序影响。
- 不定义 `cmd` 类型，不读取或依赖 `ComSpec`。任何候选路径 basename 为 `cmd.exe`，或规范化后等于 Windows `System32\cmd.exe`，都判为非法。
- 自定义绝对路径必须存在、可执行，并能被探测为 Bash 或 PowerShell；未知程序和 `cmd.exe` 都拒绝。自定义路径保留为 `custom`，同时保存探测出的 `kind`、参数和版本，保证工具提示与实际语法一致。
- 三个自动后端都不存在时返回包含候选路径和安装/配置建议的诊断，不隐式调用 cmd。
- 为测试提供可注入的 `discoverBackends`/版本探测实现，避免测试必须依赖固定机器安装路径。

### 3.2 新增 `src/state.ts`

负责扩展自有状态文件和选择校验：

- 默认路径为 `join(getAgentDir(), "pi-bash-bg.json")`，即当前 Pi agent 目录下的 `pi-bash-bg.json`。
- 版本化状态格式：

```json
{
  "version": 1,
  "backend": "auto | gitbash | pwsh7 | powershell51 | custom",
  "shellPath": "C:\\absolute\\path\\to\\shell.exe",
  "updatedAt": "2026-07-10T12:00:00.000Z"
}
```

- `shellPath` 只对 `custom` 必填；其他 backend 若存在旧字段可忽略或清理。
- 读取时严格校验 JSON、版本、backend、绝对路径和 `cmd.exe` 禁止规则。文件不存在等同于 `auto`。
- 路径不存在、类型不匹配或文件损坏时回退 `auto`，保留可显示的 warning；不能静默地切到其他后端或 cmd。
- 写入采用同目录临时文件加 rename 的原子流程；更新时间使用 ISO 字符串。
- 暴露可注入的 `statePath`，供测试使用临时目录，不触碰真实用户状态文件。

### 3.3 新增后端执行适配层（优先 `src/operations.ts`）

将每个已解析后端转换为插件内部的显式 `BackendExecutor`。不直接调用 `createLocalPowerShellOperations()`，因为它没有 `shellPath` 参数，会在选中 PowerShell 5.1 时重新走 SDK 默认发现并可能误选 PowerShell 7。

实现要求：

- `shell: false`，第一个参数永远是已解析的绝对 executable path。
- Bash 使用 `getBashConfig(selectedPath)` 得到 `-c` 或旧 WSL Bash 的 `-s` 传输方式；argv 模式使用 `ignore/pipe/pipe`，stdin 模式使用 `pipe/pipe/pipe` 并显式结束 stdin。
- PowerShell 使用 `POWERSHELL_ARGS` 加命令参数，并保留核心实现的 UTF-8 输出编码初始化；选定 `pwsh.exe` 或 `powershell.exe` 的路径必须原样执行。
- 使用 `createExecutionEnv()` 生成带 Pi bin 目录前置的 PATH，并在调用前按当前 `ExtensionContext` 删除旧的 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL` 后重新填充。
- 保留外层显式 `PYTHONUNBUFFERED=1` 的现有行为。
- 监听 stdout/stderr 并交给任务日志流；处理 spawn error、close、非零退出码和空输出。
- `AbortSignal` 触发时使用内部 `killProcessTree`（Windows 下调用绝对 `SystemRoot\System32\taskkill.exe` 杀进程树，其他平台杀进程组），并将结果映射为 `killed`/`exitCode: null`。不得重新引入 `shell: true` 或仅杀外壳不杀子树的逻辑。
- 每个任务捕获启动时的后端和环境；之后 `/bash-select` 切换不改变已运行任务，只影响新任务。

### 3.4 修改 `src/registry.ts`

- 将任务状态、日志和 abort 控制交给 `TaskRegistry` 与 `BackendExecutor`；保留日志文件、唯一前缀解析、状态快照、`waitFor`、3 秒 kill 等现有语义。
- `StartOptions` 增加已解析后端执行器和环境参数，避免 registry 在没有会话上下文时自行猜测 shell。
- `start()` 不再传入整条命令给 `spawn(..., shell: true)`，而是调用显式 executor。
- 保持 `done` 只结算一次；abort、spawn error、非零退出、正常关闭分别映射到现有 `killed`、`failed`、`done` 状态。
- 可选地在快照或日志头中记录 backend id/path，便于诊断；不改变现有 `bg_status` 对外字段含义，除非测试证明增加字段不会破坏客户端。

### 3.5 修改 `src/exec.ts`

- 保留 5000ms 默认阈值、显式 `background`、超时返回 taskId、前台非零退出抛错、AbortSignal 语义。
- `runBash` 接收解析后的 backend executor 和会话环境，并传给 registry；不向 executor 传 registry 5 秒阈值作为 shell 自身 timeout，避免双重超时。
- 继续将前台 abort 映射为 `Command aborted`，并确保后台任务已被杀死后才返回错误。

### 3.6 修改 `index.ts`

增加后端控制器并集中注册 bash 工具：

- 扩展初始化时读取状态、发现后端并解析当前选择；每次执行前重新读取状态并解析一次，以容忍用户手改状态文件。
- 用 `registerBashTool(resolvedBackend)` 封装 bash 工具注册。原有 `bashSchema`、阈值和 `bg_*` 参数保持不变。
- `bash` 的 `description`、`promptSnippet`、`promptGuidelines` 必须反映实际后端：
  - Bash：说明通过 Git Bash/Bash 语法执行。
  - PowerShell：明确写明 PowerShell 版本、`pwsh.exe`/`powershell.exe` 路径和 PowerShell 语法，避免模型继续生成 Bash 内建命令。
  - `auto` 在注册时按当前解析结果展示实际后端；不可用时展示不可用诊断但执行仍返回可读错误。
- `bg_run` 与 `bash` 使用同一解析和环境构造路径，不能出现两个工具选择不同解释器的情况。
- 注册 `bash-select` 命令：
  - 无参数时展示 `auto`、当前已发现的 Git Bash、PowerShell 7、PowerShell 5.1 和合法 custom 状态；显示绝对路径、版本和当前标记。
  - 参数严格支持 `auto`、`gitbash`、`pwsh7`、`powershell51`、合法绝对路径；未知参数、不可用后端和 cmd 路径均通过 `ctx.ui.notify(..., "error")` 拒绝且不改状态。
  - 选择成功后原子写状态、通知当前后端，并立即再次 `registerBashTool` 覆盖同名工具，使当前会话无需 `/reload` 即采用新元数据和新后端。
  - `getArgumentCompletions` 只返回上述 backend id 和合法路径提示，不返回 `cmd`/`cmd.exe`。
  - 取消选择不写文件、不刷新工具。
- 状态损坏或路径失效产生的 warning 在有 UI 的命令/会话上下文中通知；同时让工具执行返回包含回退原因的可读错误，避免初始化阶段因没有 `ctx` 而吞掉信息。
- 保持 `session_shutdown` 对 registry 的释放行为；切换后不得遗留旧注册表中的长任务。

## 4. 测试计划

### 4.1 后端单元测试：新增 `tests/backends.test.ts`

- 自动顺序表驱动测试：同时存在时必须选择 `pwsh7`；无 PS7 时选择 Git Bash；仅有 PS5.1 时选择 `powershell51`。
- 所有候选不可用时断言明确错误包含探测路径，且结果不是 cmd。
- 版本解析、候选路径去重、旧 WSL Bash stdin 参数和 PowerShell 参数测试。
- 断言发现结果、补全结果、持久化结果中不存在 `cmd` 或 `cmd.exe`。
- 自定义路径：合法 Bash/PowerShell 路径可解析；不存在、未知可执行文件和 `cmd.exe` 均拒绝。
- 状态文件不存在、损坏、旧版本、失效路径和原子写入使用临时目录验证；测试不能改写真实 `getAgentDir()` 文件。

### 4.2 执行与 registry 回归：扩展 `tests/bg.test.ts`

- 保留现有快速命令、阈值转后台、输出流式写入、abort 杀任务、状态查询和前缀匹配测试。
- 测试显式 executor 传输：Bash argv、旧 WSL stdin、PowerShell `-Command` 参数均不经过 shell 包装。
- 验证非零退出码仍由 `runBash`/调用方报告 `Command exited with code N`。
- 验证 `bg_kill` 后任务为 `killed`，并在 Windows 能通过实际进程树检查确认子进程消失。
- 至少保留一个使用真实发现后端的集成测试；后端不存在时按候选可用性跳过，并把跳过原因写入测试输出。控制流单元测试可使用注入 executor，但不能把 mock 结果当作生产后端能力证据。

### 4.3 扩展命令和工具测试：扩展 `tests/extension.test.ts`

- fake Pi 需要记录 `registerCommand`，提供可控的 `ctx.ui.select`/`notify`，并允许断言同名 `bash` 被重新注册。
- 验证初始注册仍包含现有六个工具，并新增 `bash-select` 命令，不新增 `powershell` 工具。
- 选择 `pwsh7`、`gitbash`、`powershell51` 后断言状态写入、notify、bash 元数据和工具替换；断言同一 fake session 无需 reload 即生效。
- 验证 `auto`、绝对路径、未知参数、不可用后端、cmd 路径和取消操作的结果。
- 验证 `bg_run` 与 `bash` 使用同一后端解析和 `PI_*` 环境构造。
- 测试状态路径使用依赖注入临时目录，不污染 `D:\Pi\runtime\agent\pi-bash-bg.json`。

## 5. 文档计划

修改 `README.md`，记录：

- 默认 `auto` 顺序为 PowerShell 7、Git Bash、PowerShell 5.1。
- `/bash-select` 的交互和非交互用法。
- 状态文件路径、格式、损坏/失效时的回退行为。
- 当前后端决定命令语法；PowerShell 下不要使用 Bash 内建命令。
- `cmd.exe` 永远不是可用后端，也不会作为回退。
- 现有 `bash` 阈值、`bg_*` 工具和日志路径行为不变。

## 6. 验收顺序

1. `npm test` 全部通过。
2. 在真实 Pi 会话中删除状态文件并重启，确认 `auto` 选择当前机器上按优先级第一个可用后端：本机若 PS7 可用，首轮工具应执行 PowerShell 命令；若 PS7 不可用而 Git Bash 可用，则执行 Bash 命令；依此类推。不能把“默认输出 BASH_VERSION”作为固定断言，因为本计划明确将 PS7 排在 Git Bash 之前。
3. 真实会话执行后端专属探测：
   - PowerShell 7：`$PSVersionTable.PSVersion.ToString()`。
   - Git Bash：`printf '%s\n' "$BASH_VERSION"` 和 `echo "$0"`。
   - PowerShell 5.1：`$PSVersionTable.PSVersion.ToString()`，确认主版本 5。
4. 执行 `/bash-select gitbash`、`/bash-select pwsh7`、`/bash-select powershell51`（仅在候选存在时），每次都在同一会话立即调用 `bash`，确认命令语法和版本发生对应变化，无需 `/reload`。
5. 重启 Pi 后读取 `D:\Pi\runtime\agent\pi-bash-bg.json`，确认选择持久化；手改为失效路径后确认 warning、回退 `auto` 且绝不启动 cmd。
6. 用真实长命令验证 `bg_run`、`bg_logs`、`bg_status`、`bg_join`、`bg_kill`、5 秒自动转后台和进程树清理。
7. 在工具命令中检查 `PI_SESSION_ID`、`PI_MODEL`（有模型时）以及 PATH 前置 Pi bin 目录，确认与核心执行语义一致。
8. 对最终启动进程链做证据检查：后端 executable 必须是 `pwsh.exe`、`bash.exe` 或 `powershell.exe`，不得出现 `cmd.exe` 包装层。

## 7. 实施顺序与完成门槛

1. 实现并测试 `backends.ts`/`state.ts`，冻结后端选择契约和禁止 cmd 的边界。**完成。**
2. 实现显式执行适配层，先让 registry 单元测试通过，再接入 `exec.ts`。**完成。**
3. 修改 `index.ts`，接入环境变量、工具元数据和 `/bash-select`，补扩展测试。**完成。**
4. 更新 README，运行完整测试和真实会话验收。**完成；55/55 测试通过，无阻断 LSP 诊断。**
5. 只有在自动优先级、无 cmd、实际执行路径、持久化、即时刷新和后台回归全部有证据时才标记完成；任何只证明“注册成功”但未证明实际 executable 的测试都不作为最终通过依据。**已满足；真实后端和进程树证据已纳入测试。**
