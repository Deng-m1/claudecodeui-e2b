import { expect, test } from '@playwright/test';
import { getProviderMatrix } from './support/config';
import {
  startLocalSession,
  submitPrompt,
  waitForAuthenticatedShell,
  waitForProviderActivity,
} from './support/app';

for (const provider of getProviderMatrix()) {
  test(`${provider} local session shows activity after first prompt`, async ({ page }) => {
    await page.goto('/');
    await waitForAuthenticatedShell(page);

    await startLocalSession(page, provider);
    const prompt = `browser-provider-${provider}-${Date.now()}`;
    const session = await submitPrompt(page, prompt, { requirePromptEcho: false });

    expect(session.sessionId).not.toBe('');
    expect(session.submitMs).toBeLessThan(15_000);
    await waitForProviderActivity(page);
    await expect(page).toHaveURL(new RegExp(`/session/${session.sessionId}$`));
  });
}
