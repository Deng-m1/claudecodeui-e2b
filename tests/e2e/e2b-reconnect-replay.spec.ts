import { expect, test, type Page } from '@playwright/test';
import {
  startCloudProject,
  submitPrompt,
  waitForAuthenticatedShell,
  waitForProviderActivity,
} from './support/app';

const TURN_ONE_PROMPT = 'Reply with exactly CLOUD_TURN_ONE_OK and nothing else.';
const TURN_TWO_PROMPT = [
  'Quickly inspect the current repository and think through the next answer before responding.',
  'Then reply with exactly CLOUD_TURN_TWO_REPLAY_OK and nothing else.',
].join(' ');

async function waitForSessionHistoryText(page: Page, sessionId: string, expectedText: string) {
  await expect
    .poll(
      async () => {
        return page.evaluate(
          async ({ currentSessionId }) => {
            const token = window.localStorage.getItem('auth-token');
            const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
            const bootstrapResponse = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/bootstrap`, {
              headers: authHeaders,
            });
            const bootstrap = await bootstrapResponse.json();
            const projectName = bootstrap?.project?.name || '';
            const projectPath = bootstrap?.project?.fullPath || bootstrap?.project?.path || '';
            const response = await fetch(
              `/api/sessions/${encodeURIComponent(currentSessionId)}/messages?provider=e2b&projectName=${encodeURIComponent(projectName)}&projectPath=${encodeURIComponent(projectPath)}&limit=50&offset=0`,
              {
                headers: authHeaders,
              },
            );
            const payload = await response.json();
            return JSON.stringify(payload?.messages || []);
          },
          { currentSessionId: sessionId },
        );
      },
      { timeout: 60_000, message: `Expected history for ${sessionId} to contain ${expectedText}` },
    )
    .toContain(expectedText);
}

test('e2b codex supports multi-turn history and survives reload while the next turn is active', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  await page.goto('/');
  await waitForAuthenticatedShell(page);

  await startCloudProject(page, {
    provider: 'codex',
    authProvider: 'codex',
    authMode: 'auto',
    repoQuery: 'claudecodeui-e2b',
    branch: 'main',
  });

  const initialSession = await submitPrompt(page, TURN_ONE_PROMPT);
  expect(initialSession.sessionId).not.toBe('');

  await waitForSessionHistoryText(page, initialSession.sessionId, 'CLOUD_TURN_ONE_OK');
  const secondTurn = await submitPrompt(page, TURN_TWO_PROMPT);
  expect(secondTurn.sessionId).toBe(initialSession.sessionId);

  await waitForProviderActivity(page);
  await page.reload();
  await waitForAuthenticatedShell(page);

  await expect(page.getByTestId('chat-messages-pane')).toContainText(TURN_ONE_PROMPT, { timeout: 30_000 });
  await expect(page.getByTestId('chat-messages-pane')).toContainText('CLOUD_TURN_ONE_OK', { timeout: 30_000 });
  await expect(page.getByTestId('chat-messages-pane')).toContainText(TURN_TWO_PROMPT, { timeout: 30_000 });

  await waitForSessionHistoryText(page, initialSession.sessionId, 'CLOUD_TURN_TWO_REPLAY_OK');


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
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?provider=e2b&projectName=${encodeURIComponent(projectName)}&projectPath=${encodeURIComponent(projectPath)}&limit=50&offset=0`,
        {
          headers: authHeaders,
        },
      );

      return response.json();
    },
    { sessionId: initialSession.sessionId },
  );

  const serializedHistory = JSON.stringify(historyPayload.messages || []);
  expect(serializedHistory).toContain('CLOUD_TURN_ONE_OK');
  expect(serializedHistory).toContain('CLOUD_TURN_TWO_REPLAY_OK');
});
