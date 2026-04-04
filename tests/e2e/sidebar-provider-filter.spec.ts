import { expect, test, type Page } from '@playwright/test';
import {
  ensureProjectExpanded,
  getVisibleSidebarSessionIds,
  setSidebarProviderFilter,
  waitForAuthenticatedShell,
} from './support/app';

const now = new Date().toISOString();

const installCommonShellRoutes = async (page: Page) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('auth-token', 'playwright-test-token');
  });

  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      json: {
        needsSetup: false,
        registrationDisabled: true,
        setupLocked: false,
        isAuthenticated: true,
      },
    });
  });

  await page.route('**/api/auth/user', async (route) => {
    await route.fulfill({
      json: {
        user: {
          id: 1,
          username: 'dbj',
        },
      },
    });
  });

  await page.route('**/api/user/onboarding-status', async (route) => {
    await route.fulfill({ json: { hasCompletedOnboarding: true } });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/mcp-utils/taskmaster-server', async (route) => {
    await route.fulfill({ json: null });
  });

  await page.route('**/api/taskmaster/tasks/*', async (route) => {
    await route.fulfill({ json: { tasks: [] } });
  });

  await page.route('https://api.github.com/repos/siteboon/claudecodeui/releases/latest', async (route) => {
    await route.fulfill({
      json: {
        tag_name: 'v1.27.1',
        html_url: 'https://github.com/siteboon/claudecodeui/releases/latest',
      },
    });
  });
};

const buildLocalProject = () => ({
  name: 'provider-filter-local',
  displayName: 'provider-filter-local',
  path: '/tmp/provider-filter-local',
  fullPath: '/tmp/provider-filter-local',
  kind: 'local',
  runtime: 'local',
  sessions: [
    {
      id: 'local-claude-1',
      summary: 'Local Claude 1',
      createdAt: now,
      lastActivity: now,
      messageCount: 2,
    },
  ],
  cursorSessions: [],
  codexSessions: [
    {
      id: 'local-codex-1',
      summary: 'Local Codex 1',
      createdAt: now,
      lastActivity: now,
      messageCount: 2,
    },
  ],
  geminiSessions: [
    {
      id: 'local-gemini-1',
      summary: 'Local Gemini 1',
      createdAt: now,
      lastActivity: now,
      messageCount: 2,
    },
  ],
  e2bSessions: [],
  sessionMeta: {
    total: 4,
    hasMore: false,
    byProvider: {
      claude: { total: 1, hasMore: false },
      cursor: { total: 0, hasMore: false },
      codex: { total: 1, hasMore: false },
      gemini: { total: 1, hasMore: false },
    },
  },
});

const buildCloudProject = () => ({
  name: 'e2b__provider-filter-cloud',
  displayName: 'provider-filter-cloud',
  path: '/home/user/provider-filter-cloud',
  fullPath: '/home/user/provider-filter-cloud',
  kind: 'cloud',
  runtime: 'e2b',
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: [
    {
      id: 'cloud-claude-1',
      summary: 'Cloud Claude 1',
      createdAt: now,
      lastActivity: now,
      provider: 'claude',
      agent: 'claude',
      runtime: 'e2b',
      messageCount: 1,
    },
    {
      id: 'cloud-codex-1',
      summary: 'Cloud Codex 1',
      createdAt: now,
      lastActivity: now,
      provider: 'codex',
      agent: 'codex',
      runtime: 'e2b',
      messageCount: 1,
    },
  ],
  sessionMeta: {
    total: 2,
    hasMore: false,
    byProvider: {
      claude: { total: 1, hasMore: false },
      cursor: { total: 0, hasMore: false },
      codex: { total: 1, hasMore: false },
      gemini: { total: 0, hasMore: false },
    },
  },
  cloud: {
    sandboxId: 'provider-filter-cloud',
    status: 'running',
    repoUrl: 'https://github.com/test-owner/provider-filter-cloud.git',
    branch: 'main',
    workspacePath: '/home/user/provider-filter-cloud',
  },
});

test('provider filter works on small screens and keeps only matching sessions visible', async ({ page }) => {
  const localProject = buildLocalProject();
  const cloudProject = buildCloudProject();

  await page.setViewportSize({ width: 390, height: 844 });
  await installCommonShellRoutes(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject, cloudProject] });
  });

  await page.goto('/');
  await waitForAuthenticatedShell(page);

  await ensureProjectExpanded(page, localProject.name);
  await ensureProjectExpanded(page, cloudProject.name);

  await setSidebarProviderFilter(page, 'codex');
  await expect
    .poll(async () => await getVisibleSidebarSessionIds(page))
    .toEqual(['local-codex-1', 'cloud-codex-1']);

  await setSidebarProviderFilter(page, 'claude');
  await expect
    .poll(async () => await getVisibleSidebarSessionIds(page))
    .toEqual(['local-claude-1', 'cloud-claude-1']);
});

test('provider-filtered load more requests the current provider for local and cloud projects', async ({ page }) => {
  const localProject = {
    ...buildLocalProject(),
    codexSessions: [
      {
        id: 'local-codex-1',
        summary: 'Local Codex 1',
        createdAt: now,
        lastActivity: now,
        messageCount: 2,
      },
    ],
    sessionMeta: {
      total: 2,
      hasMore: true,
      byProvider: {
        claude: { total: 1, hasMore: false },
        cursor: { total: 0, hasMore: false },
        codex: { total: 2, hasMore: true },
        gemini: { total: 1, hasMore: false },
      },
    },
  };
  const cloudProject = {
    ...buildCloudProject(),
    e2bSessions: [
      {
        id: 'cloud-codex-1',
        summary: 'Cloud Codex 1',
        createdAt: now,
        lastActivity: now,
        provider: 'codex',
        agent: 'codex',
        runtime: 'e2b',
        messageCount: 1,
      },
    ],
    sessionMeta: {
      total: 2,
      hasMore: true,
      byProvider: {
        claude: { total: 0, hasMore: false },
        cursor: { total: 0, hasMore: false },
        codex: { total: 2, hasMore: true },
        gemini: { total: 0, hasMore: false },
      },
    },
  };
  const requestLog: string[] = [];

  await installCommonShellRoutes(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject, cloudProject] });
  });

  await page.route('**/api/projects/*/sessions?*', async (route) => {
    const url = new URL(route.request().url());
    requestLog.push(url.toString());
    const provider = url.searchParams.get('provider');
    const projectPath = url.pathname.split('/').at(-2);

    if (projectPath === localProject.name && provider === 'codex') {
      await route.fulfill({
        json: {
          sessions: [
            {
              id: 'local-codex-2',
              summary: 'Local Codex 2',
              createdAt: now,
              lastActivity: now,
              messageCount: 1,
            },
          ],
          total: 2,
          hasMore: false,
        },
      });
      return;
    }

    if (projectPath === cloudProject.name && provider === 'codex') {
      await route.fulfill({
        json: {
          sessions: [
            {
              id: 'cloud-codex-2',
              summary: 'Cloud Codex 2',
              createdAt: now,
              lastActivity: now,
              provider: 'codex',
              agent: 'codex',
              runtime: 'e2b',
              messageCount: 1,
            },
          ],
          total: 2,
          hasMore: false,
        },
      });
      return;
    }

    await route.fulfill({ json: { sessions: [], total: 0, hasMore: false } });
  });

  await page.goto('/');
  await waitForAuthenticatedShell(page);
  await setSidebarProviderFilter(page, 'codex');

  await ensureProjectExpanded(page, localProject.name);
  await page.locator(`[data-testid="sidebar-load-more-sessions"][data-project-name="${localProject.name}"]:visible`).click();
  await expect(page.locator('[data-testid="sidebar-session-item"][data-session-id="local-codex-2"]')).toBeVisible();

  await ensureProjectExpanded(page, cloudProject.name);
  await page.locator(`[data-testid="sidebar-load-more-sessions"][data-project-name="${cloudProject.name}"]:visible`).click();
  await expect(page.locator('[data-testid="sidebar-session-item"][data-session-id="cloud-codex-2"]')).toBeVisible();

  expect(requestLog.some((entry) => entry.includes(`${encodeURIComponent(localProject.name)}/sessions`) && entry.includes('provider=codex'))).toBe(true);
  expect(requestLog.some((entry) => entry.includes(`${encodeURIComponent(cloudProject.name)}/sessions`) && entry.includes('provider=codex'))).toBe(true);
});

test('bootstrap payload does not erase provider hasMore metadata for the current project', async ({ page }) => {
  const project = {
    ...buildLocalProject(),
    codexSessions: [
      {
        id: 'local-codex-1',
        summary: 'Local Codex 1',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
      },
      {
        id: 'local-codex-2',
        summary: 'Local Codex 2',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
      },
      {
        id: 'local-codex-3',
        summary: 'Local Codex 3',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
      },
    ],
    sessionMeta: {
      total: 6,
      hasMore: true,
      byProvider: {
        claude: { total: 1, hasMore: false },
        cursor: { total: 0, hasMore: false },
        codex: { total: 6, hasMore: true },
        gemini: { total: 1, hasMore: false },
      },
    },
  };

  const bootstrapProject = {
    ...project,
    codexSessions: [project.codexSessions[1]],
    sessionMeta: {
      total: 1,
      hasMore: false,
    },
  };

  await installCommonShellRoutes(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [project] });
  });

  await page.route('**/api/sessions/local-codex-2/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: bootstrapProject,
        session: {
          ...project.codexSessions[1],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: project.name,
          __projectPath: project.fullPath,
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

  await page.goto('/session/local-codex-2');
  await waitForAuthenticatedShell(page);

  await setSidebarProviderFilter(page, 'codex');
  await ensureProjectExpanded(page, project.name);
  await expect(
    page.locator('[data-testid="sidebar-load-more-sessions"][data-project-name="' + project.name + '"]'),
  ).toBeVisible();
});
test('older inactive Codex sessions stay in the sidebar after a project refresh only returns the recent page', async ({ page }) => {
  const project = {
    ...buildLocalProject(),
    codexSessions: [
      {
        id: 'recent-codex-session',
        summary: 'Recent Codex Session',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
      },
    ],
    sessionMeta: {
      total: 6,
      hasMore: true,
      byProvider: {
        claude: { total: 1, hasMore: false },
        cursor: { total: 0, hasMore: false },
        codex: { total: 6, hasMore: true },
        gemini: { total: 1, hasMore: false },
      },
    },
  };

  await installCommonShellRoutes(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [project] });
  });

  await page.route('**/api/sessions/older-codex-session/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: {
          ...project,
          codexSessions: [
            {
              id: 'older-codex-session',
              summary: 'Older Codex Session',
              createdAt: '2026-03-30T10:00:00.000Z',
              lastActivity: '2026-03-30T10:00:00.000Z',
              messageCount: 3,
            },
          ],
        },
        session: {
          id: 'older-codex-session',
          summary: 'Older Codex Session',
          createdAt: '2026-03-30T10:00:00.000Z',
          lastActivity: '2026-03-30T10:00:00.000Z',
          __provider: 'codex',
          __runtime: 'local',
          __projectName: project.name,
          __projectPath: project.fullPath,
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

  await page.goto('/session/older-codex-session');
  await waitForAuthenticatedShell(page);

  await setSidebarProviderFilter(page, 'codex');
  await ensureProjectExpanded(page, project.name);
  await expect(page.locator('[data-testid="sidebar-session-item"][data-session-id="older-codex-session"]')).toBeVisible();

  await page.evaluate(() => window.refreshProjects?.());

  await expect(page.locator('[data-testid="sidebar-session-item"][data-session-id="older-codex-session"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-session-item"][data-session-id="recent-codex-session"]')).toBeVisible();
});
