# Chat UI Issues

更新日期: 2026-04-03

## 1. 工具自动展开偏好偶发失效

状态: 已修复

现象:
- 用户已将 `autoExpandTools` 配置为 `false`。
- 在页面刷新、切换会话、或切换回来后，部分工具卡片仍会处于展开状态。
- 该现象不是稳定必现，表现为“有时候会显示”。

期望行为:
- 当 `autoExpandTools=false` 时，工具输入区应默认保持折叠。
- 刷新页面、切换项目、切换会话后，工具折叠状态应与当前偏好保持一致。

当前疑点:
- [useUiPreferences.ts](/root/work/claudecodeui-e2b/src/hooks/useUiPreferences.ts) 负责从 `localStorage` 读取和同步 `autoExpandTools`。
- [MainContent.tsx](/root/work/claudecodeui-e2b/src/components/main-content/view/MainContent.tsx#L54) 将 `autoExpandTools` 透传给聊天界面。
- [ChatMessagesPane.tsx](/root/work/claudecodeui-e2b/src/components/chat/view/subcomponents/ChatMessagesPane.tsx#L101) 为了在 prepend 历史消息时保留本地状态，刻意稳定了 message key，这可能让旧的展开状态被复用到刷新/切会话后的渲染结果。
- [MessageComponent.tsx](/root/work/claudecodeui-e2b/src/components/chat/view/subcomponents/MessageComponent.tsx#L43) 内部维护了本地 `isExpanded` 状态，并在 [MessageComponent.tsx](/root/work/claudecodeui-e2b/src/components/chat/view/subcomponents/MessageComponent.tsx#L76) 通过 `IntersectionObserver` 只做“自动展开”，没有对应的“自动收起/重置”逻辑。
- [ToolRenderer.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/ToolRenderer.tsx#L127) 中 `defaultOpen` 优先取工具配置里的 `displayConfig.defaultOpen`，只有未配置时才回退到 `autoExpandTools`。这意味着部分工具即使用户关闭了“自动展开”，仍可能因为工具配置而默认展开，需要进一步确认这是否符合产品预期。
- [CollapsibleSection.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/components/CollapsibleSection.tsx#L22) 直接将 `open` 传给原生 `<details>`，需要确认原生展开状态与 React 重新渲染、组件复用之间是否存在状态残留。

已完成修复:
- [ToolRenderer.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/ToolRenderer.tsx) 现在将 `autoExpandTools` 作为全局最高优先级，关闭时不会再让工具配置中的 `defaultOpen` 绕过该偏好。
- [CollapsibleSection.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/components/CollapsibleSection.tsx) 改成内部维护展开状态，并在偏好相关的 `resetKey` 变化时重置，避免旧展开态残留到刷新或切会话后的渲染结果。
- [MessageComponent.tsx](/root/work/claudecodeui-e2b/src/components/chat/view/subcomponents/MessageComponent.tsx) 移除了旧的 `IntersectionObserver` 自动展开副作用，避免在消息进入视口时再次把折叠区强制打开。

验证:
- 回归测试: [tool-display-state.test.ts](/root/work/claudecodeui-e2b/tests/node/tool-display-state.test.ts)

备注:
- 该问题属于前端显示状态与组件重置逻辑问题，不是后端消息数据问题。

## 2. 原始参数显示偏好偶发失效

状态: 已修复

现象:
- 用户已将 `showRawParameters` 配置为 `false`。
- 在页面刷新、切换会话、或切换回来后，部分工具仍会显示 `raw params` 区块。
- 该现象与上面的“工具自动展开”问题表现时机接近，怀疑存在共同的前端状态复用路径。

期望行为:
- 当 `showRawParameters=false` 时，工具输入区域不应显示 `raw params` 折叠块。
- 即使切换会话或刷新，原始参数的显示策略也应严格跟随当前偏好。

当前疑点:
- [useUiPreferences.ts](/root/work/claudecodeui-e2b/src/hooks/useUiPreferences.ts#L4) 负责统一读取 `showRawParameters`。
- [MainContent.tsx](/root/work/claudecodeui-e2b/src/components/main-content/view/MainContent.tsx#L54) 与 [ChatInterface.tsx](/root/work/claudecodeui-e2b/src/components/chat/view/ChatInterface.tsx#L34) 将该偏好一路透传到消息组件。
- [ToolRenderer.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/ToolRenderer.tsx#L229) 仅在 `mode === 'input'` 时将 `showRawParameters` 传给折叠展示组件。
- [CollapsibleDisplay.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/components/CollapsibleDisplay.tsx#L56) 只要 `showRawParameters && rawContent` 就会渲染 `raw params` 区块，本身没有持久化状态，说明问题更可能出在偏好值传递、组件复用、或不同消息来源切换后的渲染一致性上。

已完成修复:
- 通过同一套 `resetKey` 和折叠区状态重置逻辑，确保 `showRawParameters=false` 时，切会话与刷新不会继续复用旧的工具展示状态。
- [ToolRenderer.tsx](/root/work/claudecodeui-e2b/src/components/chat/tools/ToolRenderer.tsx) 会把 `showRawParameters` 纳入重置键，偏好变化后折叠区会按新策略重新初始化。

验证:
- 回归测试: [tool-display-state.test.ts](/root/work/claudecodeui-e2b/tests/node/tool-display-state.test.ts)

备注:
- 该问题和“工具自动展开”共享同一套前端状态链路，已一起修复。

## 3. 工具调用信息顺序错乱，集中排到后面

状态: 已定位并已修复

现象:
- 某些会话中，工具调用与工具结果不会按对话发生顺序插入。
- 页面上会出现“前面的 assistant 文本先显示，工具调用信息被集中甩到后面”的情况。

结论:
- 这是前端会话消息合并问题，不是后端历史存储顺序问题。
- 后端历史接口已经通过 `seq` 保持稳定顺序，问题发生在前端把 `serverMessages` 与 `realtimeMessages` 合并时。

已确认原因:
- 旧逻辑在 [useSessionStore.ts](/root/work/claudecodeui-e2b/src/stores/useSessionStore.ts) 中主要按 `id` 做去重。
- 当服务端历史已经包含正确顺序的工具消息，但前端 realtime 队列里还残留同一个 `toolId` 的 `tool_use` / `tool_result` 时，这些残留消息会在 merge 时被追加到末尾，形成“工具调用信息排在后面”的视觉错误。

已完成修复:
- 新的消息合并与对账逻辑已抽到 [sessionMessageMerge.ts](/root/work/claudecodeui-e2b/src/stores/sessionMessageMerge.ts)。
- 修复内容包括:
- 按 `toolId` 判断 realtime 工具消息是否已被服务端表示，而不是只按 message `id` 判断。
- 在最终 merge 阶段增加兜底，避免漏清的 realtime 工具消息再次被尾插。
- [useSessionStore.ts](/root/work/claudecodeui-e2b/src/stores/useSessionStore.ts#L13) 现在直接复用这套纯合并逻辑。

验证:
- 回归测试: [session-store-merge.test.ts](/root/work/claudecodeui-e2b/tests/node/session-store-merge.test.ts)
- 后端顺序验证: [session-history-store.test.js](/root/work/claudecodeui-e2b/tests/node/session-history-store.test.js)

备注:
- 该问题可作为后续排查会话显示异常时的已知参考案例，因为它说明“刷新/切换后显示不一致”不一定来自后端，前端 reconcile/merge 也可能是主因。
