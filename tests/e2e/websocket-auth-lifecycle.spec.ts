import { expect, test } from '@playwright/test';
import { e2eUsername, getE2EPassword } from './support/config';

test.use({ storageState: { cookies: [], origins: [] } });

test('websocket connects after login makes the auth token available', async ({ page }) => {
  const password = getE2EPassword();

  await page.addInitScript(() => {
    const sockets: Array<{ url: string; readyState: number }> = [];

    class TrackingWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      readyState = TrackingWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        sockets.push(this);

        queueMicrotask(() => {
          this.readyState = TrackingWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }

      send() {}

      close() {
        this.readyState = TrackingWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }

    window.__wsLifecycleHarness = {
      get urls() {
        return sockets.map((socket) => socket.url);
      },
      get openCount() {
        return sockets.filter((socket) => socket.readyState === TrackingWebSocket.OPEN).length;
      },
    };

    window.WebSocket = TrackingWebSocket as typeof window.WebSocket;
  });

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.getByTestId('auth-input-username').fill(e2eUsername);
  await page.getByTestId('auth-input-password').fill(password);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('sidebar-root')).toBeVisible();

  await expect
    .poll(async () => page.evaluate(() => window.__wsLifecycleHarness.urls.length))
    .toBeGreaterThan(0);

  const urls = await page.evaluate(() => window.__wsLifecycleHarness.urls);
  expect(urls.some((url) => url.includes('/ws?token='))).toBe(true);

  await expect
    .poll(async () => page.evaluate(() => window.__wsLifecycleHarness.openCount))
    .toBeGreaterThan(0);
});
