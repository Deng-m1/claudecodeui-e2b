# Durable Project Terminal Architecture

## Goal

Build a project-bound terminal system that behaves more like Termius/Tabby than the current plugin fallback:

1. Terminal ownership is tied to a project workspace, not an AI chat session.
2. Terminal processes survive browser disconnects and web-app restarts.
3. Local and cloud runtimes use one product model and one frontend interaction model.
4. The implementation reuses mature open-source components instead of building a PTY stack from scratch.
5. The UX supports persistent tabs, reconnect, split or multiple terminals per project, command awareness, and low-friction status feedback.

This document is intentionally implementation-facing. It proposes a concrete architecture that can be added beside the existing app and then progressively replace the current `/shell` and `web-terminal` fallback paths.

## Problem Summary

The current codebase has two different terminal implementations, and neither satisfies the durable project-terminal requirement.

### Current `web-terminal` plugin path

- Frontend plugin code opens `location.host + /plugin-ws/web-terminal` directly.
- The plugin backend path is handled in `server/index.js` by `handlePluginWsProxy()`.
- For `web-terminal`, that path currently delegates to `handleWebTerminalFallbackConnection()`.
- The fallback spawns a PTY with `cwd = HOME`, not the project root.
- The fallback kills the PTY as soon as the websocket closes.

Result:

- It is not project-bound.
- It is not durable.
- It cannot survive a web-app restart.
- It is weaker than the built-in `/shell` implementation.

### Current `/shell` path

- The built-in shell websocket uses `node-pty` inside the app server process.
- It keys sessions by `projectPath + sessionId + commandSuffix`.
- It can reconnect to an in-memory PTY for up to 30 minutes after websocket disconnect.
- It still depends on the main app process and in-memory state.

Result:

- It is closer to project-binding, but still partially coupled to chat session semantics.
- It is not process-independent from the main app.
- It still dies when the main app process dies.

## Product Requirements

The target product model is:

- A project has zero or more terminal tabs.
- Each terminal tab belongs to a project and runtime target.
- Closing the browser does not kill the terminal.
- Restarting the main web server does not kill the terminal.
- Reopening the project shows existing terminals and lets the user reconnect.
- The terminal surface supports multi-tab, resize, copy/paste, reconnect, search, scrollback, and command state.
- Local projects and E2B projects feel the same in the UI.

Nice-to-have features that should be designed for from day one:

- Split panes.
- Named terminals per project.
- Session status badges such as running, disconnected, exited, sandbox paused.
- Command timeline with current command, last exit code, and duration.
- Read-only share links or collaborative viewing in a later phase.

## Constraints

- Do not build a custom PTY implementation from scratch.
- Do not build a custom terminal emulator from scratch.
- Minimize long-term divergence from mature upstream projects.
- Keep the frontend embedded in the current app rather than replacing the whole UI.
- Support both host-local workspaces and cloud runtimes such as E2B.

## Open-Source Options Survey

The architecture should reuse existing open-source building blocks. The key projects worth considering are:

| Component | What it is good at | What it is not good at | Fit for this project |
| --- | --- | --- | --- |
| `tmux` | Durable shell/session persistence, detach/reattach, server-process lifetime independent of browser | No browser UI by itself | Essential core building block |
| `ttyd` | Mature browser terminal transport for an existing command/process, lightweight websocket bridge | No project registry, no product workflow, no command-level metadata | Strong transport/data-plane reuse |
| `Wetty` | Browser terminal over SSH or shell using Node + xterm.js | More SSH/login oriented than project-terminal oriented | Useful reference, not best core |
| `WebSSH2` | Browser SSH client with xterm.js and auth patterns | SSH-centric, not project-workspace-centric | Good if everything is remote over SSH, weaker for local/E2B mix |
| `Tabby connection gateway` | Separate gateway/backend pattern for terminal connections | Not a project-terminal product by itself | Strong architectural reference |
| `sshx` | Excellent collaborative sharing UX | Self-hosted deployment is not the right fit for this product foundation | Not recommended as the core |

### Official references

- `tmux`: https://github.com/tmux/tmux
- `ttyd`: https://github.com/tsl0922/ttyd
- `Wetty`: https://github.com/butlerx/wetty
- `WebSSH2`: https://github.com/billchurch/webssh2
- `Tabby connection gateway`: https://github.com/Eugeny/tabby-connection-gateway
- `sshx`: https://github.com/ekzhang/sshx

## Recommended Architecture

### Decision

Adopt this stack:

1. `tmux` as the durable terminal/session substrate.
2. `ttyd` as the browser terminal transport/data plane.
3. A new standalone backend service called `terminald` as the control plane.
4. Keep the current React app frontend, but replace the existing plugin transport with a `terminald`-backed project terminal UI.

This gives us:

- durable terminals without inventing PTY persistence,
- a proven browser terminal transport,
- a clean separation between app lifecycle and terminal lifecycle,
- a unified model for local and E2B runtimes.

### Why not fork the whole Tabby Web product?

Tabby has a strong product feel and a separate gateway pattern worth copying, but a full fork is the wrong level of reuse here:

- It introduces an entire second terminal product surface with its own configuration model.
- It is connection-centric rather than project-workspace-centric.
- It complicates auth, routing, and frontend embedding more than we need.
- It does not directly solve local project binding and E2B workspace mapping.

The correct reuse from Tabby is the architecture pattern, not a wholesale UI adoption.

### Why not use only `Wetty` or `WebSSH2`?

They are fine when the product model is "open a shell on a host over SSH." That is not the main problem here. The main problem is "durable project terminals across multiple runtime targets." They are transport solutions, not the right control-plane model.

## High-Level Design

### Services

Introduce one new service:

- `terminald`: standalone backend responsible for terminal lifecycle, metadata, runtime adapters, auth validation, reverse proxying, and reconnect.

The existing app server remains responsible for:

- user auth and UI session auth,
- project discovery and metadata,
- file/git/chat features,
- issuing signed terminal tickets or forwarding user auth to `terminald`.

### Runtime topology

The system has one control plane and two data-plane flavors.

#### Local projects

- `terminald` runs on the host.
- `terminald` ensures a `tmux` session exists for a project terminal.
- `terminald` starts or reuses a `ttyd` instance that attaches to that `tmux` target.
- The browser connects to `terminald`, not directly to the main app websocket.

#### E2B projects

- `terminald` still acts as the control plane.
- Inside each sandbox, a lightweight terminal sidecar runs `tmux` plus `ttyd`.
- `terminald` ensures the sidecar exists, then reverse proxies browser traffic to the sandbox-side `ttyd`.

This keeps the frontend identical while changing only the runtime adapter behind a terminal handle.

## Terminal Identity Model

Stop binding terminals to AI conversation sessions.

The primary identity should be:

```ts
type TerminalRuntime = 'local' | 'e2b';

type TerminalHandle = {
  id: string;
  userId: number;
  projectId: string;
  runtime: TerminalRuntime;
  workspaceRoot: string;
  sandboxId?: string | null;
  terminalName: string;
};
```

Rules:

- `projectId` is stable across tabs and browser reconnect.
- A project can have many terminals.
- An AI session can optionally reference a terminal, but never owns it.
- Terminal tabs remain visible even when there is no active AI chat session.

## `terminald` Responsibilities

### Control-plane API

`terminald` should expose a narrow, stable API:

- `POST /api/terminals/open`
- `GET /api/terminals?projectId=...`
- `POST /api/terminals/:id/reconnect-ticket`
- `POST /api/terminals/:id/rename`
- `POST /api/terminals/:id/resize-defaults`
- `POST /api/terminals/:id/close`
- `GET /api/terminals/:id/events`
- `WS /ws/terminals/:id`

The websocket path is for the terminal byte stream and lightweight control messages only.

### Metadata store

`terminald` needs a small persistent store. SQLite is enough for the first version.

Suggested schema:

```sql
CREATE TABLE terminals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  sandbox_id TEXT,
  tmux_session_name TEXT NOT NULL,
  ttyd_port INTEGER,
  status TEXT NOT NULL,
  terminal_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  shell TEXT,
  cwd TEXT,
  metadata_json TEXT
);

CREATE UNIQUE INDEX terminals_project_name_idx
ON terminals (user_id, project_id, terminal_name);
```

### Runtime adapters

`terminald` should have a runtime adapter layer:

- `localRuntimeAdapter`
- `e2bRuntimeAdapter`

Each adapter must implement:

```ts
type RuntimeTerminalAdapter = {
  resolveWorkspace(handle): Promise<{ cwd: string }>;
  ensureTmuxSession(handle): Promise<{ tmuxSessionName: string }>;
  ensureTransport(handle): Promise<{ proxyTarget: string }>;
  getStatus(handle): Promise<TerminalStatus>;
  close(handle): Promise<void>;
};
```

## Local Runtime Design

### Persistence model

- One `tmux` session per terminal tab.
- `tmux` session naming pattern:

```txt
ccui_<userId>_<projectSlug>_<terminalId>
```

- `ttyd` command attaches to that session:

```bash
ttyd --writable --port <port> tmux attach -t <session>
```

If the session does not exist yet:

```bash
tmux new-session -d -s <session> -c <projectRoot>
```

This is the crucial durability boundary:

- browser disconnect does not kill `tmux`,
- `terminald` restart can rediscover the `tmux` session and restart `ttyd`,
- main app restart does not affect `tmux` at all.

### Command observability

Byte-stream-only terminals are not enough for a polished product. Add shell integration.

Approach:

- inject a shell profile snippet for bash/zsh/fish,
- emit command lifecycle markers using OSC or structured sentinel lines,
- parse them in `terminald` and store command events.

The model should include:

```ts
type TerminalCommandEvent = {
  terminalId: string;
  commandId: string;
  cwd: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
};
```

This enables a Termius-like UX:

- current command badge,
- last command duration,
- command history list,
- failed command highlighting,
- reconnect without losing command context.

## E2B Runtime Design

### Problem

E2B terminals cannot be modeled as host PTYs. We need the same product behavior with a different execution environment.

### Recommended approach

Inside each sandbox, run a lightweight sidecar that provides:

- `tmux`
- `ttyd`
- a small bootstrap script to ensure the sidecar is running

`terminald` does not need to implement PTY handling for the sandbox. It only needs to:

1. resolve sandbox identity,
2. ensure the terminal sidecar is installed/running,
3. create or reuse a `tmux` session inside the sandbox,
4. proxy websocket traffic to the sandbox-local `ttyd` endpoint.

### Why this is better than directly streaming E2B process I/O

- It keeps local and cloud terminals on the same mental model.
- It gives real detach/reattach behavior.
- It avoids building a custom terminal multiplexing protocol over E2B APIs.
- It makes sandbox pause/resume a lifecycle event `terminald` can handle explicitly.

### Sandbox bootstrap

The E2B template should ship a small bootstrap package such as:

- `/opt/ccui-terminal/bootstrap.sh`
- `/opt/ccui-terminal/ensure-terminald.sh`

The bootstrap ensures:

- `tmux` installed,
- `ttyd` installed,
- per-project `tmux` sessions created on demand,
- one stable localhost port exposed for the sandbox-side terminal transport.

## Frontend Design

### Keep the current app shell

Do not replace the whole frontend with another terminal product.

Instead:

- keep the current main app layout,
- replace the current plugin/fallback terminal transport,
- keep `xterm.js` as the embedded terminal renderer,
- add project-terminal state and a small project-terminal API client.

### Product interaction model

The frontend should feel closer to Termius/Tabby while still fitting this app.

Recommended UX:

- A project-level terminal area, not session-level.
- Multiple tabs per project with rename support.
- New terminal button anchored to the project header.
- Connection badges such as `Connected`, `Reconnecting`, `Exited`, `Sandbox paused`.
- Current cwd breadcrumb.
- Current command chip when shell integration is present.
- Search in scrollback.
- Quick actions: copy, clear, reconnect, kill, duplicate tab.
- Sticky reconnect toast instead of a blank `Connecting` overlay.

### Suggested component model

```ts
ProjectTerminalPanel
ProjectTerminalTabs
ProjectTerminalViewport
ProjectTerminalStatusBar
ProjectTerminalCommandBar
ProjectTerminalReconnectToast
```

### State model

```ts
type ProjectTerminalState = {
  terminalsByProject: Record<string, TerminalSummary[]>;
  activeTerminalIdByProject: Record<string, string | null>;
  connectionStateByTerminal: Record<string, 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited'>;
  latestCommandByTerminal: Record<string, TerminalCommandEvent | null>;
};
```

## Security Model

- The browser never connects directly to arbitrary `ttyd` ports.
- All browser terminal traffic goes through `terminald` websocket endpoints.
- `terminald` validates app-issued user identity or short-lived signed tickets.
- `terminald` only exposes terminals owned by the authenticated user.
- Local project root and E2B sandbox identity are resolved server-side, never trusted from raw frontend input.

## Integration with the Current Codebase

### Keep for now

- `xterm.js` based terminal rendering.
- the existing shell tab layout and mobile/desktop placement.
- runtime capability abstraction work already started in `docs/RUNTIME_CAPABILITY_ABSTRACTION.md`.

### Replace

- `web-terminal` plugin fallback transport.
- direct app-process `node-pty` ownership for durable project terminals.
- session-bound shell semantics in the main product flow.

### Transitional compatibility

Phase 1 should keep the current `/shell` feature as a fallback for agent-session terminals while introducing the new project-terminal system separately.

That means:

- `Shell` can remain for agent-centric workflows.
- a new `ProjectTerminal` tab can be introduced beside it,
- then `/shell` can later be narrowed to agent-session recovery and auth flows only.

## Rollout Plan

### Phase 0: Immediate fixes

- Add `/plugin-ws` websocket proxy to Vite dev server.
- Stop gating plugin terminal visibility behind unrelated shell capability logic.
- Document that current `web-terminal` fallback is not durable by design.

### Phase 1: Standalone `terminald` for local projects

- Build `terminald` with SQLite metadata.
- Implement local runtime adapter.
- Use `tmux` + `ttyd` per terminal.
- Add frontend project-terminal tab using `xterm.js`.
- Store terminal list per project.

### Phase 2: Shell integration and UX parity

- Add command lifecycle markers.
- Add status bar and command chip.
- Add reconnect history and exit-state handling.
- Add terminal rename, duplicate, and clear actions.

### Phase 3: E2B runtime support

- Add sandbox-side bootstrap package.
- Implement E2B runtime adapter in `terminald`.
- Proxy browser traffic through `terminald` to sandbox-side `ttyd`.
- Add sandbox-specific states such as paused or disconnected.

### Phase 4: Advanced UX

- Split panes.
- Optional read-only sharing.
- Optional collaborative mode.
- Saved commands or snippets.

## Recommended Repository Layout

Suggested new layout:

```txt
terminald/
  src/
    index.ts
    api/
    auth/
    db/
    runtime/
      local/
      e2b/
    tmux/
    ttyd/
    proxy/
    shell-integration/
  package.json

e2b-template/
  terminal/
    bootstrap.sh
    ensure-terminal.sh

src/components/project-terminal/
  view/
  hooks/
  context/
  utils/
```

## Risks and Tradeoffs

### `ttyd` process-per-terminal overhead

This is acceptable for the first version because it drastically reduces custom transport work. If the number of terminals grows large, we can later move to a shared proxy model while still keeping `tmux` as the persistence core.

### Cross-platform behavior

`tmux` is best on Linux and macOS. Windows host support may need a separate path, likely PowerShell + OpenSSH + WSL, or a Windows-specific durable terminal adapter. The first production target should be Linux.

### E2B template ownership

Cloud durability requires sandbox bootstrap ownership. That is unavoidable. The benefit is that once the sandbox template includes `tmux` + `ttyd`, cloud terminals become far simpler and more reliable.

## Final Recommendation

Do not continue investing in the current `web-terminal` fallback as the primary terminal architecture.

Instead:

1. keep the current frontend shell surface,
2. add a standalone `terminald`,
3. use `tmux` for durable sessions,
4. use `ttyd` for browser terminal transport,
5. use runtime adapters so local and E2B share one product model,
6. add shell integration for command-aware UX.

This is the smallest design that meets all three hard requirements:

- project-bound terminals,
- terminal processes independent of the main app process,
- a product experience that can realistically grow toward Termius/Tabby quality.

## References

- Current plugin-based websocket entry: `server/index.js`
- Current plugin fallback implementation: `server/utils/web-terminal-fallback.js`
- Current host PTY reconnect path: `server/index.js`
- Runtime capability direction: `docs/RUNTIME_CAPABILITY_ABSTRACTION.md`
- Official tmux repository: https://github.com/tmux/tmux
- Official ttyd repository: https://github.com/tsl0922/ttyd
- Official Wetty repository: https://github.com/butlerx/wetty
- Official WebSSH2 repository: https://github.com/billchurch/webssh2
- Official Tabby connection gateway repository: https://github.com/Eugeny/tabby-connection-gateway
- Official sshx repository: https://github.com/ekzhang/sshx
