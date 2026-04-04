import fs from 'node:fs/promises';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import { apiUrl, appOrigin, e2eUsername, getE2EPassword } from './support/config';

export default async function globalSetup(_config: FullConfig) {
  const password = getE2EPassword();
  const authDir = path.join(process.cwd(), 'playwright', '.auth');
  const authFile = path.join(authDir, 'dbj.json');
  const requestContext = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  });

  const response = await requestContext.post('/api/auth/login', {
    data: {
      username: e2eUsername,
      password,
    },
  });
  const payload = await response.json();
  await requestContext.dispose();

  if (!response.ok || !payload?.token) {
    throw new Error(`Browser test login failed: ${JSON.stringify(payload)}`);
  }

  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    authFile,
    JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin: appOrigin,
            localStorage: [
              {
                name: 'auth-token',
                value: payload.token,
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}
