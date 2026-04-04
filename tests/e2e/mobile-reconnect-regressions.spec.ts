import { expect, test, type Page } from '@playwright/test';
import {
  clearOutboundSocketMessages,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForLastOutboundSocketMessage,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();

const buildLocalProject = (overrides: Record<string, unknown> = {}) => ({
  name: 'mobile-reconnect-project',
  displayName: 'mobile-reconnect-project',
  path: '/tmp/mobile-reconnect-project',
  fullPath: '/tmp/mobile-reconnect-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: 'mobile-codex-session',
      summary: 'Mobile Codex Session',
      name: 'Mobile Codex Session',
      title: 'Mobile Codex Session',
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

const buildCloudProject = (overrides: Record<string, unknown> = {}) => ({
  name: 'e2b__e2b/mobile-reconnect-cloud-project',
  displayName: 'mobile-reconnect-cloud-project',
  path: '/home/user/mobile-reconnect-cloud-project',
  fullPath: '/home/user/mobile-reconnect-cloud-project',
  kind: 'cloud',
  runtime: 'e2b',
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: [
    {
      id: 'cloud-mobile-codex-session',
      summary: 'Cloud Mobile Codex Session',
      name: 'Cloud Mobile Codex Session',
      title: 'Cloud Mobile Codex Session',
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
    sandboxId: 'e2b/mobile-reconnect-cloud-project',
    status: 'running',
    repoUrl: 'https://github.com/test-owner/mobile-reconnect-cloud-project.git',
    branch: 'main',
    workspacePath: '/home/user/mobile-reconnect-cloud-project',
    createdAt: now,
    lastActivity: now,
  },
  ...overrides,
});

type MockSessionOptions = {
  project: ReturnType<typeof buildLocalProject> | ReturnType<typeof buildCloudProject>;
  sessionId: string;
  sessionProvider: 'codex';
  runtime: 'local' | 'e2b';
};

async function installVisibilityHarness(page: Page) {
  await page.addInitScript(() => {
    let hidden = false;

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });

    (window as typeof window & {
      __visibilityHarness?: {
        setHidden: (nextHidden: boolean) => void;
      };
    }).__visibilityHarness = {
      setHidden(nextHidden: boolean) {
        hidden = nextHidden;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    };
  });
}

async function setDocumentHidden(page: Page, nextHidden: boolean) {
  await page.evaluate((hidden) => {
    const win = window as typeof window & {
      __visibilityHarness?: {
        setHidden: (nextHidden: boolean) => void;
      };
    };

    win.__visibilityHarness?.setHidden(hidden);
  }, nextHidden);
}

async function countCapturedSockets(page: Page, urlFragment: string) {
  return page.evaluate((fragment) => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        sockets: Array<{ url?: string }>;
      };
    };

    return (win.__appSocketTestBridge?.sockets || []).filter((socket) =>
      String(socket?.url || '').includes(fragment),
    ).length;
  }, urlFragment);
}

async function closeLatestCapturedSocket(page: Page, urlFragment: string) {
  await page.evaluate((fragment) => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        sockets: WebSocket[];
      };
    };

    const socket = [...(win.__appSocketTestBridge?.sockets || [])]
      .reverse()
      .find((candidate) => String(candidate?.url || '').includes(fragment));

    socket?.close();
  }, urlFragment);
}

async function mockAuthApis(page: Page) {
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

async function mockSessionApis(page: Page, options: MockSessionOptions) {
  const { project, sessionId, sessionProvider, runtime } = options;
  const sessionCollection = runtime === 'e2b' ? project.e2bSessions : project.codexSessions;
  const session = sessionCollection?.find((entry) => entry.id === sessionId);

  if (!session) {
    throw new Error(`Unable to locate mock session ${sessionId}`);
  }

  await mockAuthApis(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [project] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: runtime === 'e2b' ? 'e2b' : sessionProvider,
        project,
        session: {
          ...session,
          __provider: sessionProvider,
          __runtime: runtime,
          __projectName: project.name,
          __projectPath: runtime === 'e2b'
            ? project.cloud?.workspacePath || project.fullPath
            : project.fullPath,
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

  return { project, session };
}

test.describe('mobile reconnect regressions', () => {
  test('chat reconnect re-checks local session status after websocket reconnect', async ({ page }) => {
    const { session } = await mockSessionApis(page, {
      project: buildLocalProject(),
      sessionId: 'mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'local',
    });

    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/session/mobile-codex-session');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    await closeLatestCapturedSocket(page, '/ws?token=');

    await expect
      .poll(async () => countCapturedSockets(page, '/ws?token='), {
        timeout: 15_000,
        message: 'Expected the chat websocket to reconnect after a disconnect.',
      })
      .toBeGreaterThan(1);

    const statusCheck = await waitForLastOutboundSocketMessage(page, {
      type: 'check-session-status',
      timeoutMs: 15_000,
    });

    expect(statusCheck?.parsed).toMatchObject({
      type: 'check-session-status',
      sessionId: session.id,
      provider: 'codex',
    });
  });

  test('chat forces a websocket reconnect for local sessions after returning from background on mobile', async ({ page }) => {
    const { session } = await mockSessionApis(page, {
      project: buildLocalProject(),
      sessionId: 'mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'local',
    });

    await installVisibilityHarness(page);
    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/session/mobile-codex-session');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    const socketCountBefore = await countCapturedSockets(page, '/ws?token=');

    await setDocumentHidden(page, true);
    await page.waitForTimeout(5_300);
    await setDocumentHidden(page, false);

    await expect
      .poll(async () => countCapturedSockets(page, '/ws?token='), {
        timeout: 15_000,
        message: 'Expected the chat websocket to be replaced after a long background pause.',
      })
      .toBeGreaterThan(socketCountBefore);

    const statusCheck = await waitForLastOutboundSocketMessage(page, {
      type: 'check-session-status',
      timeoutMs: 15_000,
    });

    expect(statusCheck?.parsed).toMatchObject({
      type: 'check-session-status',
      sessionId: session.id,
      provider: 'codex',
    });
  });

  test('shell tab auto-resumes the selected local session', async ({ page }) => {
    const { session } = await mockSessionApis(page, {
      project: buildLocalProject(),
      sessionId: 'mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'local',
    });

    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/session/mobile-codex-session');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    await page.getByRole('button', { name: /shell/i }).click();

    const shellInit = await waitForLastOutboundSocketMessage(page, {
      type: 'init',
      timeoutMs: 15_000,
    });

    expect(shellInit?.url).toContain('/shell?token=');
    expect(shellInit?.parsed).toMatchObject({
      type: 'init',
      sessionId: session.id,
      hasSession: true,
      provider: 'codex',
      projectRuntime: 'local',
    });
  });

  test('shell keeps project-terminal mode when no session is selected', async ({ page }) => {
    await mockSessionApis(page, {
      project: buildLocalProject(),
      sessionId: 'mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'local',
    });

    await installVisibilityHarness(page);
    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await page.getByRole('button', { name: /shell/i }).click();

    const firstInit = await waitForLastOutboundSocketMessage(page, {
      type: 'init',
      timeoutMs: 15_000,
    });
    expect(firstInit?.url).toContain('/ws/project-terminal');
    expect(firstInit?.parsed).toMatchObject({
      type: 'init',
      hasSession: false,
      projectRuntime: 'local',
    });

    await clearOutboundSocketMessages(page);
    const socketCountBefore = await countCapturedSockets(page, '/ws/project-terminal');

    await setDocumentHidden(page, true);
    await page.waitForTimeout(5_300);
    await setDocumentHidden(page, false);

    await expect
      .poll(async () => countCapturedSockets(page, '/ws/project-terminal'), {
        timeout: 15_000,
        message: 'Expected the project terminal websocket to reconnect after returning to the page.',
      })
      .toBeGreaterThan(socketCountBefore);

    const reconnectInit = await waitForLastOutboundSocketMessage(page, {
      type: 'init',
      timeoutMs: 15_000,
    });
    expect(reconnectInit?.parsed).toMatchObject({
      type: 'init',
      projectName: 'mobile-reconnect-project',
      hasSession: false,
      projectRuntime: 'local',
    });
  });

  test('chat forces a websocket reconnect for e2b sessions after returning from background on mobile', async ({ page }) => {
    const { session } = await mockSessionApis(page, {
      project: buildCloudProject(),
      sessionId: 'cloud-mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'e2b',
    });

    await installVisibilityHarness(page);
    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/session/cloud-mobile-codex-session');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    const socketCountBefore = await countCapturedSockets(page, '/ws?token=');

    await setDocumentHidden(page, true);
    await page.waitForTimeout(5_300);
    await setDocumentHidden(page, false);

    await expect
      .poll(async () => countCapturedSockets(page, '/ws?token='), {
        timeout: 15_000,
        message: 'Expected the e2b chat websocket to be replaced after a long background pause.',
      })
      .toBeGreaterThan(socketCountBefore);

    const statusCheck = await waitForLastOutboundSocketMessage(page, {
      type: 'check-session-status',
      timeoutMs: 15_000,
    });

    expect(statusCheck?.parsed).toMatchObject({
      type: 'check-session-status',
      sessionId: session.id,
      provider: 'e2b',
    });
  });

  test('shell tab auto-resumes and reconnects the selected e2b session', async ({ page }) => {
    const { session } = await mockSessionApis(page, {
      project: buildCloudProject(),
      sessionId: 'cloud-mobile-codex-session',
      sessionProvider: 'codex',
      runtime: 'e2b',
    });

    await installVisibilityHarness(page);
    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto('/session/cloud-mobile-codex-session');
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    await page.getByRole('button', { name: /shell/i }).click();

    const firstInit = await waitForLastOutboundSocketMessage(page, {
      type: 'init',
      timeoutMs: 15_000,
    });
    expect(firstInit?.url).toContain('/ws/project-terminal');
    expect(firstInit?.parsed).toMatchObject({
      type: 'init',
      sessionId: session.id,
      hasSession: true,
      provider: 'codex',
      projectRuntime: 'e2b',
      terminalKey: `session:${session.id}`,
    });

    await clearOutboundSocketMessages(page);
    const socketCountBefore = await countCapturedSockets(page, '/ws/project-terminal');

    await setDocumentHidden(page, true);
    await page.waitForTimeout(5_300);
    await setDocumentHidden(page, false);

    await expect
      .poll(async () => countCapturedSockets(page, '/ws/project-terminal'), {
        timeout: 15_000,
        message: 'Expected the e2b session shell websocket to reconnect after returning to the page.',
      })
      .toBeGreaterThan(socketCountBefore);

    const reconnectInit = await waitForLastOutboundSocketMessage(page, {
      type: 'init',
      timeoutMs: 15_000,
    });
    expect(reconnectInit?.parsed).toMatchObject({
      type: 'init',
      sessionId: session.id,
      hasSession: true,
      provider: 'codex',
      projectRuntime: 'e2b',
      terminalKey: `session:${session.id}`,
    });
  });
});
