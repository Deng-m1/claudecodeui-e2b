// Default to the Vite dev port (5179). When another instance already binds
// that port Vite walks up to 5180/5181; CI/dev should pass `E2E_APP_URL` to
// match, but the default keeps the historical behaviour for fresh checkouts.
const DEFAULT_APP_URL = 'http://127.0.0.1:5179';
const DEFAULT_API_URL = 'http://127.0.0.1:3111';

export const appUrl = process.env.E2E_APP_URL || DEFAULT_APP_URL;
export const apiUrl = process.env.E2E_API_URL || DEFAULT_API_URL;
export const appOrigin = new URL(appUrl).origin;
export const e2eUsername = process.env.E2E_USERNAME || 'dbj';
export const preferredProjectQuery = process.env.E2E_PROJECT_QUERY || 'claudecodeui-e2b';

export function getE2EPassword(): string {
  const password = process.env.E2E_PASSWORD;
  if (!password) {
    throw new Error('E2E_PASSWORD is required to run browser tests.');
  }
  return password;
}

export function getProviderMatrix(): string[] {
  const raw = process.env.E2E_PROVIDERS?.trim();
  if (!raw) {
    return ['claude', 'codex', 'cursor'];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// `e2b-*` and `codex-cloud-*` spec files spawn real cloud sandboxes (E2B +
// Codex/Claude) and consume real model credits per run. They sit behind an
// opt-in flag so the default Playwright run stays fully hermetic. Set
// `E2E_LIVE_CLOUD=1` (or `true`/`yes`) to enable them in CI/dev environments
// that have the necessary auth + sandbox quota configured.
export function isLiveCloudE2EEnabled(): boolean {
  const raw = process.env.E2E_LIVE_CLOUD?.trim().toLowerCase();
  if (!raw) {
    return false;
  }

  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// Tests that spin up real E2B sandboxes and call live Codex/Claude models can
// each consume 10–15 minutes of CI time and require working cloud credentials,
// so we keep them opt-in. Set `E2E_LIVE_CLOUD=1` (or pass a CSV in
// `E2E_LIVE_CLOUD`, e.g. `e2b,codex-cloud`) to enable a specific tag, or `=all`
// to enable every live-cloud suite at once. When the gate is closed we tell
// Playwright to skip the suite rather than letting it hit a 10-minute timeout.
export function isLiveCloudEnabled(tag?: string): boolean {
  const raw = process.env.E2E_LIVE_CLOUD?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'all' || raw === 'yes') return true;
  if (!tag) return true;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(tag.toLowerCase());
}

export type RemoteHostE2EConfig = {
  label: string;
  host: string;
  port: string;
  username: string;
  password: string;
  workspaceRoot: string;
};

export function getRemoteHostE2EConfig(): RemoteHostE2EConfig | null {
  const host = process.env.REMOTE_HOST_E2E_HOST?.trim();
  const username = process.env.REMOTE_HOST_E2E_USERNAME?.trim();
  const password = process.env.REMOTE_HOST_E2E_PASSWORD?.trim();

  if (!host || !username || !password) {
    return null;
  }

  return {
    label: process.env.REMOTE_HOST_E2E_LABEL?.trim() || `playwright-remote-host-${Date.now()}`,
    host,
    port: process.env.REMOTE_HOST_E2E_PORT?.trim() || '22',
    username,
    password,
    workspaceRoot: process.env.REMOTE_HOST_E2E_WORKSPACE_ROOT?.trim() || '/root',
  };
}
