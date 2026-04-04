# E2B Cloud Agent Template

This directory contains the project-local E2B template used by the cloud runtime.

## What it installs

- Node.js 22 base image
- `git`, `git-lfs`, `gh`, `jq`, `ripgrep`, `fd`, SSH client
- Python 3 toolchain and basic build tools
- `tmux` for durable PTY/session ownership inside the sandbox
- Native `Claude Code` and native `Codex CLI`
- Playwright CLI plus Chromium for headless browser automation

The current runtime still uses `sandbox-agent/e2b` for the app's live session bridge, but the template now also installs the native `claude` and `codex` CLIs so the sandbox can be exercised and migrated toward native provider runtimes.

## Build and upload

```bash
npm run e2b:template:build
```

Optional env vars:

- `E2B_TEMPLATE_NAME`: template base name, defaults to `claudecodeui-cloud-agent`
- `E2B_TEMPLATE_TAGS`: comma-separated tags, defaults to `latest`
- `E2B_TEMPLATE_SKIP_CACHE=1`: force a clean rebuild
- Runtime resolution order: `E2B_TEMPLATE` -> `E2B_TEMPLATE_NAME` -> `claudecodeui-cloud-agent:latest`

## Smoke test

```bash
npm run e2b:template:smoke
```

This creates a sandbox from `E2B_TEMPLATE`, verifies core tools, then destroys the sandbox.

## Runtime smoke

```bash
npm run e2b:runtime:smoke
```

This runs a safer live-provider smoke against the app backend and a real E2B sandbox:

- clones a repo into E2B via `/api/e2b/sandbox/create-with-repo`
- starts a Claude session and a Codex session in the same sandbox
- has both agents touch the same temp file in the cloned workspace
- verifies the final file contents directly from the sandbox
- defaults to low-cost smoke models (`haiku` for Claude and `o4-mini` for Codex)
- aborts the sessions and destroys the sandbox by default

Prerequisites:

- the backend is already running
- `.env` contains a working `E2B_API_KEY`
- the current host has Claude and Codex auth available for E2B sync

Useful flags:

- `npm run e2b:runtime:smoke -- --help`
- `npm run e2b:runtime:smoke -- --keep-sandbox`
- `npm run e2b:runtime:smoke -- --claude-model haiku --codex-model o4-mini`
- `npm run e2b:runtime:smoke -- --repo https://github.com/owner/repo.git --branch main`
