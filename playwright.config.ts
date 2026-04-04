import { defineConfig, devices } from '@playwright/test';

const appUrl = process.env.E2E_APP_URL || 'http://127.0.0.1:5179';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  globalSetup: './tests/e2e/global.setup.ts',
  use: {
    baseURL: appUrl,
    storageState: 'playwright/.auth/dbj.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: appUrl,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
