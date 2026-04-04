import { expect, test } from '@playwright/test';
import { e2eUsername, getE2EPassword } from './support/config';

test.use({ storageState: { cookies: [], origins: [] } });

test('login form authenticates and renders the workspace shell', async ({ page }) => {
  const password = getE2EPassword();

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.getByTestId('auth-input-username').fill(e2eUsername);
  await page.getByTestId('auth-input-password').fill(password);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('sidebar-root')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('auth-token'))).not.toBeNull();
});
