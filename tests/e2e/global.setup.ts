import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { request, type FullConfig } from '@playwright/test';
import { apiUrl, appOrigin, e2eUsername, getE2EPassword } from './support/config';

async function ensureE2EOwnerUser(username: string, password: string) {
  await import('../../server/load-env.js');
  const [{ userDb, db }] = await Promise.all([
    import('../../server/database/db.js'),
  ]);
  const passwordHash = await bcrypt.hash(password, 12);
  const existingUser = userDb.getUserByUsername(username);

  if (existingUser) {
    db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?').run(passwordHash, existingUser.id);
    return userDb.getUserByUsername(username);
  }

  const firstUser = userDb.getFirstUser();
  if (firstUser?.id) {
    db.prepare('UPDATE users SET username = ?, password_hash = ?, is_active = 1 WHERE id = ?').run(
      username,
      passwordHash,
      firstUser.id,
    );
    return userDb.getUserByUsername(username);
  }

  userDb.createUser(username, passwordHash);
  return userDb.getUserByUsername(username);
}

async function buildDirectAuthToken(username: string, password: string) {
  const user = await ensureE2EOwnerUser(username, password);
  const [{ generateToken }] = await Promise.all([
    import('../../server/middleware/auth.js'),
  ]);

  if (!user) {
    throw new Error(`Failed to provision browser test user ${username}`);
  }

  return generateToken(user);
}

async function waitForApiReady() {
  const startedAt = Date.now();
  const timeoutMs = 120_000;
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    const probe = await request.newContext({ baseURL: apiUrl });
    try {
      const response = await probe.get('/api/auth/status');
      if (response.ok()) {
        await probe.dispose();
        return;
      }
    } catch (error) {
      lastError = error;
    } finally {
      await probe.dispose();
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for API server at ${apiUrl}: ${String(lastError || 'unknown error')}`);
}

export default async function globalSetup(_config: FullConfig) {
  const password = getE2EPassword();
  const authDir = path.join(process.cwd(), 'playwright', '.auth');
  const authFile = path.join(authDir, 'dbj.json');
  await waitForApiReady();
  const requestContext = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  });
  const statusResponse = await requestContext.get('/api/auth/status');
  const statusPayload = await statusResponse.json().catch(() => null);

  if (statusPayload?.setupLocked) {
    await ensureE2EOwnerUser(e2eUsername, password);
  }

  const loginData = {
    username: e2eUsername,
    password,
  };

  let response = await requestContext.post('/api/auth/login', {
    data: loginData,
  });
  let payload = await response.json();

  if (!response.ok || !payload?.token) {
    const registerResponse = await requestContext.post('/api/auth/register', {
      data: loginData,
    });
    const registerPayload = await registerResponse.json().catch(() => null);

    if (registerResponse.ok && registerPayload?.token) {
      response = registerResponse;
      payload = registerPayload;
    } else {
      response = await requestContext.post('/api/auth/login', {
        data: loginData,
      });
      payload = await response.json();
    }
  }
  await requestContext.dispose();

  if (!response.ok || !payload?.token) {
    payload = {
      token: await buildDirectAuthToken(e2eUsername, password),
    };
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
