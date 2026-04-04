# 会话架构重构与修复方案

## 关键前提

本文档的所有方案基于以下两个前提。任何偏离这两条的设计都必须显式说明理由。

1. **多会话并发是常态**：用户在会话 A 正在 streaming/processing 时切换到会话 B
   查看历史是正常操作。前端必须维护 per-session 的生命周期状态，切换视图不得
   抹掉后台会话的 streaming/processing 语义。
2. **session ID 不是全局唯一**：同一个 session ID 可能同时出现在同项目的
   `sessions` 和 `e2bSessions` 中（后端 bootstrap 双写 bug），也可能出现在不同
   项目中（跨项目 session 引用）。所有以 session ID 做主键/去重/路由的逻辑必须
   额外携带 `projectName` + `transport` 来消歧。

---

## 一、当前问题总结

### 1.1 前端问题

| 问题 | 根因 | 严重度 |
|------|------|--------|
| 本地会话显示 e2b 标签 | `effectiveRuntimeMode` 依赖 `selectedProject.runtime`，路由 effect 在云项目 `e2bSessions` 中先命中同 ID 会话时覆盖 `selectedProject` | P0 |
| Sidebar duplicate key | 同一 session ID 同时存在于 `project.sessions`、`additionalSessions`、`project.e2bSessions`，去重不完整 | P0 |
| 发送消息卡住/不到达后端 | `effectiveRuntimeMode` 误判为 `e2b` → 前端发 `e2b-command` → 后端 sandbox 路径失败但错误被吞 | P0 |
| Maximum update depth | `processingSessions` Set 每次 mark 创建新引用，触发下游 effect 级联 | P1 |
| 切换会话看不到新回复 | 缓存检查在 `sessionChanged` 之前执行，切换回已缓存会话时跳过 fetch | P1 |
| isLoading 永远卡住 | 5 个写 true、5 个写 false 分布在 4 个文件，无状态机约束 | P1 |
| Session Store 内存增长 | Map 永不淘汰旧 slot | P2 |
| WebSocket `ws` 引用快照 | `useMemo` 读 ref 当前值，不随重连更新 | P2 |

### 1.2 后端问题

| 问题 | 根因 | 严重度 |
|------|------|--------|
| Bootstrap 双写 | `buildBootstrapProject` 当 `provider=claude && runtime=e2b` 时同一 session 同时放入 `sessions` 和 `e2bSessions` | P0 |
| WebSocket 消息静默丢失 | `readyState !== 1` 时丢弃，无缓冲无 ACK | P0 |
| 会话状态无单一来源 | SDK 内存、session-bridge Map、DB status、check-session-status 各自为政 | P1 |
| E2B sandbox 全局单例 | `sandbox-manager` 只维护一个 `activeSandboxClient`，多 sandbox 冲突 | P1 |
| Normalized vs Legacy 消息并存 | `agent.js` SSE 用旧格式，`ResponseCollector` 与 NormalizedMessage 不兼容 | P1 |
| REST/WebSocket 双入口不一致 | E2B 会话可从两个入口创建，配置/auth 上下文不同 | P2 |
| DB 无引用完整性 | 无 FK、INSERT OR IGNORE 静默吞更新 | P2 |

---

## 二、已实施修复 (Phase 1)

### 2.1 前端 Sidebar 彻底去重 ✅

**文件**: `src/components/sidebar/utils/utils.ts`

`getAllSessions` 使用 `Map<id, SessionWithProvider>` 做 **first-wins** 去重。
插入顺序（先到先得）：**claude → cursor → codex → gemini → e2b**。

本地 provider 列表先加入 Map，e2b 列表最后加入。效果：

- 同 ID 同时存在于 `project.sessions`（local）和 `project.e2bSessions` 时，local 版本赢
- session **仅**存在于 `e2bSessions` 时才标记 `__runtime: 'e2b'`
- `additionalSessions`（分页加载更多）与 `project.sessions` 的内部重复也被 Map 自然去除

### 2.2 路由 Effect 加 `__runtime` 纠正 ✅

**文件**: `src/hooks/useProjectsState.ts`

`findSessionInProject` 的 `shouldUpdateSession` 增加 `__runtime` 检查。
当 session 在 `project.sessions` 中找到，显式设 `__runtime: undefined`，纠正残留的 e2b 标记。
搜索顺序：先当前 `selectedProject`，后其他项目。

### 2.3 `effectiveRuntimeMode` 以 session 为准 ✅

**文件**: `ChatInterface.tsx`, `useChatComposerState.ts`, `useChatSessionState.ts`

旧逻辑：`session.__runtime === 'e2b' || project.runtime === 'e2b'`
新逻辑：有 `selectedSession` 时只看 `session.__runtime`；无 session（新建模式）才 fallback 到 `project.runtime`。

`getTransportProvider` 同步改为 session 优先。

### 2.4 后端 `buildBootstrapProject` 去重 ✅

**文件**: `server/projects.js`

根因：`provider === 'claude' && runtime === 'e2b'` 导致双写。
修复：`runtime === 'e2b'` 时只写 `e2bSessions`，provider-specific 列表写空数组。

### 2.5 之前已实施的修复 ✅

- 原子会话切换（`handleSessionSelect` 用 `projectsRef` 避免 `projects` 进依赖数组）
- `processingSessions` Set 引用稳定（已存在时返回同一引用）
- 缓存失效顺序（`sessionChanged` 在缓存检查前）
- 流式状态刷新（`useChatRealtimeHandlers` 切换 session 时 flush 前一个 session 的 buffer）
- i18n 缺失 key（`copyMessage.markdownShort/textShort`，6 语言）

---

## 三、重构方案

### 3.1 Phase 2: 前端状态统一（1-2 天）

#### 3.1.1 所有 session ingress 统一 normalize

**目标**: 消除 session 进入 `selectedSession` 的多条路径之间的不一致。

**当前入口**:

| 入口 | 代码位置 | 是否 normalize |
|------|----------|----------------|
| sidebar 点击 | `handleSessionSelect` | ✅ 有 `__projectName`、sidebar 传入 `__provider`/`__runtime` |
| deep-link bootstrap | `setSelectedSession(payload.session)` (`useProjectsState.ts:429`) | ❌ 原样落地，无 `__provider`/`__runtime` |
| 路由 effect | `findSessionInProject` (`useProjectsState.ts:591`) | ✅ 会设置 `__provider`/`__runtime` |
| 通知跳转 | `navigate(\`/session/${message.sessionId}\`)` (`AppContent.tsx:97`) | ❌ 只有 sessionId，无 projectName |
| 静默 refresh | `handleSidebarRefresh` (`useProjectsState.ts:780`) | ⚠️ 尝试保留旧 metadata，但不做 re-resolve |
| projects_updated WS | 消息处理 effect (`useProjectsState.ts:559`) | ❌ 从 `getProjectSessions` 找回，无 provider tag |

**方案**: 提取 `normalizeSessionSelection(session, project): ResolvedSession` 函数：

```typescript
function normalizeSessionSelection(
  rawSession: ProjectSession,
  project: Project,
): ProjectSession {
  // 1. 确定 transport: session 在 project.e2bSessions 中 → 'e2b'，否则 → undefined
  // 2. 确定 provider: 按 e2b/cursor/codex/gemini/claude 列表归属确定
  // 3. 附加 __projectName, __projectPath
  // 4. 返回标记完整的 session 对象
}
```

**所有 6 个入口**在写 `setSelectedSession` 之前，都必须经过这个函数。
bootstrap 入口需先用 `payload.project` 查找 session 归属列表，再 normalize。

#### 3.1.2 统一会话指针

**目标**: 将分散的 5 套"当前会话"指针合并为一个原子状态。

**当前问题**:
- URL `sessionId`（路由参数）
- `selectedProject` + `selectedSession`（useProjectsState）
- `currentSessionId`（useChatSessionState）
- `pendingViewSessionRef`（useChatSessionState）
- `sessionStorage.pendingSessionId`

**方案**: 引入 `useSessionNavigation` hook：

```typescript
type SessionNavState = {
  projectName: string | null;
  sessionId: string | null;
  // 派生（从 projects 列表 resolve）
  project: Project | null;
  session: ProjectSession | null;   // 已 normalize，携带 __provider/__runtime/__projectName
  // 过渡态
  pendingSessionId: string | null;
};
```

所有组件从这一个来源读取。`transport` 和 `agent` 不存在这里——它们是 session 对象上的
`__runtime` 和 `__provider` 属性（由 3.1.1 的 normalize 保证）。

#### 3.1.3 会话生命周期状态机（per-session Map）

**目标**: 用 per-session 状态机替代散布的布尔值 `isLoading + canAbortSession + claudeStatus + processingSessions`。

**关键约束**: 必须是 `Map<string, SessionLifecycleState>`，不是单一全局状态。
原因：`useChatRealtimeHandlers` 的 `streamStatesRef`（:117）和 `terminalStateRef`（:122）
都是按 sessionId 分桶的。切换到 B 查看历史时，A 的 streaming buffer 和 processing
标记必须保留。

```typescript
type SessionPhase =
  | 'idle'
  | 'submitting'
  | 'streaming'
  | 'processing'
  | 'complete'
  | 'error';

type SessionLifecycleEntry = {
  phase: SessionPhase;
  tokens: number;
  canInterrupt: boolean;
  errorMessage?: string;
  updatedAt: number;
};

// 核心数据结构
type LifecycleStore = Map<string, SessionLifecycleEntry>;
```

**状态转换规则**（只有合法转换才能执行）：

```
idle       → submitting（当前 session 用户发送）
submitting → streaming （收到该 session 的 stream_delta）
submitting → processing（收到该 session 的 session-status）
submitting → error     （收到该 session 的 error）
streaming  → processing（stream_end 后仍有 tool_use）
streaming  → complete  （收到 complete）
processing → streaming （新一轮 stream_delta）
processing → complete  （收到 complete）
processing → error     （收到 error）
```

**不存在 `any → idle（会话切换）`**。切换视图只改变"当前查看的 sessionId"，
不改变其他 session 的 lifecycle entry。只有以下情况才 → idle：
- 该 session 自身收到 `complete` 后经过去抖
- 该 session 超时（5 分钟无消息自动清理，复用现有 `useSessionProtection` 逻辑）
- 该 session 被显式 abort

**文件变更**:
- 新建 `src/hooks/useSessionLifecycle.ts`（暴露 `Map` + `dispatch` + 当前 session 的派生 `phase`）
- 改造 `useChatSessionState.ts`：删除 `isLoading`、`canAbortSession`，改读 lifecycle Map
- 改造 `useChatRealtimeHandlers.ts`：通过 `dispatch({ sessionId, type: 'STREAM_DELTA' })` 驱动
- 改造 `useChatComposerState.ts`：通过 `dispatch({ sessionId, type: 'SUBMIT' })` 触发
- 改造 `useSessionProtection.ts`：`processingSessions` 从 lifecycle Map 派生，不再独立维护

#### 3.1.4 messageFeed 消息路由层

**目标**: 消除多个模块重复线性扫描 `messageFeed` 数组的问题。

**当前消费者**（3 个，不是 2 个）:

| 消费者 | 代码位置 | 关心的消息类型 |
|--------|----------|----------------|
| `useProjectsState` | `useProjectsState.ts:454` | `projects_updated`, `loading_progress` |
| `useChatRealtimeHandlers` | `useChatRealtimeHandlers.ts:116` | `stream_delta`, `stream_end`, `complete`, `error`, `session-status`, `permission-request`, 等 |
| `TaskMasterContext` | `TaskMasterContext.tsx:214` | `taskmaster-*`, `mcp-*` 等 |

**方案**: 在 `WebSocketContext` 的 `pushMessage` 中引入分发层：

```typescript
type MessageChannel = {
  id: string;
  filter: (msg: AppSocketMessage) => boolean;
  handler: (msg: AppSocketMessage, sequence: number) => void;
};

// WebSocketContext 维护 channels 列表
// pushMessage 时遍历 channels，按 filter 匹配后调用 handler
// 各模块通过 useEffect 注册/注销自己的 channel
```

`messageFeed` 数组仍保留作为 fallback/调试用途，但主消费路径走 channel 分发。
`TaskMasterContext`、`useProjectsState`、`useChatRealtimeHandlers` 各注册自己的 channel。

**迁移策略**: 先加 channel 机制，让三个消费者逐个迁移，最后再废弃 messageFeed 扫描。

#### 3.1.5 Session Store LRU 淘汰

**目标**: 限制内存中缓存的 session slot 数量。

**方案**: `useSessionStore` 的 Map 加 LRU 策略，最多保留 20 个 slot。
超出时淘汰最久未访问的 slot（标记为 stale，下次切回时重新 fetch）。

---

### 3.2 Phase 3: 前端 Provider 解析统一（1 天）

#### 3.2.1 一次性确定 transport + agent

**目标**: session 选择/创建时一次性确定 `{ __runtime, __provider, __projectName, __projectPath }` 四元组，后续所有代码只读。

**当前问题**: "这个会话用什么 provider" 在 5+ 处重复推断：
- `effectiveRuntimeMode`（ChatInterface, useChatComposerState）
- `getTransportProvider`（useChatSessionState）
- `handleSubmit` 里 `if (effectiveRuntimeMode === 'e2b')`
- `messages.js` 的 `req.query.provider`
- `session-bridge` 的 `resolveSubProvider`

**方案**: 3.1.1 的 `normalizeSessionSelection` 已经在所有入口统一设置这些属性。
Phase 3 的工作是：

1. 删除 `effectiveRuntimeMode` 变量——直接读 `selectedSession.__runtime`
2. 删除 `getTransportProvider` 函数——直接读 `selectedSession.__provider`
3. `handleSubmit` 用 `selectedSession.__runtime` 判断 `e2b-command` vs `claude-command`
4. 确保所有入口（特别是 bootstrap、notification、refresh）都经过 normalize

**需要覆盖的入口**（重申 3.1.1 的表格）：
- sidebar 点击 ✅
- deep-link bootstrap：改造 `useProjectsState.ts:429` 处的 `setSelectedSession`
- 路由 effect ✅
- 通知跳转：`AppContent.tsx:97` 只有 sessionId，navigate 后靠路由 effect resolve
- 静默 refresh：`handleSidebarRefresh` 的 `setSelectedSession` 处加 normalize
- `projects_updated` WS：`useProjectsState.ts:559` 处加 normalize

---

### 3.3 Phase 4: 后端可靠性增强（2-3 天）

#### 3.3.1 WebSocket 消息可靠性

**约束**: 当前 `/ws` 是复用连接，承载：
- 连接级消息：`loading_progress`（`server/index.js:113`）
- 多 session 的命令与状态流（`server/index.js` 中 `sendToClient` 的所有调用点）
- 无 sessionId 的全局通知：`projects_updated`、`taskmaster-*`、`mcp-*`

因此恢复粒度必须是 **per-connection**（不是 per-session），否则断线后会丢
跨 session 和无 sessionId 的消息。

**方案**:

```
1. 服务端为每条出站消息添加 connection-level 递增 seq
2. 服务端维护 per-connection 的环形缓冲（最近 500 条）
3. 客户端重连时发送 { type: 'resume', lastSeq: N }
4. 服务端重放 seq > lastSeq 的所有消息（不按 session 过滤）
5. 若 lastSeq 已被缓冲淘汰，服务端回复 { type: 'resume-failed' }，
   客户端走全量 refresh（fetchProjects + fetchFromServer）
```

**文件变更**:
- `server/index.js`：`sendToClient` 添加 `seq` 计数 + 环形缓冲
- `server/index.js`：处理 `resume` 消息类型
- `src/contexts/WebSocketContext.tsx`：记录 `lastSeq`，重连时发送 `resume`

#### 3.3.2 会话状态持久化

**约束**: session ID 不是全局唯一（见"关键前提 #2"），因此 `session_id` 不能
单独做主键。

**方案**: 复合主键 `(session_id, project_name, transport)`：

```sql
CREATE TABLE session_state (
    session_id   TEXT NOT NULL,
    project_name TEXT NOT NULL,
    transport    TEXT NOT NULL,   -- 'local' | 'e2b'
    status       TEXT NOT NULL DEFAULT 'idle',
    provider     TEXT NOT NULL,   -- claude/cursor/codex/gemini
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, project_name, transport)
);
```

所有写入方（SDK wrapper、session-bridge、agent.js）都必须同时提供三个键值。
`check-session-status` 查这张表 + 检查进程/桥接是否存活，返回权威结果。

#### 3.3.3 淘汰 Legacy 消息格式

**范围**: 不仅覆盖 SSE 流式路径，还必须覆盖 `/api/agent` 的非流式聚合路径。

当前非流式路径直接依赖 `writer.getAssistantMessages()` / `writer.getTotalTokens()`
（`server/routes/agent.js:1023`），这些方法内部读的是 `type: 'claude-response'`
旧格式写入的数据。

**迁移策略**:

1. **Phase A（兼容期）**: `NormalizedMessage` writer 同时写 `kind` 和 `type` 字段。
   `getAssistantMessages()` / `getTotalTokens()` 优先读 `kind`，fallback 读 `type`。
   前端同时处理两种格式。

2. **Phase B（切换期）**: 验证所有消费方都能处理 `kind` 后，`writer` 停写 `type`。
   `ResponseCollector` 改为只解析 `kind`。前端删除 `type` 处理分支。

3. **Phase C（清理）**: 删除 `getAssistantMessages()` / `getTotalTokens()` 中的
   `type` fallback。删除 `type: 'claude-response'` 相关常量。

---

## 四、实施顺序

```
Week 1:
  Day 1-2: Phase 1 紧急修复 + 验证（已完成）
  Day 3:   Phase 2 - 3.1.1 normalizeSessionSelection（所有入口统一）
  Day 4:   Phase 2 - 3.1.2 统一会话指针
  Day 5:   Phase 2 - 3.1.3 per-session lifecycle 状态机

Week 2:
  Day 1:   Phase 2 - 3.1.4 messageFeed 消息路由层
  Day 2:   Phase 2 - 3.1.5 Session Store LRU
  Day 3:   Phase 3 - Provider 解析统一（删除 effectiveRuntimeMode 等）
  Day 4-5: Phase 4 - 3.3.1 WebSocket per-connection 恢复协议

Week 3:
  Day 1:   Phase 4 - 3.3.2 会话状态持久化（复合主键）
  Day 2-3: Phase 4 - 3.3.3 淘汰 Legacy 格式（Phase A+B）
  Day 4-5: 集成测试 + 回归测试
```

---

## 五、验证清单

### Phase 1（已实施）

- [ ] 从 e2b 云项目切换到本地项目会话：不显示 e2b 标签
- [ ] 从本地项目切换到 e2b 云项目会话：正确显示 e2b 标签
- [ ] 同一 session ID 出现在多个列表中：Sidebar 不报 duplicate key
- [ ] 本地会话发送消息：走 `claude-command` 而不是 `e2b-command`
- [ ] e2b 会话发送消息：走 `e2b-command`
- [ ] 快速切换会话：loading 状态正确转换，不卡住
- [ ] 切换回之前的会话：显示最新消息和正确的 processing 状态

### Phase 2（session ingress + lifecycle）

- [ ] deep-link 进入会话：`__provider`/`__runtime`/`__projectName` 完整
- [ ] 通知跳转进入会话：同上
- [ ] 静默 refresh 后：`selectedSession` 的 metadata 不丢失
- [ ] A 会话 streaming 中切到 B 再切回 A：A 的 streaming 状态仍在
- [ ] A 会话 processing 中切到 B：sidebar 中 A 仍显示活跃状态

### Phase 3（provider 统一）

- [ ] 代码中不再存在 `effectiveRuntimeMode` 变量
- [ ] 代码中不再存在 `getTransportProvider` 函数
- [ ] 所有 `selectedSession` 对象上都有 `__provider` 和 `__runtime`

### Phase 4（后端）

- [ ] WebSocket 断线 3 秒内重连：不丢消息（connection-level seq 恢复）
- [ ] WebSocket 断线超过缓冲容量：回退到全量 refresh
- [ ] `check-session-status` 返回结果与 DB `session_state` 一致
- [ ] `/api/agent` 非流式路径在 Legacy 格式删除后仍然正常工作
- [ ] 长时间使用多会话：前端内存不无限增长（LRU 淘汰生效）
