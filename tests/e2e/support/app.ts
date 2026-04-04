import { expect, type Locator, type Page } from '@playwright/test';
import { preferredProjectQuery } from './config';

export type LiveProject = {
  name: string;
  displayName?: string;
  runtime?: string;
  kind?: string;
  sessions?: Array<{ id: string }>;
  cursorSessions?: Array<{ id: string }>;
  codexSessions?: Array<{ id: string }>;
  geminiSessions?: Array<{ id: string }>;
  cloud?: {
    sandboxId?: string | null;
    branch?: string | null;
    repoUrl?: string | null;
    workspacePath?: string | null;
  } | null;
  e2bSessions?: Array<{ id: string }>;
};

type WebSocketBridgeOptions = {
  passthrough?: boolean;
};

type OutboundSocketMessage = {
  url: string;
  raw: string;
  parsed: Record<string, unknown> | null;
  at: number;
};

type CloudAuthMode = 'auto' | 'profile';

type StartCloudProjectOptions = {
  provider?: string;
  authProvider?: string;
  authMode?: CloudAuthMode;
  profileName?: string;
  repoQuery?: string;
  branch?: string;
};

export async function waitForAuthenticatedShell(page: Page) {
  await expect(page.getByTestId('sidebar-root')).toBeVisible();
  await expect(page.getByTestId('sidebar-projects-loading')).toBeHidden({ timeout: 30_000 }).catch(() => {});
  await expect(page.getByTestId('main-content-loading')).toBeHidden({ timeout: 30_000 }).catch(() => {});
}

export async function openSessionLauncher(page: Page) {
  const trigger = page.locator('[data-testid="open-session-launcher"]:visible').first();
  const startedAt = Date.now();
  await trigger.click();
  await expect(page.getByTestId('session-launcher')).toBeVisible({ timeout: 5_000 });
  return Date.now() - startedAt;
}

export async function startLocalSession(page: Page, provider: string) {
  const launcherOpenMs = await openSessionLauncher(page);
  await page.getByTestId('launcher-mode-local').click();
  await page.locator(`[data-testid="launcher-provider-card"][data-provider-id="${provider}"]`).click();

  const projectOptions = page.locator('[data-testid="launcher-local-project"]:visible');
  const preferredProject = projectOptions.filter({ hasText: preferredProjectQuery }).first();
  const project = (await preferredProject.count()) > 0 ? preferredProject : projectOptions.first();
  await expect(project).toBeVisible();
  const projectName = (await project.getAttribute('data-project-name')) || '';

  await project.click();
  await page.getByTestId('launcher-start-local').click();
  await expect(page.getByTestId('session-launcher')).toBeHidden({ timeout: 5_000 });
  await expect(page.getByTestId('sidebar-projects-loading')).toBeHidden({ timeout: 30_000 }).catch(() => {});
  await expect(page.getByTestId('main-content-loading')).toBeHidden({ timeout: 30_000 }).catch(() => {});
  await expect(page.getByTestId('chat-composer-textarea')).toBeVisible();

  return { launcherOpenMs, projectName };
}

export async function ensureProjectExpanded(page: Page, projectName?: string) {
  const newSessionButton = projectName
    ? page.locator(`[data-testid="project-new-session"][data-project-name="${projectName}"]:visible`).first()
    : page.locator('[data-testid="project-new-session"]:visible').first();
  const projectToggle = projectName
    ? page.locator(`[data-testid="sidebar-project-toggle"][data-project-name="${projectName}"]:visible`).first()
    : page.locator('[data-testid="sidebar-project-toggle"]:visible').first();
  const projectItem = projectName
    ? page.locator(`[data-testid="sidebar-project-item"][data-project-name="${projectName}"]:visible`).first()
    : page.locator('[data-testid="sidebar-project-item"]:visible').first();

  if (!(await newSessionButton.isVisible().catch(() => false))) {
    if (await projectToggle.isVisible().catch(() => false)) {
      await projectToggle.click();
    } else {
      await projectItem.click();
    }
  }

  await expect(newSessionButton).toBeVisible();
  return newSessionButton;
}

export async function toggleProjectExpansion(page: Page, projectName: string) {
  const projectToggle = page.locator(
    `[data-testid="sidebar-project-toggle"][data-project-name="${projectName}"]:visible`,
  ).first();

  if (await projectToggle.isVisible().catch(() => false)) {
    await projectToggle.click();
    return;
  }

  await page.locator(`[data-testid="sidebar-project-item"][data-project-name="${projectName}"]:visible`).first().click();
}

export async function fetchLiveProjects(page: Page): Promise<LiveProject[]> {
  return page.evaluate(async () => {
    const token = window.localStorage.getItem('auth-token');
    const response = await fetch('/api/projects', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    return (await response.json()) as LiveProject[];
  });
}

export async function getSidebarProjectNames(page: Page) {
  return page.locator('[data-testid="sidebar-project-item"]').evaluateAll((elements) => {
    const names = elements
      .map((element) => (element as HTMLElement).dataset.projectName || '')
      .filter(Boolean);

    return Array.from(new Set(names));
  });
}

export async function setSidebarProviderFilter(page: Page, provider: 'all' | 'claude' | 'cursor' | 'codex' | 'gemini') {
  const filterButton = page.locator(`[data-testid="sidebar-provider-filter"][data-provider-id="${provider}"]:visible`).first();
  await expect(filterButton).toBeVisible();
  await filterButton.click();
  await expect(filterButton).toHaveAttribute('aria-pressed', 'true');
}

export async function getVisibleSidebarSessionIds(page: Page) {
  return page.locator('[data-testid="sidebar-session-item"]').evaluateAll((elements) => {
    const ids = elements
      .map((element) => (element as HTMLElement).dataset.sessionId || '')
      .filter(Boolean);

    return Array.from(new Set(ids));
  });
}

export async function installWebSocketTestBridge(
  page: Page,
  options: WebSocketBridgeOptions = {},
) {
  const { passthrough = true } = options;

  await page.addInitScript(({ nextPassthrough }) => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        sockets: WebSocket[];
        outbound: Array<{
          url: string;
          raw: string;
          parsed: Record<string, unknown> | null;
          at: number;
        }>;
        injectMessage: (payload: unknown) => void;
        clearOutbound: () => void;
      };
    };

    const OriginalWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const outbound: Array<{
      url: string;
      raw: string;
      parsed: Record<string, unknown> | null;
      at: number;
    }> = [];

    class InterceptedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);

        if (String(url).includes('/ws') || String(url).includes('/shell')) {
          sockets.push(this);

          const nativeSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            const raw = typeof data === 'string' ? data : '';
            let parsed: Record<string, unknown> | null = null;

            if (raw) {
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                parsed = null;
              }
            }

            outbound.push({
              url: String(url),
              raw,
              parsed,
              at: Date.now(),
            });

            if (nextPassthrough) {
              nativeSend(data);
            }
          };
        }
      }
    }

    win.__appSocketTestBridge = {
      sockets,
      outbound,
      injectMessage(payload) {
        const event = new MessageEvent('message', {
          data: JSON.stringify(payload),
        });

        for (const socket of sockets) {
          socket.onmessage?.(event);
        }
      },
      clearOutbound() {
        outbound.length = 0;
      },
    };

    window.WebSocket = InterceptedWebSocket as typeof window.WebSocket;
  }, { nextPassthrough: passthrough });
}

export async function injectProjectsUpdated(
  page: Page,
  projects: LiveProject[],
  extra: Record<string, unknown> = {},
) {
  await injectSocketMessage(page, {
    type: 'projects_updated',
    projects,
    ...extra,
  });
}

export async function injectSocketMessage(page: Page, payload: Record<string, unknown>) {
  await page.evaluate(
    ({ nextPayload }) => {
      const win = window as typeof window & {
        __appSocketTestBridge?: {
          injectMessage: (payload: unknown) => void;
        };
      };

      win.__appSocketTestBridge?.injectMessage(nextPayload);
    },
    { nextPayload: payload },
  );
}

export async function clearOutboundSocketMessages(page: Page) {
  await page.evaluate(() => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        clearOutbound: () => void;
      };
    };

    win.__appSocketTestBridge?.clearOutbound();
  });
}

export async function getOutboundSocketMessages(page: Page): Promise<OutboundSocketMessage[]> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __appSocketTestBridge?: {
        outbound: OutboundSocketMessage[];
      };
    };

    return [...(win.__appSocketTestBridge?.outbound || [])];
  });
}

export async function waitForLastOutboundSocketMessage(
  page: Page,
  options: { type?: string; timeoutMs?: number } = {},
) {
  const { type, timeoutMs = 15_000 } = options;

  await expect
    .poll(
      async () => {
        const messages = await getOutboundSocketMessages(page);
        const matchingMessages = type
          ? messages.filter((message) => message.parsed?.type === type)
          : messages;
        return matchingMessages.at(-1) || null;
      },
      {
        timeout: timeoutMs,
        message: type
          ? `Expected an outbound WebSocket message of type "${type}".`
          : 'Expected an outbound WebSocket message.',
      },
    )
    .not.toBeNull();

  const messages = await getOutboundSocketMessages(page);
  const matchingMessages = type
    ? messages.filter((message) => message.parsed?.type === type)
    : messages;

  return matchingMessages.at(-1) || null;
}

export async function waitForWebSocketTestBridge(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const win = window as typeof window & {
            __appSocketTestBridge?: {
              sockets: WebSocket[];
            };
          };

          const sockets = win.__appSocketTestBridge?.sockets || [];
          return sockets.some((socket) => typeof socket.onmessage === 'function');
        }),
      {
        timeout: 15_000,
        message: 'Expected the app WebSocket bridge to capture an active socket before injecting messages.',
      },
    )
    .toBe(true);
}

export function attachBrowserErrorRecorder(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const handleConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  };
  const handlePageError = (error: Error) => {
    pageErrors.push(error.message);
  };

  page.on('console', handleConsole);
  page.on('pageerror', handlePageError);

  return {
    consoleErrors,
    pageErrors,
    dispose() {
      page.off('console', handleConsole);
      page.off('pageerror', handlePageError);
    },
  };
}

export async function getProjectExpandedState(page: Page, projectName: string) {
  const projectItem = page
    .locator(`[data-testid="sidebar-project-item"][data-project-name="${projectName}"]:visible`)
    .first();
  await expect(projectItem).toBeVisible();
  return (await projectItem.getAttribute('aria-expanded')) === 'true';
}

export async function submitPrompt(page: Page, prompt: string, options: { requirePromptEcho?: boolean } = {}) {
  const { requirePromptEcho = true } = options;
  const textarea = page.getByTestId('chat-composer-textarea').first();
  const submit = page.getByTestId('chat-composer-submit').first();
  const startedAt = Date.now();

  await expect(textarea).toBeVisible({ timeout: 30_000 });
  await expect(textarea).toBeEditable({ timeout: 30_000 });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await textarea.click({ timeout: 5_000 });
      await textarea.fill(prompt, { timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }

      await page.waitForTimeout(1_000);
      await expect(textarea).toBeVisible({ timeout: 10_000 });
      await expect(textarea).toBeEditable({ timeout: 10_000 });
    }
  }

  await submit.click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/session\/[^/]+$/);
  if (requirePromptEcho) {
    await expect(page.getByTestId('chat-messages-pane')).toContainText(prompt);
  }

  const sessionId = page.url().match(/\/session\/([^/?#]+)/)?.[1];
  return {
    sessionId: sessionId || '',
    submitMs: Date.now() - startedAt,
  };
}

async function selectOptionByPartialLabel(locator: Locator, partialLabel: string) {
  await expect
    .poll(
      async () =>
        locator.evaluate((element, expectedText) => {
          const select = element as HTMLSelectElement;
          const match = Array.from(select.options).find((option) => option.textContent?.includes(expectedText));
          return match?.value || '';
        }, partialLabel),
      {
        timeout: 30_000,
        message: `Expected saved profile option containing "${partialLabel}" to appear.`,
      },
    )
    .not.toBe('');

  const optionValue = await locator.evaluate((element, expectedText) => {
    const select = element as HTMLSelectElement;
    const match = Array.from(select.options).find((option) => option.textContent?.includes(expectedText));
    return match?.value || '';
  }, partialLabel);

  if (!optionValue) {
    throw new Error(`Could not find a select option containing "${partialLabel}"`);
  }

  await locator.selectOption(optionValue);
}

function normalizeCloudProjectSearch(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function isLiveCloudProject(project: LiveProject) {
  return project.runtime === 'e2b' || Boolean(project.cloud) || (project.e2bSessions?.length || 0) > 0;
}

function rankLiveCloudProject(project: LiveProject, repoQuery: string, branch: string) {
  const normalizedQuery = normalizeCloudProjectSearch(repoQuery);
  const normalizedBranch = normalizeCloudProjectSearch(branch);
  let score = 0;

  const searchableValues = [
    project.name,
    project.displayName,
    project.cloud?.repoUrl,
    project.cloud?.workspacePath,
  ].map((value) => normalizeCloudProjectSearch(value));

  if (normalizedQuery && searchableValues.some((value) => value.includes(normalizedQuery))) {
    score += 4;
  }

  if (normalizedBranch && normalizeCloudProjectSearch(project.cloud?.branch) === normalizedBranch) {
    score += 2;
  }

  score += Math.min(project.e2bSessions?.length || 0, 3);
  return score;
}

async function reuseExistingCloudProject(
  page: Page,
  options: Pick<StartCloudProjectOptions, 'repoQuery' | 'branch' | 'provider'>,
  launcherOpenMs: number,
) {
  const repoQuery = options.repoQuery || preferredProjectQuery;
  const branch = options.branch || 'main';
  const provider = options.provider || 'codex';
  const closeButton = page.getByTestId('launcher-close');

  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await expect(page.getByTestId('session-launcher')).toBeHidden({ timeout: 10_000 });
  }

  await waitForAuthenticatedShell(page);

  await page.evaluate((nextProvider) => {
    window.localStorage.setItem('selected-provider', nextProvider);
    window.localStorage.setItem('runtime-mode', 'e2b');
    window.dispatchEvent(new CustomEvent('claudecodeui:launch-config', {
      detail: {
        provider: nextProvider,
        runtimeMode: 'e2b',
      },
    }));
  }, provider);

  const sidebarSearch = page.locator('[data-testid="sidebar-search"]:visible').first();
  if (await sidebarSearch.isVisible().catch(() => false)) {
    await sidebarSearch.fill('');
  }

  const providerFilterAll = page.locator('[data-testid="sidebar-provider-filter"][data-provider-id="all"]:visible').first();
  if (await providerFilterAll.isVisible().catch(() => false)) {
    await providerFilterAll.click().catch(() => {});
  }

  const liveProjects = (await fetchLiveProjects(page)).filter(isLiveCloudProject);
  const rankedProjects = [...liveProjects].sort((left, right) => {
    const scoreDiff = rankLiveCloudProject(right, repoQuery, branch) - rankLiveCloudProject(left, repoQuery, branch);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return (right.e2bSessions?.length || 0) - (left.e2bSessions?.length || 0);
  });

  const targetProject = rankedProjects[0];
  if (!targetProject) {
    throw new Error(
      'Cloud launcher could not load GitHub repositories, and no existing E2B project is available to reuse in this environment.',
    );
  }

  const newSessionButton = await ensureProjectExpanded(page, targetProject.name);
  await newSessionButton.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('chat-composer-textarea')).toBeVisible({ timeout: 30_000 });

  return {
    launcherOpenMs,
    repoFullName: targetProject.cloud?.repoUrl || targetProject.displayName || targetProject.name,
    branch: targetProject.cloud?.branch || branch,
  };
}

export async function startCloudProject(page: Page, options: StartCloudProjectOptions = {}) {
  const {
    provider = 'codex',
    authProvider = provider,
    authMode = 'auto',
    profileName,
    repoQuery = preferredProjectQuery,
    branch = 'main',
  } = options;

  const launcherOpenMs = await openSessionLauncher(page);
  await page.getByTestId('launcher-mode-cloud').click();
  await page.locator(`[data-testid="launcher-provider-card"][data-provider-id="${provider}"]`).click();

  const authCard = page.locator(
    `[data-testid="launcher-cloud-auth-card"][data-provider-id="${authProvider}"]`,
  ).first();
  await expect(authCard).toBeVisible();

  if (authMode === 'profile') {
    const profileToggle = page.locator(
      `[data-testid="launcher-cloud-auth-profile"][data-provider-id="${authProvider}"]`,
    ).first();
    await profileToggle.click();

    const profileSelect = page.locator(
      `[data-testid="launcher-cloud-auth-profile-select"][data-provider-id="${authProvider}"]`,
    ).first();
    await expect(profileSelect).toBeVisible();
    if (profileName) {
      await selectOptionByPartialLabel(profileSelect, profileName);
    }
  } else {
    await page
      .locator(`[data-testid="launcher-cloud-auth-auto"][data-provider-id="${authProvider}"]`)
      .first()
      .click();
  }

  const repoSearch = page.getByTestId('launcher-repo-search');
  await expect(repoSearch).toBeVisible({ timeout: 5_000 }).catch(() => {});

  if (!(await repoSearch.isVisible().catch(() => false))) {
    return reuseExistingCloudProject(page, { repoQuery, branch, provider }, launcherOpenMs);
  }

  await repoSearch.fill(repoQuery);

  const repoOption = page.getByTestId('launcher-repo-option').filter({ hasText: repoQuery }).first();
  await expect(repoOption).toBeVisible({ timeout: 30_000 });
  const repoFullName = (await repoOption.getAttribute('data-repo-full-name')) || repoQuery;
  await repoOption.click();

  const branchSelect = page.getByTestId('launcher-branch-select');
  await expect(branchSelect).toBeEnabled({ timeout: 30_000 });
  if ((await branchSelect.inputValue()) !== branch) {
    await branchSelect.selectOption(branch);
  }

  const startCloudButton = page.getByTestId('launcher-start-cloud');
  await expect(startCloudButton).toBeEnabled();
  await startCloudButton.click();

  await expect(page.getByTestId('session-launcher')).toBeHidden({ timeout: 180_000 });
  await expect(page.getByTestId('chat-composer-textarea')).toBeVisible({ timeout: 180_000 });

  return { launcherOpenMs, repoFullName, branch };
}

export async function waitForAssistantText(
  page: Page,
  expectedText: string,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs || 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = '';

  while (Date.now() < deadline) {
    const allowOnce = page.getByTestId('chat-permission-allow-once').first();
    if (await allowOnce.isVisible().catch(() => false)) {
      await allowOnce.click().catch(() => {});
    }

    const assistantText = (await page.locator('[data-testid="chat-message-assistant"]').allTextContents()).join('\n');
    const errorText = (await page.locator('[data-testid="chat-message-error"]').allTextContents()).join('\n');
    const statusText = (await page.getByTestId('chat-status-card').textContent().catch(() => '')) || '';

    lastSnapshot = [
      `url=${page.url()}`,
      `assistant=${assistantText}`,
      `error=${errorText}`,
      `status=${statusText}`,
    ].join('\n');

    if (assistantText.includes(expectedText)) {
      return assistantText;
    }

    if (errorText.trim()) {
      throw new Error(`Assistant flow returned an error before "${expectedText}".\n${lastSnapshot}`);
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`Timed out waiting for assistant text "${expectedText}".\n${lastSnapshot}`);
}

export async function waitForProviderActivity(page: Page) {
  const checks = [
    ['status', page.getByTestId('chat-status-card')],
    ['permission', page.getByTestId('chat-permission-banner')],
    ['assistant', page.getByTestId('chat-message-assistant').first()],
  ] as const;

  let activity: string | null = null;
  await expect
    .poll(
      async () => {
        for (const [label, locator] of checks) {
          if (await locator.isVisible().catch(() => false)) {
            activity = label;
            return label;
          }
        }

        return null;
      },
      {
        timeout: 20_000,
        message: 'Expected assistant activity, permission UI, or processing status.',
      },
    )
    .not.toBeNull();

  return activity;
}

export async function switchToSession(page: Page, sessionId: string, projectName?: string) {
  await ensureProjectExpanded(page, projectName);
  const sessionItem = page.locator(`[data-testid="sidebar-session-item"][data-session-id="${sessionId}"]:visible`).first();
  await expect(sessionItem).toBeVisible();
  await sessionItem.click();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
}
