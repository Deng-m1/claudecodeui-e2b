# Agent Notes

## Full Development Stack

Use this command when you need to verify the latest frontend source and the latest backend code together:

```bash
npm run dev:full
```

This starts:

- `terminald` with `TERMINALD_PORT` or `SERVER_PORT + 1`.
- The backend with `node --watch server/index.js`.
- The Vite frontend with HMR.

Before starting, the script stops old repo-local `terminald`, backend, and Vite dev processes so stale listeners on `3111`, `3112`, or `5179` do not mask the current run.

Open the live UI at `http://localhost:5179` for the current `.env` in this repo. The backend/API runs at `http://localhost:3111`.

`dev:full` sets `CLAUDE_CODE_UI_FORCE_VITE_DEV_SERVER=1`, so backend HTML routes redirect to Vite and the existing `dist/` directory cannot hide frontend source changes.

Do not use `scripts/restart-backend.sh` or `scripts/restart-server.js` to verify frontend source changes. Those scripts only restart backend-side processes and keep `3111` on the static `dist/` path unless a fresh build exists.

For a production/static preview on `3111`, run:

```bash
npm run build
npm run server
```
