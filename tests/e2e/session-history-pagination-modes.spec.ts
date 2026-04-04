import { expect, type Page, test } from '@playwright/test';
import {
  clearOutboundSocketMessages,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForWebSocketTestBridge,
} from './support/app';

const now = new Date().toISOString();
const sessionId = 'session-history-modes';
const project = {
  name: 'session-history-modes-project',
  displayName: 'session-history-modes-project',
  path: '/tmp/session-history-modes-project',
  fullPath: '/tmp/session-history-modes-project',
  kind: 'local',
  runtime: 'local',
  sessions: [],
  cursorSessions: [],
  codexSessions: [
    {
      id: sessionId,
      summary: 'Session history modes',
      name: 'Session history modes',
      title: 'Session history modes',
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
    total: 1,
  },
};

function buildBootstrapPayload() {
  return {
    provider: 'codex',
    project,
    session: {
      ...project.codexSessions[0],
      __provider: 'codex',
      __runtime: 'local',
      __projectName: project.name,
      __projectPath: project.fullPath,
    },
  };
}

function buildMessage(index: number, content: string) {
  return {
    id: `message-${index}`,
    seq: index,
    sessionId,
    timestamp: new Date(2026, 3, 1, 0, 0, index).toISOString(),
    provider: 'codex',
    kind: 'text',
    role: index % 2 === 0 ? 'assistant' : 'user',
    content,
  };
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

async function installBaseRoutes(
  page: Page,
  handler: (requestUrl: URL) => Promise<Record<string, unknown>> | Record<string, unknown>,
) {
  await mockAuthApis(page);

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [project] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({ json: buildBootstrapPayload() });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    const payload = await handler(new URL(route.request().url()));
    await route.fulfill({ json: payload });
  });
}

test.describe('session history pagination modes', () => {
  test('initial session load requests bootstrap mode', async ({ page }) => {
    const requests: Array<{ mode: string | null; limit: string | null }> = [];

    await installBaseRoutes(page, (requestUrl) => {
      requests.push({
        mode: requestUrl.searchParams.get('mode'),
        limit: requestUrl.searchParams.get('limit'),
      });

      return {
        messages: [buildMessage(100, 'Bootstrap response')],
        total: 100,
        hasMore: true,
        offset: 0,
        limit: 20,
        lastSeq: 100,
        oldestSeq: 100,
        newestSeq: 100,
        sessionVersion: 1,
        mode: 'bootstrap',
      };
    });

    await page.goto(`/session/${sessionId}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('Bootstrap response');

    expect(requests[0]).toEqual({ mode: 'bootstrap', limit: '20' });
  });

  test('scrolling older history requests before mode with the oldest seq cursor', async ({ page }) => {
    const requests: Array<{ mode: string | null; beforeSeq: string | null }> = [];

    await installBaseRoutes(page, (requestUrl) => {
      const mode = requestUrl.searchParams.get('mode');
      requests.push({
        mode,
        beforeSeq: requestUrl.searchParams.get('beforeSeq'),
      });

      if (mode === 'before') {
        return {
          messages: Array.from({ length: 20 }, (_, index) => buildMessage(61 + index, `Older message ${61 + index}`)),
          total: 100,
          hasMore: true,
          offset: 0,
          limit: 20,
          lastSeq: 100,
          oldestSeq: 61,
          newestSeq: 80,
          sessionVersion: 1,
          mode: 'before',
        };
      }

      return {
        messages: Array.from({ length: 20 }, (_, index) =>
          buildMessage(81 + index, `Recent message ${81 + index} ${'line '.repeat(40)}`),
        ),
        total: 100,
        hasMore: true,
        offset: 0,
        limit: 20,
        lastSeq: 100,
        oldestSeq: 81,
        newestSeq: 100,
        sessionVersion: 1,
        mode: 'bootstrap',
      };
    });

    await page.goto(`/session/${sessionId}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('Recent message 100');

    const pane = page.getByTestId('chat-messages-pane');
    await pane.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });

    await expect
      .poll(() => requests.some((request) => request.mode === 'before' && request.beforeSeq === '81'))
      .toBe(true);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('Older message 61');
  });

  test('websocket reconnect requests delta mode with the last seq and version', async ({ page }) => {
    const requests: Array<{
      mode: string | null;
      afterSeq: string | null;
      sessionVersion: string | null;
    }> = [];

    await installBaseRoutes(page, (requestUrl) => {
      const mode = requestUrl.searchParams.get('mode');
      requests.push({
        mode,
        afterSeq: requestUrl.searchParams.get('afterSeq'),
        sessionVersion: requestUrl.searchParams.get('sessionVersion'),
      });

      if (mode === 'delta') {
        return {
          messages: [buildMessage(101, 'Delta response after reconnect')],
          total: 101,
          hasMore: false,
          offset: 0,
          limit: null,
          lastSeq: 101,
          oldestSeq: 101,
          newestSeq: 101,
          sessionVersion: 1,
          mode: 'delta',
          resetRequired: false,
        };
      }

      return {
        messages: [buildMessage(100, 'Bootstrap seed message')],
        total: 100,
        hasMore: false,
        offset: 0,
        limit: 20,
        lastSeq: 100,
        oldestSeq: 100,
        newestSeq: 100,
        sessionVersion: 1,
        mode: 'bootstrap',
      };
    });

    await installWebSocketTestBridge(page, { passthrough: false });
    await page.goto(`/session/${sessionId}`);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await expect(page.getByTestId('chat-messages-pane')).toContainText('Bootstrap seed message');

    await clearOutboundSocketMessages(page);
    await closeLatestCapturedSocket(page, '/ws?token=');

    await expect
      .poll(async () => countCapturedSockets(page, '/ws?token='), {
        timeout: 15_000,
      })
      .toBeGreaterThan(1);

    await expect
      .poll(() => requests.some((request) => (
        request.mode === 'delta' &&
        request.afterSeq === '100' &&
        request.sessionVersion === '1'
      )), {
        timeout: 15_000,
      })
      .toBe(true);

    await expect(page.getByTestId('chat-messages-pane')).toContainText('Delta response after reconnect');
  });
});
