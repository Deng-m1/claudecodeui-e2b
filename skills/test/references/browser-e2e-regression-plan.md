# Browser E2E Regression Plan

## Goal

Catch browser-side failures that backend bridge scripts will miss:

- login/auth regressions
- launcher provider selection not persisting into chat state
- repo and branch selectors not populating
- page-wide loading stalls during session bootstrap
- same-project session switching and history isolation issues
- provider startup flows that never surface status, permission UI, or assistant output

## Environment

- App URL: `E2E_APP_URL` (default `http://127.0.0.1:5179`)
- API URL: `E2E_API_URL` (default `http://127.0.0.1:3111`)
- Username: `E2E_USERNAME` (default `dbj`)
- Password: `E2E_PASSWORD` (required)
- Preferred local project match: `E2E_PROJECT_QUERY` (default `claudecodeui-e2b`)
- Provider matrix: `E2E_PROVIDERS` (default `claude,codex,cursor`)

## Suites

### `auth.spec.ts`

- Covers login form render, credential submit, token persistence, and authenticated shell render.

### `launcher.spec.ts`

- Covers session launcher opening latency.
- Covers local/cloud/project mode toggles.
- Covers provider card selection and model picker render.
- Covers GitHub repo search and branch selector population.

### `provider-smoke.spec.ts`

- Covers local `claude`, `codex`, and `cursor` startup.
- Pass condition is browser-observable activity after first prompt:
  - status card
  - permission banner
  - assistant message

### `session-flow.spec.ts`

- Covers same-project multi-session routing.
- Confirms unique session ids.
- Confirms prompt A and prompt B stay isolated after switching.

## Commands

Install browser once:

```bash
npm run test:e2e:install
```

Run full browser suite:

```bash
E2E_PASSWORD='...' bash skills/test/scripts/run_browser_suite.sh
```

Run only provider smoke:

```bash
E2E_PASSWORD='...' E2E_PROVIDERS='claude,codex,cursor' npx playwright test tests/e2e/provider-smoke.spec.ts
```

Run only current-project session routing:

```bash
E2E_PASSWORD='...' npx playwright test tests/e2e/session-flow.spec.ts
```

## Current Assertions

- `data-testid` selectors are used for auth, sidebar, launcher, messages, composer, permission UI, and loading states.
- Browser helpers wait for project-loading and main-content-loading screens to settle before continuing.
- Launcher selection is persisted to `localStorage` before dispatching the launch event, which prevents `codex/cursor` launches from silently falling back to `claude`.
