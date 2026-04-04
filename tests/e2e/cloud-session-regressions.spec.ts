import { expect, test } from '@playwright/test';
import {
  clearOutboundSocketMessages,
  ensureProjectExpanded,
  injectSocketMessage,
  installWebSocketTestBridge,
  waitForLastOutboundSocketMessage,
  waitForWebSocketTestBridge,
  waitForAuthenticatedShell,
} from './support/app';

const buildCloudProjectPayload = (projectName: string, sessionId: string, label: string) => {
  const now = new Date().toISOString();
  const sandboxSuffix = projectName.split('/').pop() || 'status-race';

  return {
    name: projectName,
    displayName: label,
    path: `/home/user/${label}` ,
    fullPath: `/home/user/${label}` ,
    kind: 'cloud',
    runtime: 'e2b',
    sessions: [],
    cursorSessions: [],
    codexSessions: [],
    geminiSessions: [],
    e2bSessions: [
      {
        id: sessionId,
        summary: label,
        name: label,
        title: label,
        createdAt: now,
        created_at: now,
        updated_at: now,
        lastActivity: now,
        provider: 'codex',
        agent: 'codex',
        runtime: 'e2b',
      },
    ],
    sessionMeta: {
      hasMore: false,
      total: 1,
    },
    cloud: {
      sandboxId: `e2b/${sandboxSuffix}`,
      status: 'running',
      repoUrl: `https://github.com/test-owner/${label}.git`,
      branch: 'main',
      workspacePath: `/home/user/${label}`,
      createdAt: now,
      lastActivity: now,
    },
  };
};

async function mockCloudSessionShell(page: import('@playwright/test').Page, projectPayload: ReturnType<typeof buildCloudProjectPayload>) {
  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [projectPayload] });
  });

  await page.route('**/api/commands/list', async (route) => {
    await route.fulfill({ json: { builtIn: [], custom: [] } });
  });

  await page.route('**/api/sessions/*/bootstrap', async (route) => {
    await route.fulfill({
      json: {
        provider: 'e2b',
        project: projectPayload,
        session: {
          ...projectPayload.e2bSessions[0],
          __provider: 'codex',
          __runtime: 'e2b',
          __projectName: projectPayload.name,
          __projectPath: projectPayload.fullPath,
        },
      },
    });
  });

  await page.route('**/api/sessions/*/messages*', async (route) => {
    await route.fulfill({
      json: {
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: 20,
      },
    });
  });
}

test.describe('cloud session regressions', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });

  test('cloud session timestamps stored as SQLite UTC strings still render as just-created', async ({ page }) => {
    const projectName = 'e2b__e2b/timezonetest123';
    const sessionId = 'cloud-timezone-session';
    const naiveUtcNow = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        json: [
          {
            name: projectName,
            displayName: 'timezone-test',
            path: '/home/user/timezone-test',
            fullPath: '/home/user/timezone-test',
            kind: 'cloud',
            runtime: 'e2b',
            sessions: [],
            cursorSessions: [],
            codexSessions: [],
            geminiSessions: [],
            e2bSessions: [
              {
                id: sessionId,
                summary: 'Timezone check',
                name: 'Timezone check',
                title: 'Timezone check',
                createdAt: naiveUtcNow,
                created_at: naiveUtcNow,
                updated_at: naiveUtcNow,
                lastActivity: naiveUtcNow,
                provider: 'codex',
                agent: 'codex',
                runtime: 'e2b',
              },
            ],
            sessionMeta: {
              hasMore: false,
              total: 1,
            },
            cloud: {
              sandboxId: 'e2b/timezonetest123',
              status: 'running',
              repoUrl: 'https://github.com/test-owner/timezone-test.git',
              branch: 'main',
              workspacePath: '/home/user/timezone-test',
              createdAt: naiveUtcNow,
              lastActivity: naiveUtcNow,
            },
          },
        ],
      });
    });

    await page.goto('/');
    await waitForAuthenticatedShell(page);
    await ensureProjectExpanded(page, projectName);

    const sessionItem = page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionId}"]:visible`).first();
    await expect(sessionItem).toBeVisible();
    await expect(sessionItem).toContainText(/Just now|1 min ago|刚刚|1 分钟前/);
  });

  test('legacy websocket errors clear reasoning state and render an error message for cloud codex sessions', async ({ page }) => {
    const projectName = 'e2b__e2b/legacyerrortest123';
    const sessionId = 'cloud-error-session';
    const now = new Date().toISOString();

    await installWebSocketTestBridge(page);

    const projectPayload = {
      name: projectName,
      displayName: 'legacy-error-test',
      path: '/home/user/legacy-error-test',
      fullPath: '/home/user/legacy-error-test',
      kind: 'cloud',
      runtime: 'e2b',
      sessions: [],
      cursorSessions: [],
      codexSessions: [],
      geminiSessions: [],
      e2bSessions: [
        {
          id: sessionId,
          summary: 'Legacy error check',
          name: 'Legacy error check',
          title: 'Legacy error check',
          createdAt: now,
          created_at: now,
          updated_at: now,
          lastActivity: now,
          provider: 'codex',
          agent: 'codex',
          runtime: 'e2b',
        },
      ],
      sessionMeta: {
        hasMore: false,
        total: 1,
      },
      cloud: {
        sandboxId: 'e2b/legacyerrortest123',
        status: 'running',
        repoUrl: 'https://github.com/test-owner/legacy-error-test.git',
        branch: 'main',
        workspacePath: '/home/user/legacy-error-test',
        createdAt: now,
        lastActivity: now,
      },
    };

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        json: [projectPayload],
      });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      await route.fulfill({
        json: {
          provider: 'e2b',
          project: projectPayload,
          session: {
            ...projectPayload.e2bSessions[0],
            __provider: 'codex',
            __runtime: 'e2b',
            __projectName: projectName,
          },
        },
      });
    });

    await page.goto(`/session/${sessionId}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toBeVisible();
    await waitForWebSocketTestBridge(page);

    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Reasoning',
      canInterrupt: true,
    });

    await expect(page.getByTestId('chat-status-card')).toContainText('Reasoning');

    await injectSocketMessage(page, {
      type: 'error',
      sessionId,
      error: 'Internal agent error: Internal error',
    });

    await expect(page.getByTestId('chat-message-error').last()).toContainText('Internal agent error');
    await expect(page.getByTestId('chat-status-card')).toBeHidden();
  });

  test('late status updates after complete do not reopen reasoning for cloud codex sessions', async ({ page }) => {
    const projectName = 'e2b__e2b/latestatus123';
    const sessionId = 'cloud-late-status-session';
    const now = new Date().toISOString();

    await installWebSocketTestBridge(page);

    const projectPayload = {
      name: projectName,
      displayName: 'late-status-test',
      path: '/home/user/late-status-test',
      fullPath: '/home/user/late-status-test',
      kind: 'cloud',
      runtime: 'e2b',
      sessions: [],
      cursorSessions: [],
      codexSessions: [],
      geminiSessions: [],
      e2bSessions: [
        {
          id: sessionId,
          summary: 'Late status check',
          name: 'Late status check',
          title: 'Late status check',
          createdAt: now,
          created_at: now,
          updated_at: now,
          lastActivity: now,
          provider: 'codex',
          agent: 'codex',
          runtime: 'e2b',
        },
      ],
      sessionMeta: {
        hasMore: false,
        total: 1,
      },
      cloud: {
        sandboxId: 'e2b/latestatus123',
        status: 'running',
        repoUrl: 'https://github.com/test-owner/late-status-test.git',
        branch: 'main',
        workspacePath: '/home/user/late-status-test',
        createdAt: now,
        lastActivity: now,
      },
    };

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        json: [projectPayload],
      });
    });

    await page.route('**/api/sessions/*/bootstrap', async (route) => {
      await route.fulfill({
        json: {
          provider: 'e2b',
          project: projectPayload,
          session: {
            ...projectPayload.e2bSessions[0],
            __provider: 'codex',
            __runtime: 'e2b',
            __projectName: projectName,
          },
        },
      });
    });

    await page.route('**/api/sessions/*/messages*', async (route) => {
      await route.fulfill({
        json: {
          messages: [],
          total: 0,
          hasMore: false,
          offset: 0,
          limit: 20,
        },
      });
    });

    await page.goto(`/session/${sessionId}`);
    await waitForAuthenticatedShell(page);
    await expect(page.getByTestId('chat-messages-pane')).toBeVisible();
    await waitForWebSocketTestBridge(page);

    await injectSocketMessage(page, {
      kind: 'stream_delta',
      sessionId,
      provider: 'codex',
      content: 'HELLO',
    });
    await injectSocketMessage(page, {
      kind: 'stream_delta',
      sessionId,
      provider: 'codex',
      content: '_WORLD',
    });
    await injectSocketMessage(page, {
      kind: 'complete',
      sessionId,
      provider: 'codex',
    });
    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Tokens: {"used":8640}',
    });

    await expect(page.getByTestId('chat-message-assistant').last()).toContainText('HELLO_WORLD');
    await expect(page.getByTestId('chat-status-card')).toBeHidden();
  });
  test('late inactive legacy session-status does not clear an in-flight cloud session banner after submit', async ({ page }) => {
    const projectName = 'e2b__e2b/cloudstatusracefalse123';
    const sessionId = 'cloud-status-race-false-session';
    const projectPayload = buildCloudProjectPayload(projectName, sessionId, 'cloud-status-race-false');

    await installWebSocketTestBridge(page, { passthrough: false });
    await mockCloudSessionShell(page, projectPayload);

    await page.goto('/session/' + sessionId);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);
    await clearOutboundSocketMessages(page);

    await page.getByTestId('chat-composer-textarea').fill('race condition prompt');
    await page.getByTestId('chat-composer-submit').click();

    const outbound = await waitForLastOutboundSocketMessage(page, { type: 'e2b-command' });
    expect(outbound?.parsed?.sessionId).toBe(sessionId);
    await expect(page.getByTestId('chat-status-card')).toBeVisible();

    await injectSocketMessage(page, {
      type: 'session-status',
      sessionId,
      provider: 'e2b',
      isProcessing: false,
    });

    await expect(page.getByTestId('chat-status-card')).toBeVisible();

    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Running tool',
      canInterrupt: true,
    });
    await expect(page.getByTestId('chat-status-card')).toContainText('Running tool');

    await injectSocketMessage(page, {
      kind: 'complete',
      sessionId,
      provider: 'codex',
      exitCode: 0,
    });
    await expect(page.getByTestId('chat-status-card')).toBeHidden();
  });

  test('late active legacy session-status does not reopen a completed cloud session banner', async ({ page }) => {
    const projectName = 'e2b__e2b/cloudstatusracetrue123';
    const sessionId = 'cloud-status-race-true-session';
    const projectPayload = buildCloudProjectPayload(projectName, sessionId, 'cloud-status-race-true');

    await installWebSocketTestBridge(page, { passthrough: false });
    await mockCloudSessionShell(page, projectPayload);

    await page.goto('/session/' + sessionId);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Reasoning',
      canInterrupt: true,
    });
    await expect(page.getByTestId('chat-status-card')).toContainText('Reasoning');

    await injectSocketMessage(page, {
      kind: 'complete',
      sessionId,
      provider: 'codex',
      exitCode: 0,
    });
    await expect(page.getByTestId('chat-status-card')).toBeHidden();

    await injectSocketMessage(page, {
      type: 'session-status',
      sessionId,
      provider: 'e2b',
      isProcessing: true,
    });

    await page.waitForTimeout(250);
    await expect(page.getByTestId('chat-status-card')).toBeHidden();
  });

  test('multi-round cloud tool call flows do not leave the processing banner stuck after completion', async ({ page }) => {
    const projectName = 'e2b__e2b/cloudtoolrounds123';
    const sessionId = 'cloud-tool-rounds-session';
    const projectPayload = buildCloudProjectPayload(projectName, sessionId, 'cloud-tool-rounds');

    await installWebSocketTestBridge(page, { passthrough: false });
    await mockCloudSessionShell(page, projectPayload);

    await page.goto('/session/' + sessionId);
    await waitForAuthenticatedShell(page);
    await waitForWebSocketTestBridge(page);

    await clearOutboundSocketMessages(page);
    await page.getByTestId('chat-composer-textarea').fill('round one');
    await page.getByTestId('chat-composer-submit').click();
    await waitForLastOutboundSocketMessage(page, { type: 'e2b-command' });

    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Planning',
      canInterrupt: true,
    });
    await injectSocketMessage(page, {
      kind: 'tool_use',
      sessionId,
      provider: 'codex',
      toolName: 'Bash',
      toolId: 'round1_tool',
      toolInput: { command: 'pwd' },
    });
    await injectSocketMessage(page, {
      kind: 'tool_result',
      sessionId,
      provider: 'codex',
      toolId: 'round1_tool',
      toolResult: { content: '/home/user/cloud-tool-rounds', isError: false },
    });
    await injectSocketMessage(page, {
      kind: 'text',
      sessionId,
      provider: 'codex',
      role: 'assistant',
      content: 'ROUND_ONE_DONE',
    });
    await injectSocketMessage(page, {
      kind: 'complete',
      sessionId,
      provider: 'codex',
      exitCode: 0,
    });

    await expect(page.getByTestId('chat-messages-pane')).toContainText('ROUND_ONE_DONE');
    await expect(page.getByTestId('chat-status-card')).toBeHidden();

    await clearOutboundSocketMessages(page);
    await page.getByTestId('chat-composer-textarea').fill('round two');
    await page.getByTestId('chat-composer-submit').click();
    await waitForLastOutboundSocketMessage(page, { type: 'e2b-command' });
    await expect(page.getByTestId('chat-status-card')).toBeVisible();

    await injectSocketMessage(page, {
      kind: 'status',
      sessionId,
      provider: 'codex',
      text: 'Applying changes',
      canInterrupt: true,
    });
    await injectSocketMessage(page, {
      kind: 'tool_use',
      sessionId,
      provider: 'codex',
      toolName: 'Edit',
      toolId: 'round2_tool',
      toolInput: { file: 'src/index.ts', old_string: 'old', new_string: 'new' },
    });
    await injectSocketMessage(page, {
      kind: 'tool_result',
      sessionId,
      provider: 'codex',
      toolId: 'round2_tool',
      toolResult: { content: 'Updated src/index.ts', isError: false },
    });
    await injectSocketMessage(page, {
      kind: 'text',
      sessionId,
      provider: 'codex',
      role: 'assistant',
      content: 'ROUND_TWO_DONE',
    });
    await injectSocketMessage(page, {
      kind: 'complete',
      sessionId,
      provider: 'codex',
      exitCode: 0,
    });

    await expect(page.getByTestId('chat-messages-pane')).toContainText('ROUND_TWO_DONE');
    await expect(page.getByTestId('chat-status-card')).toBeHidden();
  });
});
