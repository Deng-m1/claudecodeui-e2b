import { expect, test } from '@playwright/test';
import {
  ensureProjectExpanded,
  fetchLiveProjects,
  getSidebarProjectNames,
  injectProjectsUpdated,
  installWebSocketTestBridge,
  openSessionLauncher,
  waitForAuthenticatedShell,
} from './support/app';

const getRepoSearchLabel = (repoUrl?: string | null) => {
  if (!repoUrl) {
    return '';
  }

  return repoUrl.replace(/\.git$/, '').split('github.com/').pop() || repoUrl;
};

test('sidebar renders live local and cloud project sections and supports cloud metadata search', async ({ page }) => {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const liveProjects = await fetchLiveProjects(page);
  const localProjects = liveProjects.filter((project) => project.runtime !== 'e2b');
  const cloudProjects = liveProjects.filter((project) => project.runtime === 'e2b');
  const liveNames = liveProjects.map((project) => project.name).sort();

  expect(localProjects.length).toBeGreaterThan(0);
  expect(cloudProjects.length).toBeGreaterThan(0);

  await expect(page.getByTestId('sidebar-project-section-local')).toBeVisible();
  await expect(page.getByTestId('sidebar-project-section-cloud')).toBeVisible();

  await expect
    .poll(async () => [...(await getSidebarProjectNames(page))].sort(), {
      timeout: 20_000,
    })
    .toEqual(liveNames);

  const searchableCloudProject = cloudProjects.find((project) => project.cloud?.repoUrl) || cloudProjects[0];
  const searchQuery = getRepoSearchLabel(searchableCloudProject.cloud?.repoUrl) || searchableCloudProject.cloud?.branch || searchableCloudProject.name;
  const searchInput = page.locator('[data-testid="sidebar-search"]:visible').first();

  await searchInput.fill(searchQuery);

  await expect
    .poll(async () => await getSidebarProjectNames(page), {
      timeout: 10_000,
    })
    .toContain(searchableCloudProject.name);
});

test('sidebar preserves cloud projects when a local-only realtime projects_updated payload arrives', async ({ page }) => {
  await installWebSocketTestBridge(page);
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const liveProjects = await fetchLiveProjects(page);
  const cloudProjects = liveProjects.filter((project) => project.runtime === 'e2b');
  const localProjects = liveProjects.filter((project) => project.runtime !== 'e2b');

  expect(cloudProjects.length).toBeGreaterThan(0);
  expect(localProjects.length).toBeGreaterThan(0);

  const expectedNames = liveProjects.map((project) => project.name).sort();

  await injectProjectsUpdated(page, localProjects, {
    watchProvider: 'claude',
    changedFile: `${localProjects[0]?.name || 'local'}/synthetic.jsonl`,
  });

  await expect
    .poll(async () => [...(await getSidebarProjectNames(page))].sort(), {
      timeout: 10_000,
    })
    .toEqual(expectedNames);
});

test('local and cloud projects can stay expanded together when selecting between them', async ({ page }) => {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const liveProjects = await fetchLiveProjects(page);
  const localProject = liveProjects.find((project) => project.runtime !== 'e2b');
  const cloudProject = liveProjects.find((project) => project.runtime === 'e2b');

  expect(localProject).toBeTruthy();
  expect(cloudProject).toBeTruthy();

  await ensureProjectExpanded(page, localProject!.name);
  await ensureProjectExpanded(page, cloudProject!.name);

  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${localProject!.name}"]:visible`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${cloudProject!.name}"]:visible`).first(),
  ).toBeVisible();

  const currentUrl = page.url();
  await page.locator(`[data-testid="sidebar-project-item"][data-project-name="${localProject!.name}"]:visible`).first().click();
  await expect(page).toHaveURL(currentUrl);

  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${localProject!.name}"]:visible`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${cloudProject!.name}"]:visible`).first(),
  ).toBeVisible();

  await page.locator(`[data-testid="sidebar-project-item"][data-project-name="${cloudProject!.name}"]:visible`).first().click();

  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${localProject!.name}"]:visible`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="project-new-session"][data-project-name="${cloudProject!.name}"]:visible`).first(),
  ).toBeVisible();
});

test('cloud session route survives reload and remains reachable from the sidebar', async ({ page }) => {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const liveProjects = await fetchLiveProjects(page);
  const cloudProject = liveProjects.find((project) => (project.e2bSessions?.length || 0) > 0);

  test.skip(!cloudProject, 'No cloud project with sessions is available in this environment.');

  const targetSessionId = cloudProject!.e2bSessions![0]!.id;

  await ensureProjectExpanded(page, cloudProject!.name);
  await page.locator(`[data-testid="sidebar-session-item"][data-session-id="${targetSessionId}"]:visible`).first().click();

  await expect(page).toHaveURL(new RegExp(`/session/${targetSessionId}$`));
  await expect(page.getByTestId('chat-messages-pane')).toBeVisible();

  await page.reload();
  await waitForAuthenticatedShell(page);
  await expect(page).toHaveURL(new RegExp(`/session/${targetSessionId}$`));

  await ensureProjectExpanded(page, cloudProject!.name);
  await expect(
    page.locator(`[data-testid="sidebar-session-item"][data-session-id="${targetSessionId}"]:visible`).first(),
  ).toBeVisible();
});

test('launcher-created cloud project becomes visible in the sidebar immediately', async ({ page }) => {
  const createdSandboxId = 'e2b/testsidebarcreated123';
  const createdProjectName = 'e2b__e2b/testsidebarcreated123';
  const createdProject = {
    name: createdProjectName,
    displayName: 'test-repo',
    path: '/home/user/test-repo',
    fullPath: '/home/user/test-repo',
    kind: 'cloud',
    runtime: 'e2b',
    sessions: [],
    cursorSessions: [],
    codexSessions: [],
    geminiSessions: [],
    e2bSessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
    cloud: {
      sandboxId: createdSandboxId,
      status: 'running',
      repoUrl: 'https://github.com/test-owner/test-repo.git',
      branch: 'main',
      workspacePath: '/home/user/test-repo',
    },
  };

  let created = false;

  await page.route('**/api/e2b/status', async (route) => {
    await route.fulfill({ json: { configured: true } });
  });

  await page.route('**/api/auth-center/overview', async (route) => {
    await route.fulfill({ json: { success: true, providers: {}, defaultSelections: {} } });
  });

  await page.route('**/api/github/oauth/status', async (route) => {
    await route.fulfill({ json: { connected: true } });
  });

  await page.route('**/api/github/repos?*', async (route) => {
    await route.fulfill({
      json: {
        page: 1,
        perPage: 30,
        total: 1,
        repos: [
          {
            id: 9001,
            name: 'test-repo',
            fullName: 'test-owner/test-repo',
            private: false,
            description: 'Playwright cloud launcher fixture',
            defaultBranch: 'main',
            language: 'TypeScript',
            updatedAt: new Date().toISOString(),
            htmlUrl: 'https://github.com/test-owner/test-repo',
            cloneUrl: 'https://github.com/test-owner/test-repo.git',
            owner: {
              login: 'test-owner',
              avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
            },
          },
        ],
      },
    });
  });

  await page.route('**/api/github/repos/test-owner/test-repo/branches', async (route) => {
    await route.fulfill({
      json: {
        defaultBranch: 'main',
        branches: [
          { name: 'main', isDefault: true, sha: 'abc123' },
          { name: 'release', sha: 'def456' },
        ],
      },
    });
  });

  await page.route('**/api/e2b/sandbox/create-with-repo', async (route) => {
    created = true;
    await route.fulfill({
      json: {
        success: true,
        sandboxId: createdSandboxId,
      },
    });
  });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({
      json: created ? [createdProject] : [],
    });
  });

  await page.goto('/');
  await waitForAuthenticatedShell(page);

  await openSessionLauncher(page);
  await page.getByTestId('launcher-mode-cloud').click();

  const repoSearch = page.getByTestId('launcher-repo-search');
  await repoSearch.fill('test-owner/test-repo');
  await expect(page.getByTestId('launcher-repo-option').first()).toBeVisible();
  await page.getByTestId('launcher-repo-option').first().click();

  await expect(page.getByTestId('launcher-branch-select')).toHaveValue('main');
  await page.getByTestId('launcher-start-cloud').click();

  await expect(page.getByTestId('session-launcher')).toBeHidden({ timeout: 10_000 });
  await expect
    .poll(async () => await getSidebarProjectNames(page), {
      timeout: 10_000,
    })
    .toContain(createdProjectName);
  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${createdProjectName}"]:visible`).first(),
  ).toBeVisible();
});
