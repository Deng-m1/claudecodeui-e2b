import { expect, test } from '@playwright/test';
import {
  injectSocketMessage,
  installWebSocketTestBridge,
  waitForAuthenticatedShell,
  waitForWebSocketTestBridge,
} from './support/app';

const beforeTs = '2026-04-01T00:00:01.000Z';
const toolTs = '2026-04-01T00:00:02.000Z';
const toolResultTs = '2026-04-01T00:00:03.000Z';
const afterTs = '2026-04-01T00:00:04.000Z';

async function mockAuthApis(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      json: {
        registrationDisabled: false,
        setupLocked: false,
        needsSetup: false,
      },
    });
  });

  await page.route('**/api/auth/user', async (route) => {
    await route.fulfill({
      json: {
        user: {
          username: 'dbj',
        },
      },
    });
  });

  await page.route('**/api/user/onboarding-status', async (route) => {
    await route.fulfill({
      json: {
        hasCompletedOnboarding: true,
      },
    });
  });
}

async function mockSessionApis(
  page: import('@playwright/test').Page,
  sessionId: string,
  project: Record<string, unknown>,
  serverMessages: Array<Record<string, unknown>>,
) {
  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [project] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'codex',
        project,
        session: {
          ...(project.codexSessions as Array<Record<string, unknown>>)[0],
          __provider: 'codex',
          __runtime: 'local',
          __projectName: project.name,
          __projectPath: project.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    await route.fulfill({
      json: {
        messages: serverMessages,
        total: serverMessages.length,
        hasMore: false,
        offset: 0,
        limit: 20,
        lastSeq: serverMessages.at(-1)?.seq ?? serverMessages.length,
        oldestSeq: serverMessages[0]?.seq ?? 1,
        newestSeq: serverMessages.at(-1)?.seq ?? serverMessages.length,
        sessionVersion: 1,
        mode: 'bootstrap',
      },
    });
  });
}

test('realtime Bash tool messages stay in chronological position before later assistant text', async ({ page }) => {
  const sessionId = 'tool-order-session';
  const project = {
    name: 'tool-order-project',
    displayName: 'tool-order-project',
    path: '/tmp/tool-order-project',
    fullPath: '/tmp/tool-order-project',
    kind: 'local',
    runtime: 'local',
    sessions: [],
    cursorSessions: [],
    codexSessions: [
      {
        id: sessionId,
        summary: 'tool-order-session',
        name: 'tool-order-session',
        title: 'tool-order-session',
        createdAt: afterTs,
        created_at: afterTs,
        updated_at: afterTs,
        lastActivity: afterTs,
        messageCount: 3,
      },
    ],
    geminiSessions: [],
    e2bSessions: [],
    sessionMeta: {
      hasMore: false,
      total: 1,
    },
  };

  await mockAuthApis(page);
  await installWebSocketTestBridge(page, { passthrough: false });
  await mockSessionApis(page, sessionId, project, [
    {
      id: 'server-before',
      sessionId,
      timestamp: beforeTs,
      provider: 'codex',
      kind: 'text',
      role: 'assistant',
      content: 'Inspecting the recent logs',
      seq: 1,
    },
    {
      id: 'server-after',
      sessionId,
      timestamp: afterTs,
      provider: 'codex',
      kind: 'text',
      role: 'assistant',
      content: 'The log tail is clean',
      seq: 3,
    },
  ]);

  await page.goto(`/session/${sessionId}`);
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  await injectSocketMessage(page, {
    id: 'realtime-tool-use',
    sessionId,
    timestamp: toolTs,
    provider: 'codex',
    kind: 'tool_use',
    toolName: 'Bash',
    toolInput: {
      command: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
    },
    toolId: 'tool-tail',
  });
  await injectSocketMessage(page, {
    id: 'realtime-tool-result',
    sessionId,
    timestamp: toolResultTs,
    provider: 'codex',
    kind: 'tool_result',
    toolId: 'tool-tail',
    content: 'ok',
    isError: false,
  });

  await expect(page.getByTestId('chat-messages-pane')).toContainText("/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'");

  await expect
    .poll(async () => {
      const texts = await page.locator('[data-testid="chat-message-assistant"]').evaluateAll((elements) =>
        elements.map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim()),
      );

      return {
        texts,
        commandIndex: texts.findIndex((text) => text.includes("/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'")),
        finalTextIndex: texts.findIndex((text) => text.includes('The log tail is clean')),
      };
    })
    .toMatchObject({
      commandIndex: 1,
      finalTextIndex: 2,
    });
});

test('legacy exec_command realtime tool messages render as Bash commands instead of parameter blocks', async ({ page }) => {
  const sessionId = 'tool-normalization-session';
  const project = {
    name: 'tool-normalization-project',
    displayName: 'tool-normalization-project',
    path: '/tmp/tool-normalization-project',
    fullPath: '/tmp/tool-normalization-project',
    kind: 'local',
    runtime: 'local',
    sessions: [],
    cursorSessions: [],
    codexSessions: [
      {
        id: sessionId,
        summary: 'tool-normalization-session',
        name: 'tool-normalization-session',
        title: 'tool-normalization-session',
        createdAt: afterTs,
        created_at: afterTs,
        updated_at: afterTs,
        lastActivity: afterTs,
        messageCount: 2,
      },
    ],
    geminiSessions: [],
    e2bSessions: [],
    sessionMeta: {
      hasMore: false,
      total: 1,
    },
  };

  await mockAuthApis(page);
  await installWebSocketTestBridge(page, { passthrough: false });
  await mockSessionApis(page, sessionId, project, [
    {
      id: 'server-before',
      sessionId,
      timestamp: beforeTs,
      provider: 'codex',
      kind: 'text',
      role: 'assistant',
      content: 'Inspecting the recent logs',
      seq: 1,
    },
  ]);

  await page.goto(`/session/${sessionId}`);
  await waitForAuthenticatedShell(page);
  await waitForWebSocketTestBridge(page);

  await injectSocketMessage(page, {
    id: 'legacy-exec-tool-use',
    sessionId,
    timestamp: toolTs,
    provider: 'codex',
    kind: 'tool_use',
    toolName: 'exec_command',
    toolInput: {
      cmd: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
    },
    toolId: 'tool-tail-legacy',
  });

  await expect(page.getByTestId('chat-messages-pane')).toContainText("/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'");
  await expect(page.getByTestId('chat-messages-pane')).not.toContainText('exec_command');
});
