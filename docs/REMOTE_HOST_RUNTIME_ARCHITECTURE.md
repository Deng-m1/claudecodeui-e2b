# 远程主机 Runtime 架构设计

## 目标

这份文档定义当前服务如何在继续支持 `E2B` 的同时，引入第三类执行目标：`remote_host`。

这里的 `remote_host` 指：

1. 项目工作区位于远程主机。
2. Claude / Codex / Gemini / Cursor 等 CLI 在远程主机上原生运行。
3. 默认依赖远程主机自身的 CLI 配置、认证文件和环境变量。
4. 不再沿用 E2B 的“把平台侧认证镜像进执行环境”作为默认前提。

这份设计与以下文档互补：

- `docs/RUNTIME_CAPABILITY_ABSTRACTION.md`
- `docs/TERMINALD_ARCHITECTURE.md`
- `docs/E2B_NATIVE_CLI_ARCHITECTURE.md`
- `docs/REFACTOR_SESSION_ARCHITECTURE.md`

本文聚焦于一个问题：

`当前系统不仅支持 E2B，还要支持远程主机；远程主机上的 Codex/Claude 配置属于远程主机自己，不属于当前 Web 服务宿主机，这种模式应该怎么设计。`

## 关键结论

### 1. `remote_host` 必须是一等 runtime，而不是 E2B 分支变体

现有代码已经在向 runtime adapter 演进，但实际实现仍然只有 `local` 和 `e2b` 两类运行时。

远程主机不能继续套在：

- `local` 之下，用宿主机路径和宿主机 CLI 假装远程；
- `e2b` 之下，把远程主机当成另一种“可注入 auth bundle 的云沙箱”；
- 或者前端再增加一套 `remoteSessions`、`remoteShell` 的并行逻辑。

正确做法是把它建模成第三类执行目标：

```ts
type ProjectRuntime = 'local' | 'e2b' | 'remote_host';
```

### 2. 远程主机与 E2B 的核心差异不是 transport，而是 ownership

E2B 的默认语义是：

- 平台创建执行环境；
- 平台决定要把哪些认证文件 / env 注入进去；
- 沙箱生命周期由平台控制；
- 平台天然知道工作区和 provider 配置来源。

远程主机的默认语义必须是：

- 执行环境先于平台存在；
- CLI 认证默认属于远程主机执行用户自己；
- 平台只负责发现、编排、订阅、代理和审计；
- 平台不能默认假设自己持有可复制到目标机的认证材料。

### 3. 运行时建模必须从“单轴 runtime”升级为“双轴模型”

只用 `runtime = local | e2b | remote_host` 还不够，因为远程主机和 E2B 在“认证归属”上是正交差异。

因此必须至少拆成两条轴：

```ts
type ExecutionTarget = 'local' | 'e2b' | 'remote_host';

type AuthOwnership =
  | 'platform_mirrored' // 平台把 bundle 写入执行环境，E2B 默认
  | 'target_native'     // 目标机本地配置生效，remote_host 默认
  | 'pushed_profile'    // 平台显式推送指定 profile 到目标机，远程高级选项
  | 'disabled';
```

后续所有设计都应围绕这两个维度展开。

### 4. 当前平台宿主机挂掉，不能影响远程主机上的 CLI 继续运行

这是 `remote_host` 模式的硬约束，不是优化项。

这里的“当前平台宿主机挂掉”包括：

- 主后端 Node 进程崩溃；
- `terminald` 进程退出；
- 平台宿主机重启；
- 平台宿主机临时不可达。

在这些情况下，远程主机上已经启动的：

- Claude / Codex / Gemini / Cursor CLI 进程
- tmux session
- terminal supervisor
- session supervisor

都必须继续运行。

影响只应该体现在：

- 浏览器暂时无法继续订阅或 attach；
- 平台恢复后需要重新建立控制连接；
- 之后按 cursor / terminal handle 重新接回。

不能发生的事情是：

- 平台宿主机一挂，远程主机上的 CLI 一起退出；
- 远程会话因为主后端内存丢失而不可恢复；
- 远程 terminal 因为 websocket owner 消失而被 kill。

## 背景与当前问题

### 1. 现有 `project-runtime` 与 `terminald` 只识别 `local | e2b`

当前代码中：

- `server/services/project-runtime/context.js`
- `server/services/project-runtime/index.js`
- `terminald/runtime/context.js`
- `terminald/runtime/index.js`

都只分 `local` 和 `e2b`。

这意味着：

1. 文件系统能力只能来自宿主机或 E2B sandbox。
2. Git 只能在宿主机进程或 E2B process 上执行。
3. Terminal attach 只能是宿主机 PTY 或 E2B process terminal。
4. 新增远程主机会天然诱导出更多 `if (runtime === 'e2b') ... else ...` 分支。

### 2. 当前 E2B auth 语义是“镜像宿主机认证到云端”

现有 `Auth Center`、`SessionLauncher` 和 `auth-sync.js` 的设计已经证明：

- “文件 + env 双通道”是正确方向；
- 但它仍然偏向 E2B；
- 默认行为是从平台宿主机或保存的 profile 中组装 `AuthBundle`，然后同步到 sandbox。

这在 E2B 是合理的，在 remote host 上默认不合理。

因为 remote host 的真实使用场景通常是：

- 用户在远程机器上已经 `claude login`；
- 或已经有 `~/.claude/.credentials.json`；
- 或已经有 `~/.codex/auth.json` / `~/.codex/config.toml`；
- 或环境变量已经由远程主机自己注入。

平台不应默认越俎代庖。

### 3. 项目发现与会话发现仍然依赖平台宿主机本地目录

当前项目和会话发现逻辑仍然直接读取：

- `~/.claude/projects`
- `~/.codex/sessions`

这只对 `local` 有意义。

一旦接入远程主机：

1. 这些路径必须在远程主机上解析，而不是在平台宿主机上解析。
2. “project name” 不能再隐含等于本机目录名。
3. provider session index 也必须由目标端返回，而不是主后端代读本地磁盘。

### 4. 前端不能再复制一套 runtime 专属 session 容器

`e2bSessions` 已经证明“按 runtime 开第二套 session 列表”会显著增加状态复杂度。

远程主机如果继续照搬：

- `sessions`
- `codexSessions`
- `e2bSessions`
- `remoteSessions`

那么前端会话路由、去重、deep-link、消息回放、transport 选择会再次膨胀。

远程主机必须复用已经在设计中的统一会话模型：

- session 自身带 `projectName + runtime + provider + targetId`
- 前端按标准化后的 session 选择和订阅
- 不新增 runtime 专属前端状态面

## 设计原则

1. `remote_host` 是一等 runtime，不能作为 `e2b` 的子模式。
2. 默认尊重远程主机原生认证，不主动复制平台密钥。
3. 浏览器不能直连远程主机，仍然只连主后端和 `terminald`。
4. CLI 进程生命周期不能属于浏览器，也不能属于主后端内存。
5. 文件、Git、Terminal、Session 都必须走同一套 runtime capability / control-plane 模型。
6. 前端 UI 读取 capability 和 auth policy，不再根据 `runtime === 'e2b'` 推断行为。
7. 远程主机模式必须允许未来支持：
   - 纯 agent 连接
   - SSH bootstrap + agent 常驻
   - 后续的 Docker / Daytona / 其他宿主机型执行目标

## 总体架构

### 1. 分层模型

远程主机沿用与 E2B 相同的五层结构，只是把 sandbox 替换成 remote host。

```text
Browser UI
  |  WebSocket / SSE / HTTP
  v
Main Backend
  |  control RPC + auth policy + subscription fan-out
  v
terminald / runtime adapter layer
  |  remote runtime adapter RPC
  v
Remote Host
  |- remote-agent
  |   |- file/git rpc
  |   |- terminal supervisor
  |   |- session supervisor
  |   |- provider discovery
  |
  `- workspace + native claude/codex/gemini/cursor cli
```

### 2. 组件职责

#### Frontend

负责：

- 项目展示
- 会话展示与切换
- terminal attach
- auth policy 展示
- per-session cursor / replay

不负责：

- 直接探测远程主机认证
- 直接连接远程主机 websocket
- 持有远程机密

#### Main Backend

负责：

- 用户鉴权
- 远程主机与工作区元数据
- project bootstrap
- 会话订阅、回放、ACK、fan-out
- provider 选择
- auth policy 选择
- 对 `terminald` 和 `project-runtime` 提供 target context

不负责：

- 持有唯一 CLI 进程
- 把远程 CLI 子进程挂在自身进程树下

#### terminald

负责：

- 统一 terminal control plane
- 为 `local` / `e2b` / `remote_host` 暴露同一套 terminal handle
- attach / detach / reconnect / close
- 管理 terminal 元数据存储

不负责：

- 直接解释 provider 原始事件
- 直接维护聊天会话状态

#### remote-agent

这是 remote host 模式的核心新增组件。

负责：

- 远程主机注册与心跳
- provider 可用性探测
- 远程工作区存在性和路径校验
- 文件系统 RPC
- Git RPC
- terminal supervisor
- session supervisor
- durable PTY / tmux 归属
- provider 原生认证探测

不负责：

- 主 Web 用户鉴权
- 产品级消息 fan-out
- 前端 session 路由

## 为什么不把 SSH 作为主架构

SSH 可以作为：

- 首次安装 `remote-agent` 的 bootstrap 通道；
- 管理员调试和逃生通道；
- MVP 早期实验期的兼容实现。

但产品主链路不应建立在“浏览器或主后端临时 SSH 进远程机”之上。

原因：

1. durable session ownership 不清晰；
2. 文件 / Git / terminal / chat session 会各自走不同 SSH 命令，控制面割裂；
3. 断线重连、游标回放、会话 fan-out、审计不自然；
4. 浏览器和移动端上产品体验不稳定。

因此推荐策略是：

- `v0`: 可接受 SSH bootstrap 安装 agent；
- `v1`: 产品主链路统一切到 `remote-agent`。

## 远程主机初始化表单

### 1. 必须有初始化表单

远程主机不是像 E2B 那样由平台直接创建出来的执行环境，因此用户第一次接入某台机器时，必须有一个“远程连接初始化表单”。

这个表单负责完成三件事：

1. 让平台知道远程主机是谁。
2. 让平台验证是否能连上目标机器。
3. 让平台知道后续应把哪个目录当成工作区。

### 2. 不建议把表单长期定义成只有 `IP + SSH 密码`

`IP + SSH 密码` 是一个可行的 MVP bootstrap 方案，但不应被定义成长期唯一模式。

原因：

1. 很多生产主机禁用密码登录。
2. 明文密码不适合长期保存。
3. 长期运行时更适合依赖远程主机上的常驻 agent，而不是每次操作都临时 SSH。

因此表单设计应从一开始就支持两类模式：

- `通过 SSH 引导安装`
- `注册已有 Agent`

### 3. 模式一：通过 SSH 引导安装

这是最接近 VS Code Remote SSH 的接入方式。

流程：

1. 用户填写远程主机连接信息。
2. 平台先测试 SSH 连接。
3. 平台在远程机上检查基础依赖。
4. 平台安装并启动 `remote-agent`。
5. 平台切换到 agent 模式完成后续管理。

#### 表单字段

```ts
type RemoteHostBootstrapForm = {
  label: string;           // 用户自定义名称，例如 "prod-api-host"
  host: string;            // IP 或域名
  port: number;            // 默认 22
  username: string;        // SSH 用户
  authMethod: 'password' | 'ssh_key';
  password?: string;       // authMethod=password 时必填
  savePasswordFallback?: boolean; // 是否额外保存密码作为回退，默认 false
  privateKey?: string;     // authMethod=ssh_key 时必填
  passphrase?: string;     // 私钥可选口令
  workspaceRoot: string;   // 远程工作区根目录，例如 /srv/app
};
```

#### MVP 最小字段

如果第一版先做最小实现，可以只支持：

- `Host/IP`
- `Port`
- `SSH Username`
- `SSH Password`
- `Workspace Root`

也就是你提到的 `IP + SSH 密码` 方案。

但文档上必须明确：

- 这是 bootstrap 模式；
- 不是长期运行主链路；
- 后续应切换到远程 agent。

#### 字段校验

- `host` 必填，支持 IP 或域名。
- `port` 默认为 `22`，必须是合法端口。
- `username` 必填。
- `workspaceRoot` 必填，必须是远程机上的绝对路径。
- `password` 与 `privateKey` 按 `authMethod` 二选一。

#### 连接测试阶段

用户点击 `Test Connection` 或 `Connect` 后，后端应执行以下步骤：

1. 测试 SSH 是否可达。
2. 校验目标用户 HOME 是否可访问。
3. 校验 `workspaceRoot` 是否存在，不存在时给出创建选项或报错。
4. 检查远程机上是否已有：
   - `claude`
   - `codex`
   - `git`
   - `tmux`
5. 检查远程机上是否已存在 `remote-agent`。

### 4. 模式二：注册已有 Agent

如果远程机已经手动安装并运行了 `remote-agent`，则不需要再通过 SSH bootstrap。

#### 表单字段

```ts
type RemoteHostExistingAgentForm = {
  label: string;
  host: string;
  agentUrl: string;        // 例如 https://host:47100
  agentToken: string;
  workspaceRoot: string;
};
```

这种模式下：

- 平台不需要 SSH 密码或私钥；
- 平台直接和 agent 做鉴权与能力探测；
- 更适合后续正式运行环境。

### 5. 推荐的前端交互结构

建议初始化弹窗或页面采用两段式：

#### Step 1: Connection Method

用户先选：

- `Bootstrap via SSH`
- `Use Existing Agent`

#### Step 2: Connection Details

根据上一步动态展示字段。

如果是 `Bootstrap via SSH`：

- 显示 SSH 连接字段
- 再显示 `workspaceRoot`

如果是 `Use Existing Agent`：

- 显示 `agentUrl`
- `agentToken`
- `workspaceRoot`

### 6. 平台托管 SSH key 与密码回退策略

`Bootstrap via SSH` 的长期设计不应是“持续依赖用户第一次输入的 SSH 密码”，而应是：

1. 用户第一次提交 SSH 凭据，只用于：
   - 测试连接；
   - 安装 / 启动 `remote-agent`；
   - 在远程主机上安装一把“平台托管 SSH 公钥”。
2. 平台本地生成一对托管 SSH key：
   - 私钥保存在平台数据库；
   - 公钥追加到远程主机 `~/.ssh/authorized_keys`；
   - 后续保存主机的 SSH 浏览、工作区注册、补救访问优先走这把托管 key。
3. 表单里提供一个 `保存密码作为回退` 开关：
   - 默认关闭；
   - 只有用户明确打开时，平台才会额外保存 SSH 密码；
   - 该密码只作为 `agent -> managed key -> saved password` 链路里的最后回退。
4. 平台不应把“宿主机自己的 SSH 私钥”复制到远程主机；
   - 只能把平台新生成的公钥安装到远程机；
   - 私钥始终留在平台侧。

因此保存策略应明确为：

- 默认持久化：`agent_token`、`platform-managed SSH private key/public key`；
- 可选持久化：`saved_ssh_password`；
- 默认不持久化：用户手工输入的 bootstrap 私钥、passphrase，以及未勾选回退开关时的 SSH 密码。

UI 文案也应明确提示：

- 平台托管 SSH key 会被安装并保存；
- 保存密码作为回退是可选项，默认关闭；
- 已保存主机的目录浏览和补救连接使用 `agent -> managed key -> saved password` 回退链路。

### 7. 初始化成功后的系统状态

用户提交并初始化成功后，系统应至少创建两类记录：

1. `remote_hosts`
2. `remote_workspaces`

同时，后端还应保存以下状态摘要：

- 最近一次连接结果
- agent 是否在线
- 远程机 provider 可用性探测结果
- 当前工作区路径
- 默认 auth ownership，通常为 `target_native`

### 8. 初始化表单与 Auth 的关系

初始化表单只负责“连接到远程机并注册工作区”，不应在第一步就要求用户上传 Claude/Codex 密钥。

原因：

1. remote host 默认应使用目标机自己的认证。
2. 平台首先要做的是探测远程机上是否已有可用认证。
3. 只有当用户显式选择 `Push Saved Profile` 时，才需要进入 profile 推送流程。

因此推荐用户路径是：

1. 填远程连接表单。
2. 建立远程主机连接并注册工作区。
3. 平台探测远程机上已有的 Claude / Codex 状态。
4. UI 展示：
   - `Use Remote Host Auth`
   - `Push Saved Profile`
   - `Disabled`

而不是在初始化表单里直接塞入 provider 密钥输入框。

### 9. 远程项目目录选择与 `workspaceRoot` 边界

远程主机新建项目时，不应继承当前平台宿主机的目录限制。

正确语义是：

1. 用户可以在远程主机上选择任意“该远程执行用户有权限访问的绝对路径”作为项目根目录。
2. 不要求该目录位于某个固定的远程父目录下。
3. 不要求该目录映射到平台宿主机上的任何本地目录结构。

也就是说，下列路径都可以成为远程项目的候选根目录：

- `/srv/app`
- `/opt/services/foo`
- `/home/ubuntu/work/repo`
- 挂载目录

但这不等于“项目创建后平台可以无限制操作远程主机所有目录”。

必须区分两件事：

#### 目录选择范围

远程项目创建阶段，用户应可以浏览远程主机上所有可访问的绝对路径，并选择其中任意一个作为 `workspaceRoot`。

#### 项目运行范围

一旦项目注册完成，平台侧的项目能力必须以 `workspaceRoot` 为边界。

也就是：

- 文件树浏览限制在 `workspaceRoot` 下
- 文件读写限制在 `workspaceRoot` 下
- 新建 / 删除 / 重命名限制在 `workspaceRoot` 下
- 上传限制在 `workspaceRoot` 下
- Git 操作限制在 `workspaceRoot` 下
- 项目级 terminal 默认工作目录为 `workspaceRoot`
- 原生 CLI session 默认工作目录为 `workspaceRoot`

因此，“单项目作用域受限”指的是：

- 平台提供的项目 API 受 `workspaceRoot` 限制；
- 同时还受远程执行用户本身的 Unix 权限限制。

最终可操作边界可以表述为：

```text
平台可操作范围 = workspaceRoot 内 + 远程执行用户本身有权限访问的内容
```

### 10. `workspaceRoot` 边界不等于 OS 级沙箱

必须明确：

- 文件 API 和 Git API 可以做 `workspaceRoot` 级硬限制；
- 但 shell 和原生 CLI 如果是以远程主机真实用户身份运行，默认并不等于被强制 jail 在该目录内。

因此产品语义应该是：

1. shell / CLI 默认从 `workspaceRoot` 启动；
2. 平台级文件 / Git / 项目操作不得越过 `workspaceRoot`；
3. 除非后续显式增加 OS 级隔离，否则不承诺把远程用户严格限制在该目录内。

第一版明确不要求：

- chroot
- mount namespace
- 容器隔离
- 独立受限 Unix 用户池

如果未来需要“严格只能访问该目录”的安全模型，那应作为更强隔离模式另行设计，而不是假设普通 remote host 模式天然具备。

## 核心模型

### 1. Target 与 Provider 解耦

远程主机引入后，至少要把三件事分开：

```ts
type ExecutionTarget = 'local' | 'e2b' | 'remote_host';
type Provider = 'claude' | 'codex' | 'cursor' | 'gemini';
type AuthOwnership = 'platform_mirrored' | 'target_native' | 'pushed_profile' | 'disabled';
```

解释：

- `ExecutionTarget` 决定文件、Git、terminal、CLI 运行在哪里。
- `Provider` 决定实际调用哪种原生 code CLI。
- `AuthOwnership` 决定认证材料来自哪里。

### 2. 统一的 ProjectTargetContext

建议替换当前只够 `local|e2b` 的上下文结构：

```ts
type ProjectTargetContext = {
  runtime: 'local' | 'e2b' | 'remote_host';
  targetId: string;
  projectName: string;
  projectRoot: string;
  userId: number | null;
  capabilities: {
    files: boolean;
    git: boolean;
    shell: boolean;
    sessions: boolean;
  };

  e2b?: {
    sandboxId: string;
  };

  remoteHost?: {
    hostId: string;
    workspaceId: string;
    executionUser: string;
    transport: 'agent' | 'ssh-bootstrap-agent';
    status: 'online' | 'offline' | 'degraded';
  };
};
```

当前 `project-runtime`、`terminald`、`shell` hook 都应该围绕这个结构演进。

### 3. 统一的 ProviderAuthBinding

建议把当前偏 E2B 的 `AuthBundle` 再上一层，变成“绑定策略 + 可选 bundle”。

```ts
type ProviderAuthBinding = {
  provider: Provider;
  ownership: AuthOwnership;
  summary: string;
  warnings: string[];

  // 仅当 ownership 不是 target_native 时才可能存在
  bundle?: {
    files: Array<{ targetPath: string; content: string }>;
    envs: Record<string, string | null>;
  };

  // 只暴露摘要，不默认回传秘密本身
  detectedOnTarget?: {
    authenticated: boolean;
    method: 'credentials_file' | 'config_file' | 'api_key' | 'unknown' | null;
    files: string[];
    envKeys: string[];
  };
};
```

默认策略：

- `local`: `target_native`
- `e2b`: `platform_mirrored`
- `remote_host`: `target_native`

## remote-agent 设计

### 1. 进程模型

推荐远程主机上有一个常驻 `remote-agent` 进程，以某个固定执行用户运行：

```text
remote-agent
  |- file service
  |- git service
  |- terminal supervisor
  |- session supervisor
  |- provider discovery
  `- event store
```

要求：

1. agent 运行用户必须与 Claude / Codex 配置实际所在用户一致，或能稳定访问同一 HOME。
2. agent 必须长期驻留，不能依附某次 WebSocket 连接。
3. agent 维护 durable PTY / tmux / supervisor 状态。
4. 即使平台宿主机或主后端暂时不可用，agent 及其托管的 CLI 进程也必须继续运行。

### 2. Provider Discovery

agent 需要提供一组只返回摘要、不返回密钥内容的探测接口：

```ts
type RemoteProviderProbe = {
  provider: Provider;
  installed: boolean;
  command: string;
  version: string | null;
  authenticated: boolean;
  authFiles: string[];
  envKeys: string[];
  warnings: string[];
};
```

探测范围至少包括：

- Claude:
  - `~/.claude/.credentials.json`
  - `~/.claude/settings.json`
  - `ANTHROPIC_API_KEY`
- Codex:
  - `~/.codex/auth.json`
  - `~/.codex/config.toml`
  - `OPENAI_API_KEY`
- Gemini / Cursor:
  - 与现有 `Auth Center` 探测口径保持一致

注意：

- 默认不把远程认证文件内容回传主后端。
- 主后端只知道“有/没有、哪种方式、哪些路径、哪些 env key”。
- `command` 和 `version` 必须来自远程主机实际安装的 CLI，而不是平台宿主机推断值。

### 3. File / Git RPC

remote-agent 必须对外暴露与 `project-runtime` capability 对齐的接口：

- `listFsEntries`
- `readFsFile`
- `writeFsFile`
- `mkdirFs`
- `moveFs`
- `deleteFsEntry`
- `statFs`
- `runProcess({ command: 'git', args: [...] })`

这让远程主机可以和 E2B 一样接入现有 adapter 体系，而不是让每个路由重新理解远程协议。

### 4. Session Supervisor

远程主机上的原生 CLI 会话也必须是 durable supervisor 模式，而不是一次性 `ssh host claude "..."`。

必须明确：

- session 使用的 `claude` / `codex` / `gemini` / `cursor` 可执行文件，来自远程主机自身安装版本；
- `resume` 行为使用远程主机该 provider CLI 自己支持的命令语义；
- 平台宿主机上的 provider 版本、配置文件、resume 命令差异，不得决定远程会话行为。

推荐目录结构：

```text
~/.claude-code-ui/
  hosts/
    sessions/
      <sessionId>/
        meta.json
        status.json
        events.ndjson
        stdout.log
        stderr.log
        control.ndjson
        runtime.json
        transcript-cursor.json
```

要求：

1. CLI 进程生命周期属于远程主机，而不是主后端。
2. 前端断开不终止会话。
3. 主后端重启不终止会话。
4. 多个客户端可按 cursor 重放事件。
5. 平台宿主机掉线或重启时，远程主机上的 session supervisor 与原生 CLI 仍继续运行。
6. 会话的启动、恢复、resume、slash command、权限提示等 provider 行为，一律以远程主机上的实际 CLI 版本为准。

### 5. Terminal Supervisor

远程终端不应该直接等价于聊天会话。

仍应遵循 `terminald` 文档中的项目级终端模型：

- 一个项目多个 terminal tab
- terminal 可独立于聊天会话存在
- terminal 可 attach / detach / reconnect

推荐远程机使用：

- `tmux` 作为 durable substrate
- agent 负责创建 / 复用 tmux session
- `terminald` 负责 control plane 和浏览器 attach

要求：

1. 远程 terminal 的真实生命周期归属于远程主机上的 tmux / supervisor。
2. 浏览器断线不 kill terminal。
3. 主后端重启后可重新 attach。
4. 平台宿主机挂掉时，远程 terminal 只会失去控制连接，不会被远程机上的 tmux / supervisor 主动终止。
5. shell 的行为、启动命令、默认 shell 类型、命令可用性，都由远程主机自身环境决定，不由平台宿主机决定。

## 与现有代码的集成方式

### 1. `project-runtime` 扩展

新增：

- `server/services/project-runtime/remote-adapter.js`

扩展：

- `server/services/project-runtime/context.js`
- `server/services/project-runtime/index.js`
- `server/services/project-runtime/capabilities.js`

目标：

```ts
export async function getProjectRuntimeAdapter(projectName, options = {}) {
  const context = await resolveProjectRuntimeContext(projectName, options);

  if (context.runtime === 'e2b') {
    return createE2BProjectRuntimeAdapter(context);
  }

  if (context.runtime === 'remote_host') {
    return createRemoteProjectRuntimeAdapter(context);
  }

  return createLocalProjectRuntimeAdapter(context);
}
```

`remote-adapter` 对 route handler 暴露的仍然是：

- `files`
- `git`
- `shell`

route handler 不应感知远程协议细节。

### 2. `terminald` 扩展

新增：

- `terminald/runtime/remote.js`

扩展：

- `terminald/runtime/context.js`
- `terminald/runtime/index.js`
- `terminald/store.js`

目标：

1. `resolveTerminalRuntimeContext()` 能解析远程主机 target。
2. `ensureRemoteTerminal()` 能让远程机创建或复用 tmux / PTY。
3. `attachRemoteTerminal()` 能把浏览器字节流 attach 到远程终端。
4. `terminald` 的 terminal record 要能保存 `hostId` / `workspaceId` / `remoteSessionId` 等远程字段。

### 3. `shell` 前端扩展

当前 `useShellConnection` 仍然带有显式 `e2b` 推断。

远程主机接入后，前端必须改成：

- 优先看 `project.capabilities.shell`
- 再看 `project.runtime`
- 不再把“云项目 == e2b”写死为 transport 选择依据

推荐升级为：

```ts
type ProjectShellDescriptor = {
  enabled: boolean;
  transport: 'legacy-host-shell' | 'terminald';
  runtime: 'local' | 'e2b' | 'remote_host';
};
```

前端只根据 descriptor 连接，不自己推理。

### 4. 项目 bootstrap 扩展

当前 `buildBootstrapProject()` 的云端逻辑仍然把 `runtime === 'e2b'` 作为单一云模式。

远程主机接入后，项目 bootstrap 至少需要返回：

```ts
type BootstrapProject = {
  name: string;
  displayName: string;
  runtime: 'local' | 'e2b' | 'remote_host';
  kind: 'local' | 'cloud' | 'remote';
  path: string;
  fullPath: string;
  capabilities: ProjectCapabilities;
  authBindings?: Partial<Record<Provider, ProviderAuthBinding>>;
  targetMeta?: {
    targetId: string;
    hostId?: string;
    workspaceId?: string;
    sandboxId?: string;
  };
};
```

## 认证设计

### 1. 默认语义

#### E2B

默认：

- `ownership = platform_mirrored`
- 平台解析 `AuthBundle`
- 平台同步到 sandbox

#### remote_host

默认：

- `ownership = target_native`
- agent 探测远程主机现有认证
- 不默认上传本地 profile

### 2. 远程主机可选高级模式

虽然默认必须是 `target_native`，但仍应支持高级模式：

#### `pushed_profile`

用户显式选择一个 `Auth Center profile`，平台将 bundle 推送到远程机。

适用场景：

- 远程主机没有登录状态；
- 用户希望平台统一下发一个只用于该工作区的 provider profile；
- CI / 短生命周期 host / 批量初始化。

约束：

1. 必须是显式 opt-in。
2. UI 需要强提示“将把 profile 内容写入远程主机”。
3. 默认不覆盖已有远程文件，除非用户确认。

#### `disabled`

禁用某 provider：

- 不读取远程环境
- 不下发 profile
- 启动 session 时该 provider 不可选

### 3. 不建议的模式

不建议提供“自动复制平台宿主机 auth 到 remote host”的默认按钮。

原因：

1. 容易把 E2B 的产品语义误带到 remote host；
2. 用户通常期望 remote host 使用它自己那台机子的登录状态；
3. 安全边界和用户心智都更差。

如果保留，也应只作为高级选项，并更名为：

- `Push Local Profile`
- 不应叫 `Auto Copy`

### 4. UI 改造建议

当前 `Cloud Auth` 面板文案是面向 E2B 的。

接入远程主机后建议拆分成 target-aware 文案：

#### E2B Project

- `Mirror Host Auth`
- `Use Saved Profile`
- `Disabled`

#### Remote Host Project

- `Use Remote Host Auth`
- `Push Saved Profile`
- `Disabled`

并在 provider 卡片上单独显示：

- `Remote detected`
- `Method: credentials_file / api_key`
- `Files: ~/.claude/.credentials.json`
- `Env keys: OPENAI_API_KEY`

默认只显示摘要。

## 数据模型

### 1. 远程主机表

建议新增：

```sql
CREATE TABLE remote_hosts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  transport TEXT NOT NULL, -- 'agent' | 'ssh-bootstrap-agent'
  execution_user TEXT NOT NULL,
  status TEXT NOT NULL,    -- 'online' | 'offline' | 'degraded'
  fingerprint TEXT,
  capabilities_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 2. 远程工作区表

```sql
CREATE TABLE remote_workspaces (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  remote_host_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  display_name TEXT,
  workspace_root TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, remote_host_id, workspace_root),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_host_id) REFERENCES remote_hosts(id) ON DELETE CASCADE
);
```

### 3. 远程会话表

不建议新增前端层面的 `remoteSessions` 概念，但后端存储层可以先单独建表：

```sql
CREATE TABLE remote_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  remote_host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT,
  summary TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

但长期更推荐统一成通用表：

```ts
type RuntimeSessionRecord = {
  runtime: 'local' | 'e2b' | 'remote_host';
  targetId: string;
  workspaceId?: string | null;
  sandboxId?: string | null;
  sessionId: string;
  provider: Provider;
};
```

### 4. 认证绑定表

建议把 workspace 级 auth policy 持久化：

```sql
CREATE TABLE provider_auth_bindings (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  target_id TEXT NOT NULL,
  workspace_id TEXT,
  provider TEXT NOT NULL,
  ownership TEXT NOT NULL, -- target_native | platform_mirrored | pushed_profile | disabled
  profile_id INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

这样可以避免把所有 auth 选择都塞进 `metadata_json`。

## 项目标识设计

### 1. MVP 命名兼容策略

现有代码大量使用 `projectName` 作为 runtime 解析入口，E2B 通过 `e2b__<sandboxId>` 工作。

为了平滑接入，MVP 可新增前缀：

```ts
remote__<workspaceId>
```

即：

```ts
type ProjectRuntime = 'local' | 'e2b' | 'remote_host';

function isRemoteHostProjectName(projectName) {
  return projectName.startsWith('remote__');
}
```

这样可以快速接入：

- `project-runtime`
- `terminald`
- `bootstrap`
- 路由层权限校验

### 2. 长期目标

长期不应继续把 runtime 解析硬编码在 `projectName` 前缀里。

更合理的是：

```ts
type ProjectRef = {
  projectId: string;
  runtime: ProjectRuntime;
  targetId: string;
  workspaceId?: string;
  sandboxId?: string;
};
```

但这个演进不必阻塞 `remote_host` MVP。

## API 设计

### 1. 主后端对前端 API

建议新增：

- `GET /api/remote-hosts`
- `POST /api/remote-hosts`
- `POST /api/remote-hosts/:id/test`
- `GET /api/remote-hosts/:id/providers`
- `POST /api/remote-workspaces`
- `GET /api/remote-workspaces/:id/bootstrap`
- `POST /api/remote-workspaces/:id/auth-bindings`

### 2. 主后端对 remote-agent RPC

建议使用 `HTTPS + WebSocket`，统一为 agent 内部 API：

- `POST /rpc/host/probe`
- `POST /rpc/workspaces/stat`
- `POST /rpc/files/list`
- `POST /rpc/files/read`
- `POST /rpc/files/write`
- `POST /rpc/git/run`
- `POST /rpc/terminals/ensure`
- `WS /rpc/terminals/:id/attach`
- `POST /rpc/sessions/start`
- `POST /rpc/sessions/:id/send-input`
- `POST /rpc/sessions/:id/interrupt`
- `GET /rpc/sessions/:id/events?cursor=...`

### 3. 事件模型

远程主机上的 provider runtime 也必须先归一化为内部 `RuntimeEvent`，再转成前端 `NormalizedMessage`：

```ts
type RuntimeEvent =
  | { kind: 'session_started'; sessionId: string; provider: string; createdAt: string }
  | { kind: 'assistant_delta'; sessionId: string; content: string; sequence: number }
  | { kind: 'assistant_message'; sessionId: string; content: string; sequence: number }
  | { kind: 'tool_call'; sessionId: string; toolName: string; input: unknown; sequence: number }
  | { kind: 'tool_result'; sessionId: string; content: string; sequence: number }
  | { kind: 'permission_request'; sessionId: string; requestId: string; payload: unknown; sequence: number }
  | { kind: 'status'; sessionId: string; phase: string; text?: string; sequence: number }
  | { kind: 'warning'; sessionId: string; content: string; sequence: number }
  | { kind: 'error'; sessionId: string; content: string; sequence: number }
  | { kind: 'exit'; sessionId: string; exitCode: number | null; sequence: number };
```

这与 E2B 原生 CLI 架构保持一致。

## 会话与终端恢复

### 1. 远程主机会话恢复

会话恢复必须建立在目标端 event store 上，而不是主后端内存上。

要求：

1. 每个 session 有单调递增 `sequence`。
2. 主后端仅保存“每个客户端消费到哪里”。
3. 浏览器重连时携带 `cursorMap`。
4. 主后端向 remote-agent 拉缺失事件并 fan-out。

### 2. 远程终端恢复

terminal 恢复不依赖聊天会话。

要求：

1. `terminald` 只保存 terminal 元数据和 attach 状态。
2. 终端真实生命周期归属于 remote host 上的 tmux / supervisor。
3. 浏览器断线不 kill terminal。
4. 主后端重启后 `terminald` 仍可重新 attach。

## 安全模型

### 1. 默认不回传远程密钥内容

远程主机探测接口默认只回传：

- 是否认证成功
- 认证方式
- 文件路径摘要
- env key 名称

默认不回传：

- `.credentials.json` 内容
- `auth.json` 内容
- token / api key 明文

### 2. 最小权限执行用户

建议每个远程主机连接都绑定一个明确的 `execution_user`。

第一版不支持：

- agent 运行后再 sudo 切换多用户
- 一个 host 对多个 Web 用户做高动态 impersonation

第一版建议明确约束为：

- 一条远程主机连接对应一个平台用户；
- agent 以固定 Unix 用户运行；
- 该用户的 HOME 就是 CLI 配置来源。

### 3. 工作区白名单

所有文件、Git、terminal、session 操作必须被限制在已注册 workspace root 下。

不能允许：

- 任意路径访问
- 通过 `../` 跳出工作区
- 临时指定任意系统目录作为 project root

### 4. 审计

建议记录：

- 哪个用户绑定了哪个 host / workspace
- 哪个 provider 使用了哪种 auth ownership
- 是否推送过 profile 到远程机
- session start / interrupt / close / terminal attach

## 前端改造建议

### 1. Project capability 优先

前端不再用以下规则推理：

- `project.runtime === 'e2b'`
- `project.name.startsWith('e2b__')`

去决定 shell / files / git / transport。

改为：

1. 看后端返回的 `project.capabilities`
2. 看 `project.runtime`
3. 看 `project.targetMeta`
4. 看 `project.authBindings`

### 2. Session 标准化

远程主机 session 进入前端前必须标准化：

```ts
type ResolvedSession = {
  id: string;
  __runtime: 'local' | 'e2b' | 'remote_host';
  __provider: Provider;
  __projectName: string;
  __targetId: string;
  __workspaceId?: string;
};
```

避免继续复制 `e2bSessions` 那套历史问题。

### 3. 认证面板 target-aware

同一套 provider 卡片，展示逻辑按 target 切换：

- E2B: 展示 `Mirror Host Auth`
- Remote Host: 展示 `Use Remote Host Auth`

而不是继续把它们都渲染成 “Cloud Auth”。

## 当前 MVP 实现状态

截至当前这版代码，`remote_host` 已经不再只是“接入前置层”，而是已经具备了可用的远程项目运行时骨架，并且 Claude / Codex 聊天面板已经能通过远程主机自身 CLI 跑起来；但它仍然不是“带远程 session supervisor 的完整远程聊天 runtime”。

### 1. 已落地

- 设置页已经新增 `Remote Hosts` 标签页。
- 初始化表单已经支持两种模式：
  - `Bootstrap via SSH`
  - `Use Existing Agent`
- 已经有 `remote_hosts` 和 `remote_workspaces` 元数据表。
- 已经有 `remote_host_sessions` 和 `remote_host_session_messages` 持久化表，用于远程聊天会话索引与标准化消息回放。
- `remote_hosts.agent_token` 已持久化，用于后续主后端对远程 agent 发起 runtime RPC。
- `remote_hosts.managed_ssh_private_key` / `managed_ssh_public_key` 已持久化，用于平台托管 SSH key 访问。
- `remote_hosts.saved_ssh_password` 已作为可选回退字段落库，默认不保存。
- `workspaceRoot` 已明确要求为远程主机上的绝对路径。
- `POST /api/remote-hosts/test` 在 `Bootstrap via SSH` 模式下，已经从“仅 TCP 探活”升级为“真实 SSH 鉴权 + 远端环境探针”。
- `POST /api/remote-hosts` 与 `POST /api/remote-hosts/bootstrap` 在 SSH 模式下都会安装平台托管 SSH key。
- `POST /api/remote-hosts/bootstrap` 已支持通过 SSH 在远程主机上安装并启动最小 `remote-agent`。
- `POST /api/remote-hosts/browse` 对已保存主机已经支持 `agent -> managed key -> saved password` 回退链路。
- 当前 `remote-agent` 以远程机上的常驻 HTTP 服务形式运行，并提供：
  - `/health`
  - `/probe/system`
  - `/probe/providers`
  - `/fs/list`
  - `/fs/read`
  - `/fs/write`
  - `/fs/mkdir`
  - `/fs/move`
  - `/fs/delete`
  - `/fs/stat`
  - `/process/run`
  - `/terminals/open`
  - `/terminals/read`
  - `/terminals/input`
  - `/terminals/resize`
- 这个探针会返回：
  - 远程登录用户
  - 远程系统与 shell
  - `git` / `tmux` / `claude` / `codex` 是否在远程 PATH 中
  - `~/.claude` / `~/.codex` 是否存在于远程主机
  - `workspaceRoot` 是否存在、是否是目录、是否可写、父目录是否可创建
- `project-runtime` 已支持 `remote_host`：
  - `getProjectRuntimeAdapter()` 能解析 `remote__<workspaceId>`
  - 远程项目已进入统一项目模型与项目列表
  - 文件 API 与 Git API 已通过 remote-agent RPC 落到远程主机
- `/shell` WebSocket 已支持 `remote_host`：
  - 主后端会按稳定 `terminalId` 调 remote-agent 打开 / 复用远程 PTY
  - 浏览器断开后远程 PTY 不会退出
  - 主后端重启后可按相同 `terminalId` 重新 attach
  - shell 的默认工作目录、shell 类型、CLI PATH、版本与 resume 语义来自远程主机自己
- 聊天面板已支持 `remote_host` 的 Claude / Codex：
  - 不再复用平台宿主机上的 Claude SDK / Codex SDK
  - 直接调用远程主机自身 `claude` / `codex` CLI
  - provider CLI 进程通过远程主机自己的 login shell 启动，从远程 `/etc/profile.d/*`、`~/.profile`、`~/.bashrc` 继承环境变量，而不是继承平台宿主机环境
  - `codex` 走 `codex exec --json` / `codex exec resume --json`
  - `claude` 走 `claude -p --verbose --output-format stream-json` / `claude -r`
  - `resume` 使用远程主机上该 provider CLI 自己的 session id 与命令语义
  - 聊天消息会标准化后写入平台数据库，用于刷新后历史回放与 sidebar session 列表
- 前端已对 remote project 做会话级适配：
  - `runtimeMode` 会保留 `remote_host`
  - remote project 新建会话时，聊天面板会显示 Claude / Codex provider 选择
  - 消息发送会显式带上 `projectName + runtimeMode`
  - 远程 session bootstrap、history fetch、sidebar session hydration 都会回到 `remote_host` 持久化数据

### 2. 当前边界

当前的 SSH 探针仍然只是初始化通道，用于：

- 验证用户提供的 SSH 凭据是否真实可用；
- 验证远程机的 CLI / shell / 目录状态；
- 首次安装或升级远程常驻 agent；
- 帮助用户理解“后续 shell、resume、provider version 都会来自远程主机自己”。

当前仍未完成的能力是：

- 创建持久 session supervisor
- 把远程聊天从“单次 CLI 调用桥接”升级为“远程长生命周期 session supervisor”
- `RuntimeEvent -> NormalizedMessage` 的真正流式远程事件流
- Cursor / Gemini 的 remote chat runtime
- 聊天层面的 interrupt / mid-flight reconnect / durable in-flight recovery
- `terminald/runtime/remote.js` 与 tmux-based substrate 的那一版终端控制面

也就是说，当前实现已经处于：

`远程主机注册 + SSH 探测 + remote-agent bootstrap + 项目级 remote files/git + remote shell relay + Claude/Codex remote chat bridge + remote session persistence`

而不是：

`带远程 session supervisor 的完整 remote chat/session runtime`

### 3. 当前凭据策略

当前实现与文档前面的约束保持一致：

- 用户手工输入的 bootstrap 私钥 / passphrase 只在表单提交和测试时临时使用；
- 平台会在 SSH 保存或 bootstrap 成功时生成并保存一对托管 SSH key；
- `agent_token` 作为远程控制面凭据会持久化到平台数据库；
- `saved_ssh_password` 只有在用户明确打开 `保存密码作为回退` 时才会落库；
- 已保存主机的目录浏览与补救访问按 `agent -> managed key -> saved password` 顺序回退；
- 长期方案仍然应收敛到远程主机上的常驻 agent / supervisor。

### 4. 与“宿主机崩溃不影响远端进程”的对齐关系

这一条当前已经“完全对齐到 shell 层”，并且“部分对齐到聊天层”，但还没有“对齐到远程 session supervisor 层”。

原因是：

- 聊天面板当前仍然是“平台发起一次远程 CLI 调用，结果回写标准化消息”；
- 还没有远程 session supervisor 去持有 in-flight chat process。

所以当前版本已经能做到：

- 远程 shell 进程由远程主机上的 remote-agent 持有，而不是由平台宿主机 PTY 持有；
- 浏览器断开不会 kill 远程 shell；
- 主后端重启后可重新 attach 到同一个远程 terminal；
- shell 内部状态与在其中启动的 CLI 进程继续留在远程主机；
- shell / resume / provider version 的行为由远程主机自身版本决定，而不是由平台宿主机决定。

但当前还不能把同样的结论直接推广到聊天面板里的“平台托管 session runtime”，因为那一层尚未远程化。

当前聊天层已经能保证的是：

- 会话真正使用的是远程主机自己的 `claude` / `codex` 可执行文件与远程 session id；
- 刷新页面后，历史消息与 sidebar session 仍能从平台数据库恢复；
- 继续发送下一轮消息时，`resume` 仍然走远程主机该 provider CLI 自己的 resume 语义。

当前聊天层还不能保证的是：

- 平台主后端在某次远程聊天调用进行中崩溃后，该次 in-flight chat process 仍可被重新 attach；
- 中途 `abort`、增量流式输出、进程级持有完全脱离平台主后端内存。

### 5. 当前网络前提

当前 remote-agent 方案默认要求：

- 平台主后端可以直接访问远程主机上的 agent HTTP 端口；
- 远程主机侧云防火墙 / 安全组 / 本机防火墙允许该端口入站；
- 或者未来补一层专门的反向隧道 / 回连控制面。

这意味着当前 bootstrap 可能出现一种“部分成功”状态：

1. SSH 安装成功；
2. 远程机本地 `remote-agent` 健康检查成功；
3. 但平台主后端无法直接访问该 agent 端口。

在这种情况下：

- 说明 agent 已经在远程机上运行；
- 但当前平台还不能把它当成可用的主控制面；
- UI 应明确提示用户检查安全组、防火墙或后续改用反向连回模型。

## 分阶段落地计划

### Phase 0: 文档与模型收敛

完成：

- 本文档
- runtime / auth ownership 双轴模型
- remote-agent 职责定义

### Phase 1: 元数据与项目发现

完成：

- `remote_hosts`
- `remote_workspaces`
- `project bootstrap` 支持 `remote_host`
- provider probe 摘要接口

不做：

- 聊天会话
- 终端 attach

### Phase 2: `project-runtime` 远程文件 / Git

完成：

- `createRemoteProjectRuntimeAdapter()`
- files / git capability 走远程 agent RPC
- 前端 files / git tab 能对 remote host 工作

### Phase 3: 远程终端控制面

当前已完成：

- 项目级 remote shell attach / detach / reconnect
- 远程 PTY 由 remote-agent 常驻持有
- 主后端重启后按稳定 `terminalId` 重新 attach

当前仍未完成：

- `terminald/runtime/remote.js`
- `terminald` store 中的远程 terminal record 建模
- tmux based durable terminal substrate

### Phase 4: 远程原生 CLI 会话

待完成：

- remote host session supervisor
- `RuntimeEvent -> NormalizedMessage`
- cursor replay
- durable native `claude` / `codex`

### Phase 5: 高级 auth policy

部分完成：

- `Use Remote Host Auth`
- remote_host target-aware 的前端文案与阻断提示

待完成：

- `Push Saved Profile`
- workspace 级 provider auth binding
- 安全确认与审计

## 明确不做的事情

第一版不做：

1. 浏览器直连远程主机。
2. 共享一台远程主机给多个平台用户做多用户 Unix impersonation。
3. 默认把平台宿主机 auth 自动复制到远程主机。
4. 为 remote host 新开一套前端 `remoteSessions` 容器。
5. 把 SSH 作为长期主链路。

## 需要显式避免的实现陷阱

1. 不要在 route handler 里新增 `if remote_host` 分支蔓延。
2. 不要让前端继续根据 `runtime === 'e2b'` 推导 transport。
3. 不要把远程主机认证默认为 `platform_mirrored`。
4. 不要继续依赖平台宿主机的 `~/.claude` / `~/.codex` 去发现 remote project/session。
5. 不要把 remote host 的 durable session 绑定到主后端 Node 进程内存。

## 远程主机全同步

当前新增了一套面向 `remote_host` 的全同步导出能力，用来把“平台侧 remote host 元数据 + 远程主机自身的 CLI / session / 数据目录”一起导出成一个本地快照。

### 目标

用于：

1. 迁移远程主机接入配置。
2. 排障时保留平台数据库记录与远程实际状态。
3. 在远程主机重装、迁移、替换前做一次完整快照。

### 同步范围

平台侧导出：

- `remote_hosts`
- `remote_workspaces`
- `remote_host_sessions`
- `remote_host_session_messages`

远程侧导出：

- `~/.claude`
- `~/.codex`
- `~/.gemini`
- `~/.cursor`
- `~/.claude-code-ui`
- 每个已注册 workspace 下的：
  - `.cloudcli-data`
  - `.claude`
  - `.codex`
  - `.gemini`
  - `.cursor`
  - `.claude-code-ui`

注意：

- 远程导出默认优先走 `managed SSH key`，再回退到已保存密码。
- 这条链路不依赖当前平台宿主机自己的 CLI 配置。
- 即使远程 agent HTTP 不可达，只要 SSH 回退可用，快照仍可导出。

### 产物结构

当前快照目录包含：

- `manifest.json`
- `platform-state.json`
- `remote-inspect.json`
- `remote-state.tar.gz`

其中：

- `platform-state.json` 是平台数据库中该 remote host 的结构化导出。
- `remote-inspect.json` 记录远程侧哪些目录实际存在、命中了哪些数据库文件。
- `remote-state.tar.gz` 是远程目录归档，内容敏感，可能包含远程 CLI 凭据。

### 入口

HTTP 接口：

- `POST /api/remote-hosts/:hostId/sync`

CLI 脚本：

- `node scripts/remote-host-full-sync.js --label <saved-host-label>`
- `node scripts/remote-host-full-sync.js --host-id <saved-host-id>`
- `node scripts/remote-host-full-sync.js --host <saved-host-address>`

可选参数：

- `--username <platform-user>`
- `--workspace-root <remote-workspace-root>`，可重复传入
- `--output-dir <local-dir>`
- `--include-platform-secrets`

### 设计约束

1. 全同步是“导出快照”，不是在线双向实时同步。
2. 远程归档默认视为敏感文件，不能当普通调试日志处理。
3. 同步能力必须以远程主机自己的文件与 CLI 状态为准，不由平台宿主机决定内容。
4. 后续如果要支持“恢复”，必须单独设计恢复流程，不能直接把当前导出脚本反向执行。

## 最终判断标准

当下面条件同时成立时，说明 `remote_host` 设计是正确的：

1. route handlers 不需要理解远程协议细节，只消费 capability adapter。
2. 浏览器关闭后，远程主机上的 Claude / Codex 仍继续运行。
3. 主后端重启后，会话和终端都能按 cursor / tmux 重新接回。
4. 平台宿主机挂掉时，远程主机上的 CLI / terminal / session supervisor 继续运行，平台恢复后可重新接回。
5. 远程项目默认读取远程主机自己的 provider 配置，而不是平台宿主机配置。
6. E2B 与 remote host 可以共用 UI、会话模型、terminal 模型和消息模型，但 auth ownership 可不同。
