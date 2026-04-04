import { expect, test } from '@playwright/test';
import { openSessionLauncher, waitForAuthenticatedShell } from './support/app';

test('launcher covers local, cloud, and project modes with stable repo and branch selection', async ({ page }) => {
  await page.goto('/');
  await waitForAuthenticatedShell(page);

  const launcherOpenMs = await openSessionLauncher(page);
  expect(launcherOpenMs).toBeLessThan(5_000);

  await page.locator('[data-testid="launcher-provider-card"][data-provider-id="codex"]').click();
  await expect(page.getByTestId('launcher-model-select')).toBeVisible();

  await page.getByTestId('launcher-mode-project').click();
  await expect(page.getByTestId('launcher-open-project-wizard')).toBeVisible();

  await page.getByTestId('launcher-mode-cloud').click();
  const repoSearch = page.getByTestId('launcher-repo-search');
  await expect(repoSearch).toBeVisible();

  await repoSearch.fill('claudecodeui-e2b');
  const repoOption = page.getByTestId('launcher-repo-option').first();
  await expect(repoOption).toBeVisible({ timeout: 20_000 });
  await repoOption.click();

  const branchSelect = page.getByTestId('launcher-branch-select');
  await expect(branchSelect).toBeEnabled({ timeout: 20_000 });
  await expect.poll(() => branchSelect.inputValue()).not.toBe('');
  await expect(page.getByTestId('launcher-start-cloud')).toBeVisible();
});
