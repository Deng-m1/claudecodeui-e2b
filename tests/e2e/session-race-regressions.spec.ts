import { expect, test } from '@playwright/test';
import {
  ensureProjectExpanded,
  getProjectExpandedState,
  injectProjectsUpdated,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();

const buildLocalProject = () => ({
  name: 'local-race-project',
  displayName: 'local-race-project',
  path: '/tmp/local-race-project',
  fullPath: '/tmp/local-race-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: 'local-race-session',
      summary: 'Local Race Session',
      name: 'Local Race Session',
      title: 'Local Race Session',
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      messageCount: 2,
    },
  ],
  geminiSessions: [],
  e2bSessions: [],
  sessionMeta: {
    hasMore: false,
    total: 1,
  },
});

const buildCloudProject = (branch = 'main') => ({
  name: 'e2b__e2b/cloud-race-project',
  displayName: 'cloud-race-project',
  path: '/home/user/cloud-race-project',
  fullPath: '/home/user/cloud-race-project',
  kind: 'cloud',
  runtime: 'e2b',
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: [
    {
      id: 'cloud-race-session',
      summary: 'Cloud Race Session',
      name: 'Cloud Race Session',
      title: 'Cloud Race Session',
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      provider: 'codex',
      agent: 'codex',
      runtime: 'e2b',
      messageCount: 2,
    },
  ],
  sessionMeta: {
    hasMore: false,
    total: 1,
  },
  cloud: {
    sandboxId: 'e2b/cloud-race-project',
    status: 'running',
    repoUrl: 'https://github.com/test-owner/cloud-race-project.git',
    branch,
    workspacePath: '/home/user/cloud-race-project',
    createdAt: now,
    lastActivity: now,
  },
});

test('local history refresh ignores a stale earlier messages response', async ({ page }) => {
  const localProject = buildLocalProject();
  let requestCount = 0;
  let resolveFirstRequestSeen: (() => void) | null = null;
  const firstRequestSeen = new Promise<void>((resolve) => {
    resolveFirstRequestSeen = resolve;
  });

  await installWebSocketTestBridge(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: localProject,
        session: {
          ...localProject.codexSessions[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: localProject.name,
          __projectPath: localProject.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveFirstRequestSeen?.();
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        json: {
          messages: [
            {
              id: 'local-old-user',
              sessionId: 'local-race-session',
              provider: 'codex',
              kind: 'text',
              role: 'user',
              content: 'local-old-history',
              timestamp: now,
            },
          ],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        messages: [
          {
            id: 'local-old-user',
            sessionId: 'local-race-session',
            provider: 'codex',
            kind: 'text',
            role: 'user',
            content: 'local-old-history',
            timestamp: now,
          },
          {
            id: 'local-fresh-assistant',
            sessionId: 'local-race-session',
            provider: 'codex',
            kind: 'text',
            role: 'assistant',
            content: 'local-fresh-history-after-refresh',
            timestamp: now,
          },
        ],
        total: 2,
        hasMore: false,
        offset: 0,
        limit: 20,
      },
    });
  });

  await page.goto('/session/local-race-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);
  await firstRequestSeen;

  await injectProjectsUpdated(page, [localProject], {
    watchProvider: 'codex',
    changedFile: `${localProject.name}/local-race-session.jsonl`,
  });

  await expect(page.getByTestId('chat-messages-pane')).toContainText('local-fresh-history-after-refresh');
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('chat-messages-pane')).toContainText('local-fresh-history-after-refresh');
});

test('cloud history refresh ignores a stale earlier messages response', async ({ page }) => {
  const cloudProject = buildCloudProject();
  let requestCount = 0;
  let resolveFirstRequestSeen: (() => void) | null = null;
  const firstRequestSeen = new Promise<void>((resolve) => {
    resolveFirstRequestSeen = resolve;
  });

  await installWebSocketTestBridge(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [cloudProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'e2b',
        project: cloudProject,
        session: {
          ...cloudProject.e2bSessions[0],
          __provider: 'codex',
          __runtime: 'e2b',
          __projectName: cloudProject.name,
          __projectPath: cloudProject.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveFirstRequestSeen?.();
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        json: {
          messages: [
            {
              id: 'cloud-old-user',
              sessionId: 'cloud-race-session',
              provider: 'codex',
              kind: 'text',
              role: 'user',
              content: 'cloud-old-history',
              timestamp: now,
            },
          ],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        messages: [
          {
            id: 'cloud-old-user',
            sessionId: 'cloud-race-session',
            provider: 'codex',
            kind: 'text',
            role: 'user',
            content: 'cloud-old-history',
            timestamp: now,
          },
          {
            id: 'cloud-fresh-assistant',
            sessionId: 'cloud-race-session',
            provider: 'codex',
            kind: 'text',
            role: 'assistant',
            content: 'cloud-fresh-history-after-refresh',
            timestamp: now,
          },
        ],
        total: 2,
        hasMore: false,
        offset: 0,
        limit: 20,
      },
    });
  });

  await page.goto('/session/cloud-race-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);
  await firstRequestSeen;

  await injectProjectsUpdated(page, [cloudProject], {
    watchProvider: 'e2b',
    changedFile: `${cloudProject.name}/cloud-race-session.jsonl`,
  });

  await expect(page.getByTestId('chat-messages-pane')).toContainText('cloud-fresh-history-after-refresh');
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('chat-messages-pane')).toContainText('cloud-fresh-history-after-refresh');
});

test('new session keeps sidebar UI state instead of behaving like a full page reset', async ({ page }) => {
  const localProject = buildLocalProject();
  const cloudProject = buildCloudProject();

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject, cloudProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: localProject,
        session: {
          ...localProject.codexSessions[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: localProject.name,
          __projectPath: localProject.fullPath,
        },
      },
    });
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

  await page.goto('/session/local-race-session');
  await waitForAuthenticatedShell(page);

  await ensureProjectExpanded(page, localProject.name);
  await ensureProjectExpanded(page, cloudProject.name);
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);
  expect(await getProjectExpandedState(page, cloudProject.name)).toBe(true);

  const searchInput = page.locator('[data-testid="sidebar-search"]:visible').first();
  await searchInput.fill('race-project');

  const sidebarMarker = await page.evaluate(() => {
    const marker = Math.random().toString(36).slice(2);
    (window as typeof window & { __sidebarMarker?: string }).__sidebarMarker = marker;
    return marker;
  });

  await page.locator(`[data-testid="project-new-session"][data-project-name="${cloudProject.name}"]:visible`).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('sidebar-projects-loading')).toBeHidden();
  await expect(page.getByTestId('main-content-loading')).toBeHidden();
  await expect(searchInput).toHaveValue('race-project');
  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${localProject.name}"]:visible`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${cloudProject.name}"]:visible`).first(),
  ).toBeVisible();
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);
  expect(await getProjectExpandedState(page, cloudProject.name)).toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as typeof window & { __sidebarMarker?: string }).__sidebarMarker || ''),
    )
    .toBe(sidebarMarker);

  await page.locator(`[data-testid="project-new-session"][data-project-name="${localProject.name}"]:visible`).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('sidebar-projects-loading')).toBeHidden();
  await expect(page.getByTestId('main-content-loading')).toBeHidden();
  await expect(searchInput).toHaveValue('race-project');
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);
  expect(await getProjectExpandedState(page, cloudProject.name)).toBe(true);
});

test('rapid projects updates keep the newest cloud sidebar metadata', async ({ page }) => {
  const localProject = buildLocalProject();
  const cloudProject = buildCloudProject('main');
  const updatedCloudProject = {
    ...cloudProject,
    e2bSessions: [
      ...cloudProject.e2bSessions,
      {
        id: 'cloud-race-session-2',
        summary: 'Cloud Race Session 2',
        name: 'Cloud Race Session 2',
        title: 'Cloud Race Session 2',
        createdAt: now,
        created_at: now,
        updated_at: now,
        lastActivity: now,
        provider: 'codex',
        agent: 'codex',
        runtime: 'e2b',
        messageCount: 1,
      },
    ],
    sessionMeta: {
      hasMore: false,
      total: 2,
    },
    cloud: {
      ...cloudProject.cloud,
      branch: 'feature-race',
    },
  };

  await installWebSocketTestBridge(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject, cloudProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.goto('/');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  const cloudProjectItem = page.locator(
    `[data-testid="sidebar-project-item"][data-project-name="${cloudProject.name}"]:visible`,
  ).first();

  await expect(cloudProjectItem).toContainText('main');

  await page.evaluate(
    ({ firstPayload, secondPayload }) => {
      const win = window as typeof window & {
        __appSocketTestBridge?: {
          injectMessage: (payload: unknown) => void;
        };
      };

      win.__appSocketTestBridge?.injectMessage(firstPayload);
      win.__appSocketTestBridge?.injectMessage(secondPayload);
    },
    {
      firstPayload: {
        type: 'projects_updated',
        projects: [localProject, updatedCloudProject],
        watchProvider: 'codex',
        changedFile: `${updatedCloudProject.name}/cloud-race-session.jsonl`,
      },
      secondPayload: {
        type: 'projects_updated',
        projects: [localProject],
        watchProvider: 'claude',
        changedFile: `${localProject.name}/synthetic.jsonl`,
      },
    },
  );

  await expect(cloudProjectItem).toContainText('feature-race');
  await expect(cloudProjectItem).toContainText('2 sessions');
});
