import { expect, test, type Page } from '@playwright/test';
import {
  startCloudProject,
  submitPrompt,
  waitForAssistantText,
  waitForAuthenticatedShell,
} from './support/app';
import { isLiveCloudEnabled } from './support/config';

const EXACT_REPLY_PROMPT = 'Reply with exactly HELLO_WORLD and nothing else.';
const SAVED_PROFILE_NAME = 'Codex Callback Login 2026-03-31 10:02';

async function runCodexCloudAuthFlow(
  page: Page,
  options: { authMode: 'auto' | 'profile'; profileName?: string },
) {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const launch = await startCloudProject(page, {
    provider: 'codex',
    authProvider: 'codex',
    authMode: options.authMode,
    profileName: options.profileName,
    repoQuery: 'claudecodeui-e2b',
    branch: 'main',
  });

  expect(launch.repoFullName).toContain('claudecodeui-e2b');

  const session = await submitPrompt(page, EXACT_REPLY_PROMPT);
  expect(session.sessionId).not.toBe('');

  const assistantText = await waitForAssistantText(page, 'HELLO_WORLD');
  expect(assistantText).toContain('HELLO_WORLD');
}

test.describe.serial('codex cloud auth paths', () => {
  test.skip(
    !isLiveCloudEnabled('codex-cloud'),
    'Set E2E_LIVE_CLOUD=codex-cloud (or =all) to run these live Codex cloud auth flows.',
  );

  test('host snapshot auth launches cloud codex and returns text', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    await runCodexCloudAuthFlow(page, { authMode: 'auto' });
  });

  test('saved auth profile launches cloud codex and returns text', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    await runCodexCloudAuthFlow(page, {
      authMode: 'profile',
      profileName: SAVED_PROFILE_NAME,
    });
  });
});
