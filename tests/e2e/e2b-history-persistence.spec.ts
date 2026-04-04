import { expect, test } from '@playwright/test';
import {
  startCloudProject,
  submitPrompt,
  waitForAssistantText,
  waitForAuthenticatedShell,
} from './support/app';

const EXACT_REPLY_PROMPT = 'Reply with exactly HELLO_WORLD and nothing else.';

test('e2b codex persists history locally and restores it after reload', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);

  await page.goto('/');
  await waitForAuthenticatedShell(page);

  await startCloudProject(page, {
    provider: 'codex',
    authProvider: 'codex',
    authMode: 'auto',
    repoQuery: 'claudecodeui-e2b',
    branch: 'main',
  });

  const session = await submitPrompt(page, EXACT_REPLY_PROMPT);
  expect(session.sessionId).not.toBe('');

  const assistantText = await waitForAssistantText(page, 'HELLO_WORLD');
  expect(assistantText).toContain('HELLO_WORLD');

  await expect(page.getByTestId('chat-status-card')).not.toBeVisible({ timeout: 20_000 });

  const historyPayload = await page.evaluate(
    async ({ sessionId }) => {
      const token = window.localStorage.getItem('auth-token');
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
      const bootstrapResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/bootstrap`, {
        headers: authHeaders,
      });
      const bootstrap = await bootstrapResponse.json();
      const projectName = bootstrap?.project?.name || '';
      const projectPath = bootstrap?.project?.fullPath || bootstrap?.project?.path || '';
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?provider=e2b&projectName=${encodeURIComponent(projectName)}&projectPath=${encodeURIComponent(projectPath)}&limit=20&offset=0`,
        {
          headers: authHeaders,
        },
      );

      return response.json();
    },
    { sessionId: session.sessionId },
  );

  expect(Array.isArray(historyPayload.messages)).toBe(true);
  expect(historyPayload.messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(historyPayload.messages)).toContain('HELLO_WORLD');

  await page.reload();
  await waitForAuthenticatedShell(page);
  await expect(page.getByTestId('chat-messages-pane')).toContainText(EXACT_REPLY_PROMPT, { timeout: 30_000 });
  await expect(page.getByTestId('chat-messages-pane')).toContainText('HELLO_WORLD', { timeout: 30_000 });
  await expect(page.getByTestId('chat-status-card')).not.toBeVisible({ timeout: 10_000 });
});
