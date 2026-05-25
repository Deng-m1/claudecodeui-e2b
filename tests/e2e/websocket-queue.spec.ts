import { expect, test } from '@playwright/test';
import { waitForAuthenticatedShell } from './support/app';
import { appUrl } from './support/config';

const now = new Date().toISOString();

// Vite hot-shuffles the port (5179 → 5180/5181…) when another instance is
// already bound, so derive the websocket URL from whatever the harness asked
// Playwright to drive instead of hard-coding 5179.
function expectedWsUrl(token: string): string {
  const url = new URL(appUrl);
  const wsScheme = url.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsScheme}://${url.host}/ws?token=${token}`;
}

test.describe('websocket auth lifecycle', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('connects after login when the auth token becomes available post-mount', async ({ page }) => {
    await page.addInitScript(() => {
      const sockets = [];

      class TrackingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url) {
          this.url = String(url);
          this.readyState = TrackingWebSocket.CONNECTING;
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;
          sockets.push(this);

          setTimeout(() => {
            if (this.readyState !== TrackingWebSocket.CONNECTING) {
              return;
            }

            this.readyState = TrackingWebSocket.OPEN;
            this.onopen?.(new Event('open'));
          }, 0);
        }

        send() {}

        close() {
          if (this.readyState === TrackingWebSocket.CLOSED) {
            return;
          }

          this.readyState = TrackingWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close'));
        }
      }

      window.__wsAuthHarness = {
        sockets,
        urls() {
          return sockets.map((socket) => socket.url);
        },
      };

      window.WebSocket = TrackingWebSocket;
    });

    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        json: {
          registrationDisabled: false,
          setupLocked: false,
          needsSetup: false,
        },
      });
    });

    await page.route('**/api/auth/login', async (route) => {
      await route.fulfill({
        json: {
          token: 'test-token-after-login',
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

    await page.route('**/api/auth/user', async (route) => {
      await route.fulfill({
        json: {
          user: {
            username: 'dbj',
          },
        },
      });
    });

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({ json: [] });
    });

    await page.route('**/api/commands/list', async (route) => {
      await route.fulfill({ json: { builtIn: [], custom: [] } });
    });

    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();

    await page.getByTestId('auth-input-username').fill('dbj');
    await page.getByTestId('auth-input-password').fill('irrelevant-for-mocked-login');
    await page.getByTestId('login-submit').click();

    await waitForAuthenticatedShell(page);

    await expect
      .poll(async () => page.evaluate(() => window.__wsAuthHarness.urls()))
      .toContain(expectedWsUrl('test-token-after-login'));
  });
});

test('queued local submit flushes once the websocket opens', async ({ page }) => {
  await page.addInitScript(() => {
    const sent = [];
    const sockets = [];

    class DeferredWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = String(url);
        this.readyState = DeferredWebSocket.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        sockets.push(this);
      }

      send(data) {
        sent.push(data);
      }

      close() {
        this.readyState = DeferredWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }

    window.__deferredSocketHarness = {
      sent,
      sockets,
      openAll() {
        for (const socket of sockets) {
          if (socket.readyState !== DeferredWebSocket.CONNECTING) {
            continue;
          }

          socket.readyState = DeferredWebSocket.OPEN;
          socket.onopen?.(new Event('open'));
        }
      },
    };

    window.WebSocket = DeferredWebSocket;
  });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({
      json: [
        {
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
        },
      ],
    });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project: {
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
        },
        session: {
          id: 'local-codex-session',
          summary: 'Local Codex Session',
          name: 'Local Codex Session',
          title: 'Local Codex Session',
          createdAt: now,
          created_at: now,
          updated_at: now,
          lastActivity: now,
          messageCount: 2,
          __provider: 'codex',
          __runtime: 'local',
          __projectName: 'local-regression-project',
          __projectPath: '/tmp/local-regression-project',
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
  await expect(page.getByTestId('chat-composer-textarea')).toBeVisible();

  await page.getByTestId('chat-composer-textarea').fill('queue-before-open');
  await page.getByTestId('chat-composer-submit').click();

  await expect
    .poll(async () => page.evaluate(() => window.__deferredSocketHarness.sent.length))
    .toBe(0);

  await page.evaluate(() => {
    window.__deferredSocketHarness.openAll();
  });

  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__deferredSocketHarness.sent
          .map((raw) => JSON.parse(raw))
          .some((payload) => payload.type === 'codex-command' && payload.command === 'queue-before-open'),
      ),
    )
    .toBe(true);

  const payload = await page.evaluate(() => {
    const parsed = window.__deferredSocketHarness.sent.map((raw) => JSON.parse(raw));
    return parsed.find((entry) => entry.type === 'codex-command');
  });

  expect(payload).toMatchObject({
    type: 'codex-command',
    command: 'queue-before-open',
    sessionId: 'local-codex-session',
    options: {
      sessionId: 'local-codex-session',
      resume: true,
    },
  });
});
