import { expect, test } from '@playwright/test';
import { startLocalSession, submitPrompt, waitForAuthenticatedShell, waitForProviderActivity } from './support/app';

test('codex keeps the first user message and current project visible during bootstrap and sidebar refresh races', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const { projectName } = await startLocalSession(page, 'codex');

  let bootstrapRequests = 0;
  let delayBootstrap = true;
  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    bootstrapRequests += 1;
    if (delayBootstrap) {
      delayBootstrap = false;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });

  let stripCurrentProjectOnNextRefresh = false;
  await page.route('**/api/projects', async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        page.isClosed() ||
        /Target page, context or browser has been closed/i.test(message)
      ) {
        return;
      }
      throw error;
    }

    if (!stripCurrentProjectOnNextRefresh) {
      await route.fulfill({ response });
      return;
    }

    stripCurrentProjectOnNextRefresh = false;
    const data = await response.json();
    if (!Array.isArray(data)) {
      await route.fulfill({ response });
      return;
    }

    await route.fulfill({
      response,
      json: data.filter((project) => project?.name !== projectName),
    });
  });

  const prompt = `codex-race-${Date.now()}`;
  const session = await submitPrompt(page, prompt, { requirePromptEcho: false });

  await expect(page).toHaveURL(new RegExp(`/session/${session.sessionId}$`));
  await expect(page.getByTestId('chat-messages-pane')).toContainText(prompt);

  await page.waitForTimeout(2500);
  expect(bootstrapRequests).toBe(1);

  stripCurrentProjectOnNextRefresh = true;
  await page.evaluate(() => window.refreshProjects?.());

  await expect(
    page.locator(`[data-testid="sidebar-project-item"][data-project-name="${projectName}"]:visible`).first(),
  ).toBeVisible();
  await expect(page.getByTestId('chat-messages-pane')).toContainText(prompt);

  await waitForProviderActivity(page);
  await expect(page.getByTestId('chat-messages-pane')).toContainText(prompt);
});
