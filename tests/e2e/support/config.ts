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
