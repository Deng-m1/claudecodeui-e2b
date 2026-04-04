import { expect, test } from '@playwright/test';
import { ensureProjectExpanded, switchToSession, waitForAuthenticatedShell } from './support/app';

const now = new Date().toISOString();
const projectName = 'local-session-flow-project';
const sessionA = 'local-session-a';
const sessionB = 'local-session-b';
const promptA = 'browser-e2e-alpha-session-history';
const promptB = 'browser-e2e-beta-session-history';

const projectPayload = {
  name: projectName,
  displayName: 'local-session-flow-project',
  path: '/tmp/local-session-flow-project',
  fullPath: '/tmp/local-session-flow-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: sessionA,
      summary: 'Alpha session',
      name: 'Alpha session',
      title: 'Alpha session',
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      messageCount: 1,
    },
    {
      id: sessionB,
      summary: 'Beta session',
      name: 'Beta session',
      title: 'Beta session',
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      messageCount: 1,
    },
  ],
  geminiSessions: [],
  e2bSessions: [],
  sessionMeta: {
    hasMore: false,
    total: 2,
  },
};

const messagePayloads = {
  [sessionA]: {
    messages: [
      {
        id: 'alpha-user-message',
        sessionId: sessionA,
        provider: 'codex',
        kind: 'text',
        role: 'user',
        content: promptA,
        timestamp: now,
      },
    ],
    total: 1,
    hasMore: false,
    offset: 0,
    limit: 20,
  },
  [sessionB]: {
    messages: [
      {
        id: 'beta-user-message',
        sessionId: sessionB,
        provider: 'codex',
        kind: 'text',
        role: 'user',
        content: promptB,
        timestamp: now,
      },
    ],
    total: 1,
    hasMore: false,
    offset: 0,
    limit: 20,
  },
};

test('same-project sessions keep separate routes and message history', async ({ page }) => {
  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [projectPayload] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split('/').at(-2) || '';
    const session = projectPayload.codexSessions.find((entry) => entry.id === sessionId);

    await route.fulfill({
      json: {
        provider: 'codex',
        project: projectPayload,
        session: {
          ...session,
          __provider: 'codex',
          __runtime: 'local',
          __projectName: projectName,
          __projectPath: projectPayload.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split('/').at(-2) || '';
    await route.fulfill({
      json: messagePayloads[sessionId as keyof typeof messagePayloads] || {
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: 20,
      },
    });
  });

  await page.goto(`/session/${sessionA}`);
  await waitForAuthenticatedShell(page);
  await expect(page.getByTestId('chat-messages-pane')).toContainText(promptA);

  await ensureProjectExpanded(page, projectName);
  await switchToSession(page, sessionB, projectName);
  await expect(page.getByTestId('chat-messages-pane')).toContainText(promptB);
  await expect(page.getByTestId('chat-messages-pane')).not.toContainText(promptA);

  await switchToSession(page, sessionA, projectName);
  await expect(page.getByTestId('chat-messages-pane')).toContainText(promptA);
  await expect(page.getByTestId('chat-messages-pane')).not.toContainText(promptB);
});
