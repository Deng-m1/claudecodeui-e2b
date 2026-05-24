import { expect, test } from '@playwright/test';
import {
  clearOutboundSocketMessages,
  ensureProjectExpanded,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForLastOutboundSocketMessage,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();

const buildRemoteProject = () => ({
  name: 'remote__runtime-regression-workspace',
  displayName: 'fanqie-reader',
  path: '/root/work/fanqie-reader',
  fullPath: '/root/work/fanqie-reader',
  kind: 'remote',
  runtime: 'remote_host',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: 'remote-existing-codex-session',
      summary: 'Remote Existing Codex Session',
      name: 'Remote Existing Codex Session',
      title: 'Remote Existing Codex Session',
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      messageCount: 79,
      provider: 'codex',
      runtime: 'remote_host',
      cwd: '/root/work/fanqie-reader',
    },
  ],
  geminiSessions: [],
  e2bSessions: [],
  sessionMeta: {
    total: 1,
    hasMore: false,
    byProvider: {
      claude: { total: 0, hasMore: false },
      cursor: { total: 0, hasMore: false },
      codex: { total: 1, hasMore: false },
      gemini: { total: 0, hasMore: false },
    },
  },
  remote: {
    hostId: 'remote-host-runtime-regression',
    workspaceId: 'runtime-regression-workspace',
    label: 'remote-runtime-regression-host',
    host: '36.137.182.237',
    port: 22,
    username: 'root',
    status: 'online',
    workspaceRoot: '/root/work/fanqie-reader',
  },
});

test('remote discovered sessions keep remote_host runtime metadata in sidebar and resume', async ({ page }) => {
  const remoteProject = buildRemoteProject();

  await installWebSocketTestBridge(page, { passthrough: false });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [remoteProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: remoteProject,
        session: {
          ...remoteProject.codexSessions[0],
          __provider: 'codex',
          __projectName: remoteProject.name,
          __projectPath: remoteProject.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    await route.fulfill({
      json: {
        messages: [
          {
            id: 'remote-history-assistant-1',
            sessionId: 'remote-existing-codex-session',
            provider: 'codex',
            kind: 'text',
            role: 'assistant',
            content: 'remote-history-loaded',
            timestamp: now,
          },
        ],
        total: 1,
        hasMore: false,
        offset: 0,
        limit: 20,
      },
    });
  });

  await page.goto('/');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  const remoteSection = page.getByTestId('sidebar-project-section-remote');
  await expect(remoteSection).toBeVisible();

  const remoteProjectCard = page.locator(
    `[data-testid="sidebar-project-item"][data-project-name="${remoteProject.name}"]:visible`,
  ).first();
  await expect(remoteProjectCard).toContainText('1');
  await expect(remoteProjectCard).not.toContainText('0');

  await ensureProjectExpanded(page, remoteProject.name);
  await page.locator(
    '[data-testid="sidebar-session-item"][data-session-id="remote-existing-codex-session"]:visible',
  ).first().click();

  await expect(page).toHaveURL(/\/session\/remote-existing-codex-session$/);
  await expect(page.getByText('remote-history-loaded')).toBeVisible();

  await clearOutboundSocketMessages(page);

  await page.getByTestId('chat-composer-textarea').fill('resume-remote-host-runtime');
  await expect(page.getByTestId('chat-composer-submit')).toBeEnabled();
  await page.getByTestId('chat-composer-submit').click();

  const command = await waitForLastOutboundSocketMessage(page, { type: 'codex-command' });
  expect(command?.parsed?.type).toBe('codex-command');
  expect(command?.parsed?.sessionId).toBe('remote-existing-codex-session');
  expect(command?.parsed?.options?.runtimeMode).toBe('remote_host');
  expect(command?.parsed?.options?.projectPath).toBe('/root/work/fanqie-reader');
});
