# E2B 原生 Code CLI 架构设计

## 目标

这份文档定义新的云端会话执行模型。目标不是继续修补当前 `sandbox-agent`
桥接，而是在 E2B 沙箱中直接运行原生 `Claude Code`、原生 `Codex CLI`，同时保留
现有 Web 产品的项目视角、消息视角和权限边界。

必须满足以下要求：

1. 一个 E2B sandbox 对应一个云项目，而不是一个聊天会话。
2. 同一云项目下可以有多轮 AI 会话，共享同一工作区。
3. 会话执行使用原生 CLI，而不是第三方 agent runtime。
4. 认证文件和 API key 两种模式都能工作。
5. 前端断开、主后端重启、WebSocket 中断，都不能中断沙箱内 CLI 的运行。
6. 后续接入其他 code CLI 时，不允许再复制一套 E2B 会话桥。

这份设计与以下文档互补：

- `docs/RUNTIME_CAPABILITY_ABSTRACTION.md` 负责项目级 files/git/shell 能力抽象
- `docs/TERMINALD_ARCHITECTURE.md` 负责 durable terminal / tmux / ttyd 基础设施
- `docs/REFACTOR_SESSION_ARCHITECTURE.md` 负责前端会话状态与消息路由收敛

本设计聚焦于“云端原生 CLI 会话”。

## 一、关键结论

### 1.1 当前 E2B 事件流不适合原生 CLI

当前实现的优势在于前端消费层已经统一到了 `NormalizedMessage`，但 E2B 内部运行层绑死了
`sandbox-agent` 的 ACP 事件模型。这个模型不适合原生 CLI，原因如下：

1. `Claude Code` 和 `Codex CLI` 的原始输出、权限提示、会话恢复方式并不相同。
2. 原生 CLI 的状态并不是天然的结构化 JSON 事件流。
3. 当前 `session.onEvent()` / `session.onPermissionRequest()` 的能力来自 `sandbox-agent`，不是
   E2B 原生能力，也不是 CLI 自身能力。
4. 继续在 ACP 事件之上打补丁，只会把运行时耦合锁得更死。

因此，新架构必须保留外层统一消息模型，但替换内部运行层。

### 1.2 不应该改成 SSH 主导架构

浏览器产品层不应该改成以 SSH 为主的数据平面。

原因：

1. SSH 对“浏览器直连 + 移动端 + 重连 + 多会话订阅 + 结构化事件”并不友好。
2. SSH 擅长“人工登录终端”，不擅长“产品化消息流 + UI 状态恢复 + per-session replay”。
3. 认证、跳板、端口和浏览器兼容性会显著增加复杂度。
4. 我们已经需要 WebSocket/SSE 来服务聊天 UI，改成 SSH 不能消掉这层，反而会多一层。

结论：

- 浏览器到主后端：继续以 `WebSocket` 为主，`SSE` 为只读 fallback
- 主后端到沙箱：使用 E2B SDK + 沙箱内 durable PTY/session supervisor
- SSH：仅保留为调试或管理员逃生通道，不作为产品主链路

### 1.3 真正的关键不是 transport，而是 ownership

要做到“前端和后端服务挂了，也不中断 E2B 的 CLI 运行”，关键不是换协议，而是改变进程归属：

1. CLI 进程不能隶属于浏览器连接。
2. CLI 进程不能隶属于主后端 Node 进程内存。
3. CLI 进程必须隶属于沙箱内一个独立的 durable supervisor。
4. 主后端只是控制面和订阅者，不是 CLI 生命周期 owner。

## 二、总体架构

### 2.1 分层模型

新的会话模型分为五层：

1. `Frontend Chat UI`
2. `Backend Session Control Plane`
3. `Provider Runtime Adapter`
4. `Sandbox Session Supervisor`
5. `Native CLI Process`

```text
Browser UI
  |  WebSocket / SSE
  v
Main Backend
  |  control RPC + event tailing
  v
E2B Sandbox
  |- session-supervisor
  |   |- PTY A -> claude
  |   |- PTY B -> codex
  |   |- event store / status / control inbox
  |
  `- workspace repo
```

### 2.2 组件职责

#### Frontend Chat UI

负责：

- 展示 `NormalizedMessage`
- 会话列表、会话切换、重连、继续接收流
- slash command 自动完成和 provider 提示
- last-seen cursor 上报

不负责：

- 维护 CLI 进程生命周期
- 直接解析 provider 原始协议

#### Backend Session Control Plane

负责：

- 校验用户、项目、provider、model、auth profile
- 创建或连接 E2B sandbox
- 调用沙箱内 session supervisor 开始 / 继续 / 中断会话
- 消费 supervisor 事件并转换为 `NormalizedMessage`
- 维护客户端订阅、ACK、重放、断线恢复

不负责：

- 持有唯一活跃 PTY
- 把 CLI 子进程挂在自己进程树上

#### Provider Runtime Adapter

每个 provider 一个适配器，例如：

- `claude-native`
- `codex-native`
- 未来的 `cursor-native`

职责：

- 声明安装检查与版本检查
- 生成启动命令
- 解析原始输出为内部 `RuntimeEvent`
- 管理 provider-specific slash command registry
- 生成 provider-specific auth material
- 读取 provider-specific 历史/转录文件

#### Sandbox Session Supervisor

这是新架构的核心。它必须独立于主后端运行，长期驻留在沙箱中。

职责：

- 管理 durable PTY session
- 持久化 session metadata / status / events / transcript cursors
- 接收控制命令，例如 `start`、`send-input`、`interrupt`、`resume-stream`
- 将 CLI 输出写入 append-only event log
- 在无人订阅时继续让 CLI 运行

#### Native CLI Process

原生 `claude` 或原生 `codex` 进程本身。

它只做一件事：作为 provider 官方运行时执行，不再被包一层第三方 agent runtime。

## 三、会话与进程模型

### 3.1 项目与会话的关系

新的模型里：

- 一个 `sandboxId` 就是一个云项目
- 一个云项目下可以有多个 AI 会话
- 每个 AI 会话对应一个 durable PTY + 一个 provider runtime
- 所有会话共享同一工作区目录

推荐标识：

```ts
type CloudProjectHandle = {
  sandboxId: string;
  workspaceRoot: string;
  repoUrl?: string | null;
  branch?: string | null;
};

type CloudCliSessionHandle = {
  sessionId: string;
  sandboxId: string;
  provider: 'claude' | 'codex' | 'cursor' | 'gemini';
  runtime: 'native-cli';
  model?: string | null;
  status: 'starting' | 'running' | 'waiting_input' | 'waiting_approval' | 'exited' | 'failed';
};
```

### 3.2 Durable PTY，而不是一次性进程

要保留原生 CLI 体验，必须使用 durable PTY，会话不能退化成一次性 `exec("prompt")`。

原因：

1. slash command 是交互式语义，不只是命令行 flag。
2. 权限确认、继续输入、多轮上下文，需要保留同一终端上下文。
3. 原生 CLI 常常会把状态写入 TTY 上下文和本地转录文件。
4. 将来接入“原生终端 attach”时，也需要 PTY 复用。

因此，session supervisor 需要为每个会话分配一个 durable PTY。

### 3.3 不使用主后端内存保存活跃会话

主后端只缓存“连接关系”和“最后消费到的游标”，不缓存唯一的会话状态。

会话真实状态保存在沙箱中，例如：

```text
/home/user/.cloudcli/
  projects/<sandboxId>/
    sessions/<sessionId>/
      meta.json
      status.json
      events.ndjson
      stdout.log
      stderr.log
      control.ndjson
      auth.json
      runtime.json
```

解释：

- `meta.json`: provider/model/workspaceRoot/createdAt
- `status.json`: 当前 phase、pid、pty id、lastHeartbeat、exitCode
- `events.ndjson`: append-only 结构化事件源，重连重放的真相来源
- `stdout.log` / `stderr.log`: 原始日志，用于调试与补偿解析
- `control.ndjson`: 用户输入、审批回复、中断等控制命令
- `runtime.json`: adapter 版本、CLI version、parser version

## 四、事件流设计

### 4.1 内部先统一为 RuntimeEvent，不直接出 UI 消息

新的架构不应该再让 provider adapter 直接发前端消息，而是先收敛成内部 `RuntimeEvent`。

```ts
type RuntimeEvent =
  | { kind: 'session_started'; sessionId: string; provider: string; createdAt: string }
  | { kind: 'assistant_delta'; sessionId: string; content: string; sequence: number }
  | { kind: 'assistant_message'; sessionId: string; content: string; sequence: number }
  | { kind: 'tool_call'; sessionId: string; toolName: string; input: unknown; sequence: number }
  | { kind: 'tool_result'; sessionId: string; toolId?: string; content: string; isError?: boolean; sequence: number }
  | { kind: 'permission_request'; sessionId: string; requestId: string; payload: unknown; sequence: number }
  | { kind: 'status'; sessionId: string; phase: string; text?: string; sequence: number }
  | { kind: 'warning'; sessionId: string; content: string; sequence: number }
  | { kind: 'error'; sessionId: string; content: string; sequence: number }
  | { kind: 'exit'; sessionId: string; exitCode: number | null; sequence: number };
```

然后统一做：

`RuntimeEvent -> NormalizedMessage`

这样前端继续消费现有消息模型，运行时差异被隔离在 adapter 层。

### 4.2 事件必须可重放

实时流不是唯一来源。每条可见事件必须写入 `events.ndjson`，格式至少包含：

```ts
type PersistedRuntimeEnvelope = {
  sequence: number;
  sessionId: string;
  provider: string;
  createdAt: string;
  event: RuntimeEvent;
};
```

关键要求：

1. `sequence` 在单 session 内单调递增。
2. 任何已推送给前端的可见事件，都必须先成功落盘。
3. 重连时按 `sequence > lastSeenSequence` 回放。
4. 后端数据库可以缓存，但缓存不是唯一真相来源。

### 4.3 前端与后端的 ACK 机制

浏览器 WebSocket 重连后，必须带上每个 session 的最后游标：

```ts
type SessionCursorMap = Record<string, number>;
```

推荐协议：

1. 后端推送消息时带 `sequence`
2. 前端定期上报 `ack { sessionId, sequence }`
3. WebSocket 重连握手时一次性带上所有活跃 session 的 `lastSeenSequence`
4. 后端从沙箱 event store 补发缺失消息

这样浏览器刷新、移动网络切换、标签页休眠后恢复时，都能继续流。

### 4.4 后端重启恢复

后端恢复流程应当是：

1. 从 DB 找到用户最近活跃的 E2B sandbox / session 元数据
2. 重新连接 E2B sandbox
3. 向 sandbox session supervisor 请求 `status` 和 `tail events from sequence`
4. 给前端补回缺失的消息

核心原则：

- 后端重启只能影响订阅，不影响 CLI 执行
- 如果 provider 正在等待输入或等待审批，进程就继续阻塞在沙箱里，直到新的前端或后端重新接管

## 五、斜杠命令设计

### 5.1 不要做“统一 slash command 语义”

`Claude Code` 和 `Codex CLI` 都有 slash commands，但它们不构成统一 ABI。

不能做的事：

1. 试图把所有 provider 的 slash command 翻译成一套共享命令
2. 在前端写死“所有 provider 都支持 `/model` `/memory` `/mcp`”
3. 用本地假命令模拟云端真实命令

应该做的事：

1. 前端维护 provider-scoped command palette
2. 后端维护 provider-scoped slash command registry
3. 用户输入以 `/` 开头时，优先按 provider 原生命令透传
4. 只有少数产品级动作才允许映射为 provider-specific 命令

### 5.2 命令注册模型

建议新增：

```ts
type SlashCommandDescriptor = {
  id: string;
  command: string;
  provider: 'claude' | 'codex' | 'cursor' | 'gemini';
  summary: string;
  category: 'session' | 'config' | 'context' | 'auth' | 'tooling' | 'workflow';
  requiresIdle?: boolean;
  experimental?: boolean;
};
```

前端只做：

- 自动完成
- 简短说明
- 当前 provider 支持性判断

不做：

- 命令翻译器
- provider 间语义兼容层

### 5.3 Claude 与 Codex 的 slash command 差异

根据官方文档，`Claude Code` 和 `Codex CLI` 都支持 slash commands，但侧重点不同。

#### Claude Code

官方文档当前明确列出的内建命令包括：

- `/add-dir`
- `/agents`
- `/bug`
- `/clear`
- `/compact`
- `/config`
- `/doctor`
- `/help`
- `/hooks`
- `/ide`
- `/init`
- `/install-github-app`
- `/login`
- `/logout`
- `/mcp`
- `/memory`
- `/model`
- `/permissions`
- `/pr_comments`
- `/review`
- `/status`
- `/terminal-setup`
- `/vim`

设计结论：

1. Claude 的 slash surface 更偏“本地工作流”和“开发环境管理”。
2. Claude 特别适合暴露 memory、permissions、hooks、review、agents 相关入口。
3. Claude 前端可以提供更丰富的 command discoverability，但仍然只能 provider-scoped。

#### Codex CLI

官方文档当前明确列出的内建命令包括：

- `/add-dir`
- `/agents`
- `/approvals`
- `/diff`
- `/help`
- `/init`
- `/login`
- `/logout`
- `/mcp`
- `/memory`
- `/mode`
- `/model`
- `/new`
- `/prompts`
- `/review`

设计结论：

1. Codex 的 slash surface 更偏“模式控制、审批、diff、prompts、session 管理”。
2. Codex 的 `/mode`、`/approvals` 和 `/diff` 价值较高，前端要单独建 registry 元数据。
3. 不能假设 Claude 的 `/permissions` 和 Codex 的 `/approvals` 可直接互映。

### 5.4 产品级统一动作与 slash command 的关系

允许保留少量产品级按钮，但它们必须映射到 provider-specific 行为：

- “切换模型” -> Claude 用 `/model`，Codex 也用 `/model` 或等价控制面 API
- “查看 MCP” -> Claude 用 `/mcp`，Codex 也用 `/mcp`
- “初始化项目说明文件” -> Claude 用 `/init`，Codex 也用 `/init`

但像下面这些不应假装统一：

- Claude `/compact`
- Claude `/permissions`
- Claude `/terminal-setup`
- Codex `/approvals`
- Codex `/diff`
- Codex `/prompts`
- Codex `/new`

这些应明确显示为 provider-specific 功能。

## 六、Claude 与 Codex 特性抽象

### 6.1 不要只抽象成 provider 名称，要抽象成能力集

建议新增 provider capability model：

```ts
type CloudCliProviderCapabilities = {
  slashCommands: boolean;
  modelSwitch: boolean;
  memoryControl: boolean;
  mcp: boolean;
  approvalControl: boolean;
  reviewMode: boolean;
  diffInspection: boolean;
  agentManagement: boolean;
  imageInput?: boolean;
  resumeTranscript?: boolean;
  rawTerminalAttach?: boolean;
};
```

这样前端不需要写：

```ts
if (provider === 'claude') ...
if (provider === 'codex') ...
```

而是按 capability 渲染按钮和命令面板。

### 6.2 Claude 侧重点

从官方能力面看，Claude 更适合暴露这些一等能力：

- memory / CLAUDE.md
- permissions / hooks
- MCP
- agents
- review / PR comments
- IDE integration / terminal setup

产品设计上，Claude 云端会话应优先追求“接近本地 Claude Code 的工作流一致性”。

### 6.3 Codex 侧重点

从官方能力面看，Codex 更适合暴露这些一等能力：

- mode / model
- approvals
- diff
- prompts
- MCP
- agents
- memory / AGENTS.md / skills / hooks

产品设计上，Codex 云端会话应优先追求“模式控制、审批控制、可重放 transcript”的一致性。

### 6.4 未来 provider 的接入标准

新增其他 code CLI 时，必须实现以下接口：

```ts
type NativeCliProviderAdapter = {
  id: string;
  detectInstalled(sandbox): Promise<boolean>;
  detectCapabilities(sandbox): Promise<CloudCliProviderCapabilities>;
  getSlashCommands(): Promise<SlashCommandDescriptor[]>;
  buildAuthBundle(selection, context): Promise<AuthBundle>;
  buildLaunchSpec(opts): Promise<LaunchSpec>;
  parseOutput(chunk, state): RuntimeEvent[];
  readHistory(sessionHandle): Promise<RuntimeEvent[]>;
};
```

没有实现这个接口的 provider，不允许直接插进 E2B bridge。

## 七、认证模型

### 7.1 统一 AuthBundle，而不是 E2B 特判

现有 `auth-sync.js` 已经证明“文件 + env 双通道”是正确方向，但它现在仍然偏 E2B 特例。

新架构应该提升为通用认证模型：

```ts
type AuthBundle = {
  provider: string;
  mode: 'auto' | 'profile' | 'custom' | 'api_key' | 'disabled';
  files: Array<{ targetPath: string; content: string }>;
  envs: Record<string, string>;
  warnings: string[];
};
```

### 7.2 认证优先级

推荐优先级：

1. `profile` 明确选择的认证文件/配置
2. `custom` 自定义路径导入的文件
3. host 本机自动检测到的原生认证文件
4. API key env 注入

原则：

- 能保留原生 CLI 文件布局时，优先文件
- 文件模式不可行或不稳定时，再退回 API key 模式
- provider adapter 负责解释自己的认证，不允许公共层硬编码 provider 私有字段

### 7.3 Claude 认证要求

Claude 必须兼容：

- `~/.claude/.credentials.json`
- `~/.claude/settings.json`
- `ANTHROPIC_API_KEY`
- 设置文件内的 `env`

新架构里，Claude 云端会话的第一优先级是“原生文件生效”，而不是强迫用户改成 API key。

### 7.4 Codex 认证要求

Codex 必须兼容：

- `~/.codex/auth.json`
- `~/.codex/config.toml`
- `OPENAI_API_KEY`
- 兼容当前项目已有的 `CODEX_API_KEY` / `CLIPROXY_API_KEY` 注入逻辑

但从架构上看，应把兼容变量视作过渡，不应继续把第三方兼容变量扩散到核心会话协议里。

## 八、前端传输与恢复策略

### 8.1 前端到后端：WebSocket 主链路，SSE 只读兜底

建议：

- 聊天消息流：`WebSocket`
- 只读回放、弱网 fallback：`SSE`
- 文件/git API：常规 HTTP

原因：

1. WebSocket 更适合双向控制消息，例如 `ack`、`interrupt`、`approval reply`
2. SSE 适合作为无状态回放和诊断 fallback
3. 浏览器和移动端对这两类协议支持最好

### 8.2 不要让前端直接连沙箱

前端不应直接持有 E2B sandbox URL 作为主链路。

原因：

1. 用户鉴权、项目权限、auth profile 选择都在主后端
2. 直连会让鉴权和审计散掉
3. 多个前端实例订阅同一 session 时，后端更适合做 fan-out 和 replay

结论：前端统一连主后端，主后端再连 E2B。

### 8.3 更好的重连机制

前端需要从“全局 message feed 被动扫描”升级为“按 session 订阅 + 游标恢复”。

至少实现：

1. 每条消息带 `sessionId + sequence`
2. 前端每个 session 都记录 `lastSeenSequence`
3. 重连时携带 `cursorMap`
4. 后端按 session 补发缺失消息
5. UI 层不因为切换会话而把别的 session 判成 idle

这与 `docs/REFACTOR_SESSION_ARCHITECTURE.md` 中的 per-session lifecycle 设计一致。

## 九、为什么前后端挂了也不该中断沙箱内 CLI

### 9.1 前端挂掉

前端关闭、刷新、切网络时：

- WebSocket 断开
- 主后端取消该浏览器订阅
- sandbox supervisor 继续保留 PTY 和 CLI 子进程
- CLI 继续执行并将输出写入 `events.ndjson`

结论：只丢失订阅，不丢失执行。

### 9.2 主后端挂掉

主后端崩溃或重启时：

- 所有浏览器连接断开
- sandbox supervisor 仍在沙箱里继续运行
- CLI 进程继续执行
- 重启后的后端重新 attach 并回放未消费事件

结论：只丢失实时转发，不丢失执行。

### 9.3 E2B sandbox 暂停或被销毁

真正会中断执行的是：

- sandbox 被 pause
- sandbox 被 kill
- CLI 自己 exit

因此产品层必须把“订阅中断”和“运行中断”分开显示：

- `disconnected_from_backend`
- `sandbox_paused`
- `session_exited`
- `session_failed`

不能把所有断线都显示成“会话结束”。

## 十、与 terminald 的关系

### 10.1 不要造第二套 durable PTY 基础设施

如果 `terminald` 按 `docs/TERMINALD_ARCHITECTURE.md` 落地，云端原生 CLI 会话应尽量复用它的 durable PTY 思路，而不是另起一套竞争系统。

推荐关系：

1. `terminald` 负责 durable PTY / tmux / transport
2. `cloud-cli-runner` 负责 provider runtime + 事件解析 + transcript 管理
3. 同一 session 未来可以选择：
   - 结构化 chat 视图
   - 原生终端 attach 视图

这会给“原生 Claude Code 体验”提供更强的兜底能力：如果结构化解析不完整，至少用户还能 raw attach 到同一会话终端。

### 10.2 MVP 阶段的取舍

MVP 不要求先把完整 terminal UI 做完，但底层 durable PTY 模型要与 `terminald` 兼容。

换句话说：

- MVP 可以先没有“打开原生终端”按钮
- 但会话 owner 仍然应该是 sandbox 内 durable PTY supervisor，而不是主后端内存

## 十一、最小可用实施方案

### Phase 0: 接口和文档

新增以下模块边界：

- `server/providers/cloud/runtime-types.js`
- `server/providers/cloud/auth-bundle.js`
- `server/providers/cloud/cloud-cli-runner.js`
- `server/providers/cloud/providers/claude-native.js`
- `server/providers/cloud/providers/codex-native.js`
- `server/providers/cloud/slash-command-registry.js`

### Phase 1: Claude Native in E2B

目标：只先打通 Claude。

必须完成：

1. E2B template 安装原生 `claude`
2. sandbox 内 durable supervisor 能创建 Claude PTY session
3. `AuthBundle` 支持 Claude 文件 + API key
4. 后端可以通过 event replay 恢复流
5. 前端支持 per-session cursor ACK

可以延后：

- 原生终端 attach UI
- 完整 hooks/permissions 可视化
- 多 provider 同时上线

### Phase 2: Codex Native in E2B

在 Claude 跑通后接 Codex。

必须新增：

1. Codex auth.json + config.toml 注入与重写
2. Codex slash registry
3. Codex approval / mode / diff 事件解析

### Phase 3: Raw Terminal Attach

目标：让结构化 chat 与原生终端共存。

用户可以：

- 在 chat 里继续会话
- 在 terminal 里 attach 到同一个 durable PTY
- 出现解析异常时回退到 raw terminal，不丢上下文

## 十二、明确不做的事

这一版不做：

1. 不做 Claude 和 Codex slash command 的统一翻译层
2. 不做浏览器直连 SSH 作为主架构
3. 不把 CLI 执行挂在主后端进程树上
4. 不再把第三方 agent runtime 当作原生 CLI 兼容层

## 十三、审查清单

所有后续实现都应至少回答这些问题：

1. CLI 进程 owner 是不是沙箱内 durable supervisor，而不是主后端？
2. 事件是不是先落盘再转发？
3. 浏览器重连是不是能按 `sequence` 补流？
4. 后端重启后是不是能继续 attach 到旧 session？
5. slash command 是否仍然保持 provider-scoped？
6. 认证文件和 API key 是否都被同一 `AuthBundle` 模型覆盖？
7. 新增 provider 时，是否只需要实现 adapter，而不是改全局 E2B 会话桥？

## 附录：官方资料

以下页面用于校对本设计中的 slash command 与 provider 能力边界；实现时应继续以官方文档为准，而不是把本文件当成命令 ABI。

- Claude Code commands: https://code.claude.com/docs/en/commands
- Claude Code overview: https://code.claude.com/docs/en/overview
- Codex CLI slash commands: https://developers.openai.com/codex/cli/slash-commands
- Codex CLI features: https://developers.openai.com/codex/cli/features
