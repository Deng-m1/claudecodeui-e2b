import { expect, test } from '@playwright/test';
import {
  ensureProjectExpanded,
  injectSocketMessage,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();

async function mockAuthApis(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      json: {
        registrationDisabled: false,
        setupLocked: false,
        needsSetup: false,
      },
    });
  });

  await page.route('**/api/auth/user', async (route) => {
    await route.fulfill({
      json: {
        user: {
          username: 'dbj',
        },
      },
    });
  });

  await page.route('**/api/user/onboarding-status', async (route) => {
    await route.fulfill({
      json: {
        hasCompletedOnboarding: true,
      },
    });
  });
}

const buildLocalProject = (sessionIds: Array<string | Record<string, unknown>>) => ({
  name: 'local-history-race-project',
  displayName: 'local-history-race-project',
  path: '/tmp/local-history-race-project',
  fullPath: '/tmp/local-history-race-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: sessionIds.map((entry) => {
    const session = typeof entry === 'string' ? { id: entry } : entry;
    const id = String(session.id || '');

    return {
      ...session,
      id,
      summary: String(session.summary || id),
      name: String(session.name || id),
      title: String(session.title || id),
      createdAt: String(session.createdAt || now),
      created_at: String(session.created_at || now),
      updated_at: String(session.updated_at || now),
      lastActivity: String(session.lastActivity || now),
      messageCount: Number(session.messageCount || 1),
    };
  }),
  geminiSessions: [],
  e2bSessions: [],
  sessionMeta: {
    hasMore: false,
    total: sessionIds.length,
  },
});

const buildCloudProject = (sessionIds: string[]) => ({
  name: 'e2b__e2b/cloud-history-race-project',
  displayName: 'cloud-history-race-project',
  path: '/home/user/cloud-history-race-project',
  fullPath: '/home/user/cloud-history-race-project',
  kind: 'cloud',
  runtime: 'e2b',
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: sessionIds.map((id) => ({
    id,
    summary: id,
    name: id,
    title: id,
    createdAt: now,
    created_at: now,
    updated_at: now,
    lastActivity: now,
    provider: 'codex',
    agent: 'codex',
    runtime: 'e2b',
    messageCount: 1,
  })),
  sessionMeta: {
    hasMore: false,
    total: sessionIds.length,
  },
  cloud: {
    sandboxId: 'e2b/cloud-history-race-project',
    status: 'running',
    repoUrl: 'https://github.com/test-owner/cloud-history-race-project.git',
    branch: 'main',
    workspacePath: '/home/user/cloud-history-race-project',
    createdAt: now,
    lastActivity: now,
  },
});

const buildBootstrapPayload = (
  project: ReturnType<typeof buildLocalProject> | ReturnType<typeof buildCloudProject>,
  sessionId: string,
) => {
  const isCloud = project.runtime === 'e2b';
  const session =
    project.codexSessions.find((item) => item.id === sessionId) ||
    project.e2bSessions.find((item) => item.id === sessionId) || {
      id: sessionId,
      summary: sessionId,
      name: sessionId,
      title: sessionId,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
    };

  return {
    provider: isCloud ? 'e2b' : 'codex',
    project,
    session: {
      ...session,
      __provider: 'codex',
      __runtime: isCloud ? 'e2b' : 'local',
      __projectName: project.name,
      __projectPath: project.fullPath,
    },
  };
};

const buildHistoryPayload = (
  sessionId: string,
  content: string,
  provider: 'codex' | 'e2b' = 'codex',
) => ({
  messages: [
    {
      id: `${sessionId}-message`,
      sessionId,
      timestamp: now,
      provider,
      kind: 'text',
      role: 'assistant',
      content,
    },
  ],
  total: 1,
  hasMore: false,
  offset: 0,
  limit: 20,
});

test.describe('session history races', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthApis(page);
  });

  test('local session switch keeps the loading state until the target session history arrives', async ({ page }) => {
    const sessionA = 'local-codex-session-a';
    const sessionB = 'local-codex-session-b';
    const project = buildLocalProject([sessionA, sessionB]);

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [project] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || sessionA;
      await route.fulfill({ json: buildBootstrapPayload(project, decodeURIComponent(sessionId)) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/messages')[0] || sessionA,
      );

      if (sessionId === sessionA) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ json: buildHistoryPayload(sessionA, 'older local session message') });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ json: buildHistoryPayload(sessionB, 'newest local session message') });
    });

    await page.goto(`/session/${sessionA}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toBeVisible();

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionB}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionB}$`));

    await page.waitForTimeout(300);
    await expect(page.getByTestId('chat-messages-pane')).toContainText(/Loading session messages|加载会话消息/);
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('older local session message');
    await expect(page.getByTestId('chat-messages-pane')).toContainText('newest local session message', {
      timeout: 3_000,
    });
  });

  test('session route hydration preserves the selected local Codex session while surfacing a newer fork session', async ({ page }) => {
    const oldSession = 'local-codex-session-original';
    const forkSession = 'local-codex-session-fork';
    const bootstrapProject = buildLocalProject([{ id: oldSession, forkChildCount: 1 }]);
    const hydratedProject = buildLocalProject([
      { id: oldSession, forkChildCount: 1 },
      { id: forkSession, forkedFromId: oldSession },
    ]);
    hydratedProject.sessionMeta = {
      hasMore: false,
      total: 2,
      byProvider: {
        claude: { total: 0, hasMore: false },
        cursor: { total: 0, hasMore: false },
        codex: { total: 2, hasMore: false },
        gemini: { total: 0, hasMore: false },
      },
    };

    await installWebSocketTestBridge(page, { passthrough: false });

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [hydratedProject] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/projects/*/sessions*', async (route) => {
      await route.fulfill({
        json: {
          sessions: hydratedProject.codexSessions,
          total: 2,
          hasMore: false,
        },
      });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || oldSession;
      await route.fulfill({ json: buildBootstrapPayload(bootstrapProject, decodeURIComponent(sessionId)) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/messages')[0] || oldSession,
      );

      if (sessionId === oldSession) {
        await route.fulfill({ json: buildHistoryPayload(oldSession, 'original codex session message') });
        return;
      }

      await route.fulfill({ json: buildHistoryPayload(forkSession, 'fork codex session message') });
    });

    await page.goto(`/session/${oldSession}`);
    await waitForWebSocketTestBridge(page);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('original codex session message');

    await expect(
      page.locator(`[data-testid="sidebar-session-item"][data-session-id="${oldSession}"]:visible`).first(),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="sidebar-session-item"][data-session-id="${forkSession}"]:visible`).first(),
    ).toBeVisible({ timeout: 4_000 });
    await expect(
      page.locator(`[data-testid="sidebar-session-item"][data-session-id="${oldSession}"]:visible`).first(),
    ).toContainText(/1 fork/i);
    await expect(
      page.locator(`[data-testid="sidebar-session-item"][data-session-id="${forkSession}"]:visible`).first(),
    ).toContainText(/Fork/i);
    await expect(page.getByText(/Has 1 fork/i)).toBeVisible();

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${forkSession}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${forkSession}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('fork codex session message', {
      timeout: 3_000,
    });
    await expect(page.getByText(/Forked from local-co/i)).toBeVisible();
  });

  test('cloud session switch keeps the loading state until the target session history arrives', async ({ page }) => {
    const sessionA = 'cloud-codex-session-a';
    const sessionB = 'cloud-codex-session-b';
    const project = buildCloudProject([sessionA, sessionB]);

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [project] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || sessionA;
      await route.fulfill({ json: buildBootstrapPayload(project, decodeURIComponent(sessionId)) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/messages')[0] || sessionA,
      );

      if (sessionId === sessionA) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ json: buildHistoryPayload(sessionA, 'older cloud session message', 'e2b') });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ json: buildHistoryPayload(sessionB, 'newest cloud session message', 'e2b') });
    });

    await page.goto(`/session/${sessionA}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toBeVisible();

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionB}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionB}$`));

    await page.waitForTimeout(300);
    await expect(page.getByTestId('chat-messages-pane')).toContainText(/Loading session messages|加载会话消息/);
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('older cloud session message');
    await expect(page.getByTestId('chat-messages-pane')).toContainText('newest cloud session message', {
      timeout: 3_000,
    });
  });

  test('local new-session event burst only triggers one silent project refresh and preserves expansion state', async ({
    page,
  }) => {
    const initialSessionId = 'local-codex-session-a';
    const tempSessionId = 'temp-local-session';
    const finalSessionId = 'final-local-session';
    const initialProject = buildLocalProject([initialSessionId]);
    const projectAfterCreate = buildLocalProject([initialSessionId, tempSessionId, finalSessionId]);
    let projectsRequestCount = 0;

    await installWebSocketTestBridge(page, { passthrough: false });

    await page.route('**/api/projects', async (route) => {
      projectsRequestCount += 1;
      await route.fulfill({ json: [projectAfterCreate] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || initialSessionId,
      );
      const project = sessionId === initialSessionId ? initialProject : projectAfterCreate;
      await route.fulfill({ json: buildBootstrapPayload(project, sessionId) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      await route.fulfill({
        json: {
          messages: [],
          total: 0,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
    });

    await page.goto(`/session/${initialSessionId}`);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await ensureProjectExpanded(page, initialProject.name);
    projectsRequestCount = 0;

    await injectSocketMessage(page, {
      kind: 'session_created',
      provider: 'codex',
      sessionId: tempSessionId,
      newSessionId: tempSessionId,
    });

    await expect(page).toHaveURL(new RegExp(`/session/${tempSessionId}$`));

    await injectSocketMessage(page, {
      kind: 'complete',
      provider: 'codex',
      sessionId: tempSessionId,
      actualSessionId: finalSessionId,
      exitCode: 0,
    });

    await expect(page).toHaveURL(new RegExp(`/session/${finalSessionId}$`));
    await expect
      .poll(() => projectsRequestCount, { timeout: 2_000 })
      .toBe(1);

    await expect(
      page.locator(`[data-testid="project-new-session"][data-project-name="${initialProject.name}"]:visible`).first(),
    ).toBeVisible();
  });

  test('cloud new-session event burst only triggers one silent project refresh and preserves expansion state', async ({
    page,
  }) => {
    const initialSessionId = 'cloud-codex-session-a';
    const tempSessionId = 'temp-cloud-session';
    const finalSessionId = 'final-cloud-session';
    const initialProject = buildCloudProject([initialSessionId]);
    const projectAfterCreate = buildCloudProject([initialSessionId, tempSessionId, finalSessionId]);
    let projectsRequestCount = 0;

    await installWebSocketTestBridge(page, { passthrough: false });

    await page.route('**/api/projects', async (route) => {
      projectsRequestCount += 1;
      await route.fulfill({ json: [projectAfterCreate] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || initialSessionId,
      );
      const project = sessionId === initialSessionId ? initialProject : projectAfterCreate;
      await route.fulfill({ json: buildBootstrapPayload(project, sessionId) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      await route.fulfill({
        json: {
          messages: [],
          total: 0,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
    });

    await page.goto(`/session/${initialSessionId}`);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await ensureProjectExpanded(page, initialProject.name);
    projectsRequestCount = 0;

    await injectSocketMessage(page, {
      kind: 'session_created',
      provider: 'codex',
      sessionId: tempSessionId,
      newSessionId: tempSessionId,
    });

    await expect(page).toHaveURL(new RegExp(`/session/${tempSessionId}$`));

    await injectSocketMessage(page, {
      kind: 'complete',
      provider: 'codex',
      sessionId: tempSessionId,
      actualSessionId: finalSessionId,
      exitCode: 0,
    });

    await expect(page).toHaveURL(new RegExp(`/session/${finalSessionId}$`));
    await expect
      .poll(() => projectsRequestCount, { timeout: 2_000 })
      .toBe(1);

    await expect(
      page.locator(`[data-testid="project-new-session"][data-project-name="${initialProject.name}"]:visible`).first(),
    ).toBeVisible();
  });

  test('local session keeps later conversation history across switch-back and reload', async ({ page }) => {
    const sessionA = 'local-history-session-a';
    const sessionB = 'local-history-session-b';
    const project = buildLocalProject([sessionA, sessionB]);
    const persistedMessages: Record<string, unknown[]> = {
      [sessionA]: [
        {
          id: `${sessionA}-user-1`,
          sessionId: sessionA,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'user',
          content: 'LOCAL_RESTORE_USER_1',
        },
        {
          id: `${sessionA}-assistant-1`,
          sessionId: sessionA,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'assistant',
          content: 'LOCAL_RESTORE_REPLY_1',
        },
      ],
      [sessionB]: [
        {
          id: `${sessionB}-assistant-1`,
          sessionId: sessionB,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'assistant',
          content: 'LOCAL_OTHER_SESSION_REPLY',
        },
      ],
    };

    await installWebSocketTestBridge(page);

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [project] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || sessionA,
      );
      await route.fulfill({ json: buildBootstrapPayload(project, sessionId) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/messages')[0] || sessionA,
      );
      const messages = persistedMessages[sessionId] || [];
      await route.fulfill({
        json: {
          messages,
          total: messages.length,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
    });

    await page.goto(`/session/${sessionA}`);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_RESTORE_REPLY_1');

    await injectSocketMessage(page, {
      kind: 'text',
      sessionId: sessionA,
      provider: 'codex',
      role: 'user',
      content: 'LOCAL_RESTORE_USER_2',
    });
    await injectSocketMessage(page, {
      kind: 'text',
      sessionId: sessionA,
      provider: 'codex',
      role: 'assistant',
      content: 'LOCAL_RESTORE_REPLY_2',
    });
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_RESTORE_REPLY_2');

    persistedMessages[sessionA] = [
      ...(persistedMessages[sessionA] || []),
      {
        id: `${sessionA}-user-2`,
        sessionId: sessionA,
        timestamp: now,
        provider: 'codex',
        kind: 'text',
        role: 'user',
        content: 'LOCAL_RESTORE_USER_2',
      },
      {
        id: `${sessionA}-assistant-2`,
        sessionId: sessionA,
        timestamp: now,
        provider: 'codex',
        kind: 'text',
        role: 'assistant',
        content: 'LOCAL_RESTORE_REPLY_2',
      },
    ];

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionB}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionB}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_OTHER_SESSION_REPLY');
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('LOCAL_RESTORE_REPLY_2');

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionA}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionA}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_RESTORE_REPLY_2');

    await page.reload();
    await waitForAuthenticatedShell(page);
    await expect(page).toHaveURL(new RegExp(`/session/${sessionA}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_RESTORE_REPLY_1');
    await expect(page.getByTestId('chat-messages-pane')).toContainText('LOCAL_RESTORE_REPLY_2');
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('LOCAL_OTHER_SESSION_REPLY');
  });

  test('cloud session keeps later conversation history across switch-back and reload', async ({ page }) => {
    const sessionA = 'cloud-history-session-a';
    const sessionB = 'cloud-history-session-b';
    const project = buildCloudProject([sessionA, sessionB]);
    const persistedMessages: Record<string, unknown[]> = {
      [sessionA]: [
        {
          id: `${sessionA}-user-1`,
          sessionId: sessionA,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'user',
          content: 'CLOUD_RESTORE_USER_1',
        },
        {
          id: `${sessionA}-assistant-1`,
          sessionId: sessionA,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'assistant',
          content: 'CLOUD_RESTORE_REPLY_1',
        },
      ],
      [sessionB]: [
        {
          id: `${sessionB}-assistant-1`,
          sessionId: sessionB,
          timestamp: now,
          provider: 'codex',
          kind: 'text',
          role: 'assistant',
          content: 'CLOUD_OTHER_SESSION_REPLY',
        },
      ],
    };

    await installWebSocketTestBridge(page);

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [project] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/bootstrap')[0] || sessionA,
      );
      await route.fulfill({ json: buildBootstrapPayload(project, sessionId) });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      const sessionId = decodeURIComponent(
        route.request().url().split('/api/sessions/')[1]?.split('/messages')[0] || sessionA,
      );
      const messages = persistedMessages[sessionId] || [];
      await route.fulfill({
        json: {
          messages,
          total: messages.length,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
    });

    await page.goto(`/session/${sessionA}`);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_RESTORE_REPLY_1');

    await injectSocketMessage(page, {
      kind: 'text',
      sessionId: sessionA,
      provider: 'codex',
      role: 'user',
      content: 'CLOUD_RESTORE_USER_2',
    });
    await injectSocketMessage(page, {
      kind: 'text',
      sessionId: sessionA,
      provider: 'codex',
      role: 'assistant',
      content: 'CLOUD_RESTORE_REPLY_2',
    });
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_RESTORE_REPLY_2');

    persistedMessages[sessionA] = [
      ...(persistedMessages[sessionA] || []),
      {
        id: `${sessionA}-user-2`,
        sessionId: sessionA,
        timestamp: now,
        provider: 'codex',
        kind: 'text',
        role: 'user',
        content: 'CLOUD_RESTORE_USER_2',
      },
      {
        id: `${sessionA}-assistant-2`,
        sessionId: sessionA,
        timestamp: now,
        provider: 'codex',
        kind: 'text',
        role: 'assistant',
        content: 'CLOUD_RESTORE_REPLY_2',
      },
    ];

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionB}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionB}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_OTHER_SESSION_REPLY');
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('CLOUD_RESTORE_REPLY_2');

    await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionA}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionA}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_RESTORE_REPLY_2');

    await page.reload();
    await waitForAuthenticatedShell(page);
    await expect(page).toHaveURL(new RegExp(`/session/${sessionA}$`));
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_RESTORE_REPLY_1');
    await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_RESTORE_REPLY_2');
    await expect(page.getByTestId('chat-messages-pane')).not.toContainText('CLOUD_OTHER_SESSION_REPLY');
  });
});
