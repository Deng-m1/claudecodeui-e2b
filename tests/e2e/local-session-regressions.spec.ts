import { expect, test } from '@playwright/test';
import {
  attachBrowserErrorRecorder,
  clearOutboundSocketMessages,
  ensureProjectExpanded,
  getOutboundSocketMessages,
  getProjectExpandedState,
  injectProjectsUpdated,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForLastOutboundSocketMessage,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();

const buildLocalProject = (overrides: Record<string, unknown> = {}) => ({
  name: 'local-regression-project',
  displayName: 'local-regression-project',
  path: '/tmp/local-regression-project',
  fullPath: '/tmp/local-regression-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: 'local-codex-session',
      summary: 'Local Codex Session',
      name: 'Local Codex Session',
      title: 'Local Codex Session',
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
  ...overrides,
});

const buildCloudProject = () => ({
  name: 'e2b__e2b/cloud-regression-project',
  displayName: 'cloud-regression-project',
  path: '/home/user/cloud-regression-project',
  fullPath: '/home/user/cloud-regression-project',
  kind: 'cloud',
  runtime: 'e2b',
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: [
    {
      id: 'cloud-codex-session',
      summary: 'Cloud Codex Session',
      name: 'Cloud Codex Session',
      title: 'Cloud Codex Session',
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
    total: 1,
  },
  cloud: {
    sandboxId: 'e2b/cloud-regression-project',
    status: 'running',
    repoUrl: 'https://github.com/test-owner/cloud-regression-project.git',
    branch: 'main',
    workspacePath: '/home/user/cloud-regression-project',
    createdAt: now,
    lastActivity: now,
  },
});

test('selected local session still sends a local command when project payload reports e2b runtime', async ({
  page,
}) => {
  const contaminatedProject = buildLocalProject({
    kind: 'cloud',
    runtime: 'e2b',
    cloud: {
      sandboxId: 'e2b/local-regression-project',
      status: 'running',
      repoUrl: 'https://github.com/test-owner/local-regression-project.git',
      branch: 'main',
      workspacePath: '/tmp/local-regression-project',
      createdAt: now,
      lastActivity: now,
    },
  });

  await installWebSocketTestBridge(page, { passthrough: false });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [contaminatedProject, buildCloudProject()] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: contaminatedProject,
        session: {
          ...contaminatedProject.codexSessions[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: contaminatedProject.name,
          __projectPath: contaminatedProject.fullPath,
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

  await page.goto('/session/local-codex-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);
  await clearOutboundSocketMessages(page);

  await page.getByTestId('chat-composer-textarea').fill('resume-local-session-after-cloud');
  await expect(page.getByTestId('chat-composer-submit')).toBeEnabled();
  await page.getByTestId('chat-composer-submit').click();

  const command = await waitForLastOutboundSocketMessage(page, { type: 'codex-command' });
  expect(command?.parsed?.type).toBe('codex-command');
  expect(command?.parsed?.sessionId).toBe('local-codex-session');

  const outboundMessages = await getOutboundSocketMessages(page);
  expect(outboundMessages.some((message) => message.parsed?.type === 'e2b-command')).toBe(false);
});

test('session bootstrap metadata drives the initial history request for local sessions', async ({
  page,
}) => {
  const staleProject = buildLocalProject({
    name: 'stale-project-name',
    displayName: 'stale-project-name',
    path: '/tmp/stale-project-path',
    fullPath: '/tmp/stale-project-path',
  });

  await installWebSocketTestBridge(page, { passthrough: false });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [staleProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: staleProject,
        session: {
          ...staleProject.codexSessions[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: 'canonical-project-name',
          __projectPath: '/tmp/canonical-project-path',
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    const url = new URL(route.request().url());
    const projectName = url.searchParams.get('projectName');
    const projectPath = url.searchParams.get('projectPath');

    const matchesSessionMetadata =
      projectName === 'canonical-project-name' &&
      projectPath === '/tmp/canonical-project-path';

    await route.fulfill({
      json: {
        messages: matchesSessionMetadata
          ? [
              {
                id: 'history-1',
                sessionId: 'local-codex-session',
                timestamp: '2026-04-02T03:12:12.832Z',
                provider: 'codex',
                kind: 'text',
                role: 'assistant',
                content: 'history-loaded-from-session-metadata',
              },
            ]
          : [],
        total: matchesSessionMetadata ? 1 : 0,
        hasMore: false,
        offset: 0,
        limit: 20,
        mode: 'bootstrap',
        lastSeq: matchesSessionMetadata ? 1 : 0,
        oldestSeq: matchesSessionMetadata ? 1 : null,
        newestSeq: matchesSessionMetadata ? 1 : null,
        sessionVersion: 1,
      },
    });
  });

  await page.goto('/session/local-codex-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  await expect(page.getByText('history-loaded-from-session-metadata')).toBeVisible();
});

test('new local session stays submittable while the previous session is still processing', async ({
  page,
}) => {
  const localProject = buildLocalProject();

  await installWebSocketTestBridge(page, { passthrough: false });

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

  await page.goto('/session/local-codex-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  await injectProjectsUpdated(page, [localProject], {
    watchProvider: 'codex',
    changedFile: `${localProject.name}/local-codex-session.jsonl`,
  });
  await page.evaluate(() => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        injectMessage: (payload: unknown) => void;
      };
    };

    win.__appSocketTestBridge?.injectMessage({
      kind: 'status',
      sessionId: 'local-codex-session',
      provider: 'codex',
      text: 'Processing',
      canInterrupt: true,
    });
  });

  await expect(page.getByTestId('chat-status-card')).toContainText('Processing');

  const newSessionButton = await ensureProjectExpanded(page, localProject.name);
  await newSessionButton.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('chat-status-card')).toBeHidden();

  await clearOutboundSocketMessages(page);
  await page.getByTestId('chat-composer-textarea').fill('new-session-while-old-is-processing');
  await expect(page.getByTestId('chat-composer-submit')).toBeEnabled();
  await page.getByTestId('chat-composer-submit').click();

  const command = await waitForLastOutboundSocketMessage(page, { type: 'codex-command' });
  expect(command?.parsed?.type).toBe('codex-command');
  expect(command?.parsed?.sessionId).toBeNull();
  expect(command?.parsed?.options).toMatchObject({
    sessionId: null,
    resume: false,
  });
});

test('new local session on a contaminated project still routes commands locally', async ({
  page,
}) => {
  const contaminatedProject = buildLocalProject({
    kind: 'cloud',
    runtime: 'e2b',
    cloud: {
      sandboxId: '',
      status: 'running',
      repoUrl: null,
      branch: 'main',
      workspacePath: '/tmp/local-regression-project',
      createdAt: now,
      lastActivity: now,
    },
  });

  await installWebSocketTestBridge(page, { passthrough: false });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [contaminatedProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: contaminatedProject,
        session: {
          ...contaminatedProject.codexSessions[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: contaminatedProject.name,
          __projectPath: contaminatedProject.fullPath,
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

  await page.goto('/session/local-codex-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  const newSessionButton = await ensureProjectExpanded(page, contaminatedProject.name);
  await newSessionButton.click();
  await expect(page).toHaveURL(/\/$/);

  await clearOutboundSocketMessages(page);
  await page.getByTestId('chat-composer-textarea').fill('new-local-session-on-contaminated-project');
  await expect(page.getByTestId('chat-composer-submit')).toBeEnabled();
  await page.getByTestId('chat-composer-submit').click();

  const command = await waitForLastOutboundSocketMessage(page, { type: 'codex-command' });
  expect(command?.parsed?.type).toBe('codex-command');
  expect(command?.parsed?.sessionId).toBeNull();

  const outboundMessages = await getOutboundSocketMessages(page);
  expect(outboundMessages.some((message) => message.parsed?.type === 'e2b-command')).toBe(false);
});

test('local/cloud switching and refresh keep cloud projects visible without browser errors', async ({
  page,
}) => {
  const localProject = buildLocalProject();
  const cloudProject = buildCloudProject();
  let responseProjects = [localProject, cloudProject];

  await installWebSocketTestBridge(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: responseProjects });
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

  const errorRecorder = attachBrowserErrorRecorder(page);

  await page.goto('/');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${localProject.name}"]:visible`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${cloudProject.name}"]:visible`).first(),
  ).toBeVisible();

  await ensureProjectExpanded(page, localProject.name);
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);

  responseProjects = [localProject];
  await page.evaluate(() => window.refreshProjects?.());

  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${cloudProject.name}"]:visible`).first(),
  ).toBeVisible();
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);

  await injectProjectsUpdated(page, [localProject], {
    watchProvider: 'claude',
    changedFile: `${localProject.name}/synthetic.jsonl`,
  });

  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${cloudProject.name}"]:visible`).first(),
  ).toBeVisible();
  expect(await getProjectExpandedState(page, localProject.name)).toBe(true);
  expect(
    errorRecorder.consoleErrors.filter(
      (message) => !message.includes('Failed to load resource: the server responded with a status of 403'),
    ),
  ).toEqual([]);
  expect(errorRecorder.pageErrors).toEqual([]);
  errorRecorder.dispose();
});


test('stale e2b runtime badge and routes locally after switching from cloud session', async ({
  page,
}) => {
  const localProject = buildLocalProject();
  const cloudProject = buildCloudProject();

  await page.addInitScript(() => {
    window.localStorage.setItem('runtime-mode', 'e2b');
    window.localStorage.setItem('selected-provider', 'codex');
  });

  await installWebSocketTestBridge(page, { passthrough: false });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [localProject, cloudProject] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split('/').at(-2);

    if (sessionId === 'cloud-codex-session') {
      await route.fulfill({
        json: {
          provider: 'codex',
          project: cloudProject,
          session: {
            ...cloudProject.e2bSessions[0],
            __provider: 'codex',
            __runtime: 'e2b',
            __projectName: cloudProject.name,
            __projectPath: cloudProject.cloud.workspacePath,
          },
        },
      });
      return;
    }

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

  await page.goto('/session/cloud-codex-session');
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);
  await expect(page.getByText('E2B Cloud')).toBeVisible();

  await ensureProjectExpanded(page, localProject.name);
  await page.getByRole('button', { name: /Local Codex Session/i }).click();

  await expect(page).toHaveURL(/\/session\/local-codex-session$/);
  await expect(page.getByText('E2B Cloud')).toBeHidden();

  await clearOutboundSocketMessages(page);
  await page.getByTestId('chat-composer-textarea').fill('switch-back-to-local-after-cloud');
  await expect(page.getByTestId('chat-composer-submit')).toBeEnabled();
  await page.getByTestId('chat-composer-submit').click();

  const command = await waitForLastOutboundSocketMessage(page, { type: 'codex-command' });
  expect(command?.parsed?.type).toBe('codex-command');
  expect(command?.parsed?.options).toMatchObject({
    cwd: localProject.fullPath,
    projectPath: localProject.fullPath,
    sessionId: 'local-codex-session',
    resume: true,
  });

  const outboundMessages = await getOutboundSocketMessages(page);
  expect(outboundMessages.some((message) => message.parsed?.type === 'e2b-command')).toBe(false);
});
