# Sidebar Redesign & Quick Launcher 需求 / 设计文档

> 版本：v1.0  最后更新：2026-05-25
> 范围：左侧 Sidebar 视觉与交互改造、Remote workspace 二级菜单、空状态 Quick Launcher

---

## 1. 背景

当前左侧 Sidebar（`src/components/sidebar/`）经过多轮迭代后存在以下用户可见问题：

| # | 痛点 | 触发 |
|---|---|---|
| P1 | 项目"更多操作"下拉菜单（`ProjectActionsMenu`）在 sidebar 右侧时被视口边缘截断 | `ProjectActionsMenu.tsx:64-67` 用 `setMenuPosition({ left: rect.left })` 没考虑 right-edge clamp |
| P2 | Sidebar 固定 `md:w-72`(288px)，长项目名/长路径必 truncate；用户无法手动调宽 | `SidebarContent.tsx:102` 写死宽度，没有 resize 控件 |
| P3 | 字体阶梯不统一：段头 `text-[11px]`、project name `text-sm`、session meta `text-[10px]/[11px]` 散落各处 | `SidebarProjectList.tsx:140` / `SidebarProjectItem.tsx:247,276` 等 |
| P4 | Remote section 平铺：所有 remote workspace 在同一层级，看不出"哪些 workspace 同属一台机器" | `SidebarProjectList.tsx:125,207-211` 直接按 `runtime === 'remote_host'` flat 渲染 |
| P5 | 单个 Remote workspace 无法独立刷新 sessions：只能整体 refresh projects | sidebar 项目项没有 per-project refresh |
| P6 | Remote workspace `displayName` 创建后不能改：当 host 给出形如 `playwright-remote-host-1775392483161-browse` 这种自动生成名时，用户没法起 `gpu` 之类的别名 | `RemoteHostsSettingsTab.tsx` 列表只有 Delete，没有 Rename；后端 `remoteWorkspacesDb` 无 `update()` |
| P7 | 未选项目空状态信息量低：仅 `MainContentStateView` 一个 hint 文字，没有 launcher / recents | `MainContentStateView.tsx:40-55` |
| P8 | 左上 "+" 按钮直接打开 SessionLauncher，缺少 "Run on \<host\>" / "Browse Remote Directories" / Recents 多入口 | `SidebarHeader.tsx:141-150` |

参考视觉：用户提供了 Cursor IDE 的 5 张截图（多级菜单、Recents 列表、Run On 二级菜单、Branch picker、Empty state 输入框风格）。

## 2. 需求

### R1 — 修菜单遮挡（P0，10 分钟）
- `ProjectActionsMenu` 在计算 `menuPosition.left` 时，若 `rect.left + menuWidth > viewport.width`，则改用右对齐 `left = rect.right - menuWidth`
- 已有的垂直 flip（line 60-62）保留
- 加 `menuWidth = 144` 与 viewport `innerWidth` 防止超出

### R2 — Sidebar 宽度可拖拽（P0）
- 桌面端在 `SidebarContent` 容器右边缘放置一根 4px 拖拽 handle（hover 时背景变色）
- 约束：`min 240px, max 480px`
- 鼠标按下后 listen `mousemove` / `mouseup`；body cursor 设 `col-resize`、`user-select: none`
- 释放后存 `localStorage['sidebar-width']`，下次启动 `useSidebarController` 从 localStorage 恢复
- mobile (< md) / collapsed 模式不渲染 handle

### R3 — 每个 Remote workspace 独立 refresh（P0）
- 在 remote workspace 的 sidebar 项标题区右侧、`ProjectActionsMenu` 之前新增一个 16px refresh icon button
- 行为：调用现有 `loadMoreSessions` 的初始页路径（重置 offset=0 后拉 `sessionsApi.list`），仅刷该 workspace
- 与现有 `loadingSessions[project.name]` 状态联动显示 spinner

> 实施细节：在 `useSidebarController` 增加 `refreshSingleProjectSessions(project)`，复用 `loadMoreSessions` 的 fetch，但把 offset 设 0 并 replace 而非 append（已有 hook 内可参数化）。

### R4 — Remote workspace 别名（alias）可在 Settings 修改（P0）
- 后端：
  - `remoteWorkspacesDb` 新增 `update(userId, id, { displayName })`
  - 路由 `PATCH /api/remote-hosts/workspaces/:workspaceId` 调用上述方法
- 前端 API 层：`api.remoteHosts.updateWorkspace(workspaceId, { displayName })`
- Settings UI（`RemoteHostsSettingsTab` 内 workspace row）：
  - 工作区名标题旁边加 `Edit` icon 按钮
  - 点击进入 inline edit：Input + Save / Cancel
  - 保存调用上述 API → 刷新列表
- Sidebar 显示：`project.displayName`（即 workspace.display_name）；fallback `workspaceRoot` 末段（已有，不动）

### R5 — Remote section 二级菜单（P0）
- `SidebarProjectList` 的 Remote section 不再 flat 渲染：
  - 把所有 `runtime === 'remote_host'` 的 project 按 `remoteHostLabel`（来自 `/api/remote-hosts` 已 join 在 workspace 里）分组
  - 一级：Host 标题（host.label），左 icon `Server`，右侧两个 icon button：
    - **"+"**：触发 `RemoteDirectoryBrowserModal`（hostId 锁定为该 host）；选定路径 → `POST /:hostId/workspaces` → refresh sidebar
    - **refresh**：拉 `/api/remote-hosts` + `/api/projects`，并把该 host 对应的 workspace `loadingSessions` 全置 true 等结果回填
  - 二级：原 workspace 项目（`SidebarProjectItem`）
- 一级菜单展开状态持久化到 `expandedRemoteHosts: Set<string>`（hook state），按 host id 索引
- 不属于任何已知 host 的 workspace（host 已删但 workspace 残留）放入 "Unknown host" 兜底分组

> 后端需求：sidebar 需要拿到 host 列表 + per-project host id。后者可走两条路径之一：
> 1) 复用 `/api/remote-hosts`（返回 hosts + workspaces），sidebar 拿来与 `projects` 做 join：`project.fullPath === workspace.workspaceRoot`
> 2) 让 `/api/projects` 在 remote project 上加 `remoteHost: { id, label }` 字段
>
> **选 1**，避免改 `/api/projects`（其它路径已大量依赖现有 schema）。在 `useSidebarController` 加 effect 拉 `/api/remote-hosts` 一次（带 1 分钟 cache），构建 `Map<workspaceRoot, host>`。

### R6 — 字体 / 间距统一（P1）
- 段头：`text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80`（保持）
- Project name（level 1）：`text-sm font-semibold text-foreground`
- Project meta（副标题）：`text-xs text-muted-foreground`
- 移除 `text-[9px]` / `text-[10px]` badge，统一 `text-[10px] font-medium`
- 项目 hover/selected padding：`px-3 py-2`（保持）
- Session item 副标题：`text-[11px] text-muted-foreground`

### R7 — 未选项目时 Quick Launcher（P0）
当 `selectedProject == null && !isLoading`，`MainContentStateView` 渲染：

```
   [ claudecodeui-e2b ▼ ] [ 📁 dev_yitdong ▼ ]
   ┌──────────────────────────────────────┐
   │ Plan, Build, / for commands, @ ...   │
   └──────────────────────────────────────┘
   [ Plan New Idea ⇧Tab ]   [ Run in Cloud ]
```

- 项目下拉：复用 `useRecentProjects` 输出（按 lastSelectedAt 倒序，去重，最多 8 条）+ 末尾 "Open Folder…" / "Browse Remote Directories…" / "Connect SSH…" 三个 action
- Branch picker（次要）：placeholder 显示 "Select branch"（受 project.cloud.branch 默认），暂时不实现下拉
- Runtime picker：本地 (HOST 名)、列出所有 saved remote host、Cloud
- Input：placeholder "Plan, Build, / for commands, @ for context"。Enter 时：
  - 如有 selected project：以该 project 创建新 session 并发首条消息
  - 如无：弹个 toast 提示先选项目
- "Plan New Idea ⇧Tab"：trigger thinking mode（占位 button，先不实现 hotkey）
- "Run in Cloud" 仅在选中本地 project 时显示：等价 SessionLauncher e2b 流程

### R8 — 左上 "+" 升级为多级菜单（P1）
`SidebarHeader` 的 `Plus` 按钮 click 后弹出 dropdown（与 R7 复用同一 menu）：
- "Open Folder…"（local project new）
- "New Cloud Session…"（e2b）
- "Browse Remote Directories…"（先弹 host picker，再 RemoteDirectoryBrowserModal）
- "Connect SSH…"（跳 Settings remote-hosts tab）

> 实施：抽 `<QuickLauncherMenu />` 组件，被 `SidebarHeader` 和 `MainContentStateView` 共用。

---

## 3. 详细设计

### 3.1 文件改动汇总

| 类型 | 路径 | 改动 |
|---|---|---|
| 修改 | `src/components/sidebar/view/subcomponents/ProjectActionsMenu.tsx` | left clamp |
| 修改 | `src/components/sidebar/view/Sidebar.tsx` | 嵌入 `SidebarResizeHandle`、传 width |
| 修改 | `src/components/sidebar/hooks/useSidebarController.ts` | 增 `sidebarWidth` / `setSidebarWidth` / `expandedRemoteHosts` / `toggleRemoteHost` / `refreshSingleProjectSessions` / `remoteHostsByWorkspaceRoot` |
| 修改 | `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | 接收 width prop, inline style + 渲染 resize handle |
| 新增 | `src/components/sidebar/view/subcomponents/SidebarResizeHandle.tsx` | 拖拽 handle |
| 修改 | `src/components/sidebar/view/subcomponents/SidebarProjectList.tsx` | remote section 改 group by host |
| 新增 | `src/components/sidebar/view/subcomponents/SidebarRemoteHostGroup.tsx` | host 一级菜单 |
| 修改 | `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx` | remote project 加 refresh icon |
| 修改 | `src/components/settings/view/tabs/remote-hosts-settings/RemoteHostsSettingsTab.tsx` | workspace rename inline edit |
| 修改 | `src/utils/api.ts` | `remoteHosts.updateWorkspace` |
| 修改 | `server/database/db.js` | `remoteWorkspacesDb.update(...)` |
| 修改 | `server/routes/remote-hosts.js` | `PATCH /workspaces/:workspaceId` |
| 新增 | `src/components/quick-launcher/QuickLauncher.tsx` | empty state launcher |
| 新增 | `src/components/quick-launcher/QuickLauncherMenu.tsx` | 共享 dropdown |
| 新增 | `src/hooks/useRecentProjects.ts` | localStorage 维护 recents |
| 修改 | `src/components/sidebar/view/subcomponents/SidebarHeader.tsx` | "+" → 触发 menu |
| 修改 | `src/components/main-content/view/subcomponents/MainContentStateView.tsx` | empty 模式渲染 QuickLauncher |

### 3.2 关键状态机

```
sidebarWidth: number  (default 288, range [240, 480])
  ←→ localStorage.sidebar-width

expandedRemoteHosts: Set<string>  (host ids)
  ←→ localStorage.expanded-remote-hosts

recentProjects: Array<{ projectName, lastSelectedAt }>  max 8
  ←→ localStorage.recent-projects
  - 写时机：handleProjectSelect (useSidebarController)
  - 读时机：QuickLauncher 展开 / SidebarHeader "+" dropdown 展开
```

### 3.3 后端 API 新增

```
PATCH /api/remote-hosts/workspaces/:workspaceId
Body: { displayName?: string }
Response: { success: true, workspace: { id, displayName, workspaceRoot, status, ... } }
```

- `displayName` 通过 `normalizeNonEmptyString(...)` 处理；null/空时把 `display_name` 设回 null（视为"清除别名"）
- 用户隔离：`WHERE user_id = ?` 检查

### 3.4 验证清单

**e2e（mocked suite）**
- 全套保持绿（54 passed）
- 新增 spec：
  - `sidebar-resize.spec.ts`：拖拽宽度 → localStorage 持久化
  - `remote-hosts-rename.spec.ts`：Settings 重命名 workspace → sidebar 立即更新
  - `quick-launcher.spec.ts`：empty state 显示 launcher + recents

**手动验证**
1. sidebar 拖拽 ✓
2. ProjectActionsMenu 不再溢出右边 ✓
3. Settings 改 workspace 名 → sidebar 同步 ✓
4. remote workspace refresh icon 只刷自己 ✓
5. remote host 一级菜单 "+" → RemoteDirectoryBrowserModal → 新 workspace 出现在该 host 下 ✓
6. empty 状态显示 QuickLauncher，Recents 与 Run On 都能正确选择 ✓

### 3.5 实施顺序（每步独立可验证）

1. **R1** ProjectActionsMenu left clamp（≈5 行改动）
2. **R6** 字号统一 + R3 single workspace refresh icon（mostly 视觉 + sidebar item 加 button）
3. **R2** sidebar width 拖拽
4. **R4** 后端 update + 前端 settings inline edit
5. **R5** Remote section 二级菜单（含 fetch hosts、host group component、expand state）
6. **R7 + R8** QuickLauncher（recents hook、Menu 组件、Empty state 嵌入、"+" 触发器）
7. mocked e2e 整套跑过

---

## 4. 非目标 / 边界

- 不重新实现 SessionLauncher 模态本身，只新增"入口"
- 不动 `runtime === 'remote_host'` 项目的 chat / shell / files panel 行为
- 不强制把 sidebar 的所有 UI 都迁移到新组件，避免不必要的回归面
- 移动端 sidebar（< md）保持现有抽屉行为，新功能仅桌面端可用
- e2e mocked 套件优先保证绿，live cloud 套件保持现有 skip 行为

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Sidebar resize 与 ScrollArea 内部布局冲突 | 仅改 outer 容器宽度（inline style），不动 ScrollArea；min/max 范围保守 |
| QuickLauncher empty state 影响现有 e2e | 现有 e2e 进入站点后都 select project，empty 路径只在 `selectedProject == null` 时；新组件留 testid 让 e2e 选择性 assert |
| Remote host fetch 与 `/api/projects` 并发，sidebar 拼合时一方未就绪 | host map 用 `Map.get(workspaceRoot)` 找不到时 fallback "Unknown host" 分组，等下次 hosts 拉回后会自动归位 |
| `ProjectActionsMenu` 改 left 计算可能影响现有 mobile 行为 | 仅在 `rect.left + width > viewport` 时切右对齐，原行为不变 |

---

## 6. 实施日志

### 6.1 已完成
| Req | 状态 | 实现位置 |
|---|---|---|
| R1 菜单 left clamp | ✅ | `src/components/sidebar/view/subcomponents/ProjectActionsMenu.tsx` (`handleToggle` 加 viewport clamp) |
| R6 字体 / 间距统一 | ✅ | `SidebarProjectList.tsx`、`SidebarProjectItem.tsx`（统一 `text-[10px]` / `text-xs`） |
| R2 Sidebar 宽度拖拽 | ✅ | 新 hook `src/hooks/useSidebarWidth.ts`、新组件 `SidebarResizeHandle.tsx`、`SidebarContent.tsx` inline width |
| R4 后端 alias | ✅ | `server/database/db.js: remoteWorkspacesDb.update`；`server/routes/remote-hosts.js: PATCH /workspaces/:id` |
| R4 前端 alias | ✅ | `src/utils/api.js: remoteHosts.updateWorkspace`；`RemoteHostsSettingsTab.tsx` inline rename |
| R3 单 workspace refresh | ✅ | `useSidebarController.refreshSingleProjectSessions`；`SidebarProjectItem` remote 项目 RefreshCw 按钮 |
| R5 Remote 二级菜单 | ✅ | `SidebarRemoteHostGroup.tsx`（一级 host）+ `SidebarRemoteHostBrowser.tsx`（一级 "+" 弹 Browse modal） + `SidebarProjectList.renderRemoteSection`；首见 host 自动展开（seen / expanded 双 set 持久化） |
| R7 Empty-state QuickLauncher | ✅ | `src/components/quick-launcher/QuickLauncher.tsx`；嵌入 `MainContentStateView`；`AppContent` 透传 projects + handlers；新 hook `useRecentProjects` + sidebar controller 写 localStorage |
| e2e | ✅ | mocked 套件 54 passed / 7 skipped / 0 failed（11.7 分钟） |

### 6.2 未实施（P1）
- **R8 左上 "+" 升级为多级菜单**：保持现状 — 点 "+" 直接打开 SessionLauncher。原因：QuickLauncher empty-state 已经覆盖等价入口（Recents / Run On / Open Folder / Set Up Workspace），未阻断主流程。后续如有需要可单独再开个 PR 接入。

### 6.3 验证
- TS：`npx tsc --noEmit` 0 errors
- Playwright mocked：`54 passed, 7 skipped (cloud-only), 0 failed`
- 手动验证：参见 §3.4 清单
