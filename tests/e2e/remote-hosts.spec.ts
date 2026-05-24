import { expect, test } from '@playwright/test';
import { getRemoteHostE2EConfig } from './support/config';
import {
  ensureProjectExpanded,
  fetchLiveProjects,
  submitPrompt,
  waitForAuthenticatedShell,
} from './support/app';

const remoteConfig = getRemoteHostE2EConfig();

test.describe('remote host settings', () => {
  test.skip(!remoteConfig, 'REMOTE_HOST_E2E_* variables are required for remote host browser tests.');

  test('can browse remote directories when setting and registering workspaces', async ({ page, request }) => {
    test.setTimeout(240_000);
    const remote = remoteConfig!;
    const label = `${remote.label}-browse`;

    try {
      await page.goto('/');
      await waitForAuthenticatedShell(page);

      await page.getByTestId('open-settings').click();
      await expect(page.getByTestId('settings-modal')).toBeVisible();
      await page.getByTestId('settings-tab-remoteHosts').click();
      await expect(page.getByTestId('remote-hosts-tab')).toBeVisible();

      await page.getByTestId('remote-hosts-label').fill(label);
      await page.getByTestId('remote-hosts-host').fill(remote.host);
      await page.getByTestId('remote-hosts-port').fill(remote.port);
      await page.getByTestId('remote-hosts-username').fill(remote.username);
      await page.getByTestId('remote-hosts-password').fill(remote.password);

      await page.getByTestId('remote-hosts-browse-form-workspace-root').click();
      await expect(page.getByTestId('remote-hosts-browser-modal')).toBeVisible({ timeout: 30_000 });
      await page.locator('[data-testid="remote-hosts-browser-select-entry"][data-entry-path="/root"]').click();
      await expect(page.getByTestId('remote-hosts-workspace-root')).toHaveValue('/root');

      await page.getByTestId('remote-hosts-bootstrap-trigger').click();
      await expect(page.getByTestId('remote-hosts-bootstrap-result')).toBeVisible({ timeout: 60_000 });

      const hostCard = page.locator('[data-testid="remote-hosts-saved-host"]').filter({ hasText: label }).first();
      await expect(hostCard).toBeVisible({ timeout: 15_000 });

      await hostCard.getByTestId('remote-hosts-browse-host-workspace').click();
      await expect(page.getByTestId('remote-hosts-browser-modal')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('remote-hosts-browser-parent').click();
      await page.locator('[data-testid="remote-hosts-browser-select-entry"][data-entry-path="/tmp"]').click();
      await expect(hostCard.getByTestId('remote-hosts-add-workspace-input')).toHaveValue('/tmp');

      await hostCard.getByTestId('remote-hosts-add-workspace-trigger').click();
      await expect(page.getByTestId('remote-hosts-message')).toContainText(/Remote workspace registered/i, { timeout: 30_000 });
      await expect(hostCard).toContainText('/tmp', { timeout: 15_000 });
    } finally {
      try {
        const token = page.isClosed()
          ? null
          : await page.evaluate(() => window.localStorage.getItem('auth-token'));
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const listResponse = await request.get('/api/remote-hosts', {
          headers,
          timeout: 10_000,
        });
        const listPayload = await listResponse.json().catch(() => null);
        const matchingHosts = Array.isArray(listPayload?.hosts)
          ? listPayload.hosts.filter((host: { label?: string; id?: string }) => host.label === label)
          : [];

        await Promise.all(
          matchingHosts.map((host: { id?: string }) => (
            host.id
              ? request.delete(`/api/remote-hosts/${encodeURIComponent(host.id)}`, {
                headers,
                timeout: 10_000,
              })
              : Promise.resolve()
          )),
        );
      } catch {
        // Cleanup is best-effort for remote host browser tests.
      }
    }
  });

  test('can probe and bootstrap a remote host from settings', async ({ page }) => {
    const remote = remoteConfig!;

    await page.goto('/');
    await waitForAuthenticatedShell(page);

    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.getByTestId('settings-tab-remoteHosts').click();
    await expect(page.getByTestId('remote-hosts-tab')).toBeVisible();

    await page.getByTestId('remote-hosts-label').fill(remote.label);
    await page.getByTestId('remote-hosts-workspace-root').fill(remote.workspaceRoot);
    await page.getByTestId('remote-hosts-host').fill(remote.host);
    await page.getByTestId('remote-hosts-port').fill(remote.port);
    await page.getByTestId('remote-hosts-username').fill(remote.username);
    await page.getByTestId('remote-hosts-password').fill(remote.password);

    await page.getByTestId('remote-hosts-test-connection-trigger').click();
    await expect(page.getByTestId('remote-hosts-test-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('remote-hosts-message')).toContainText(/Remote host probe completed|Connection reachable/i);

    await page.getByTestId('remote-hosts-bootstrap-trigger').click();
    await expect(page.getByTestId('remote-hosts-bootstrap-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('remote-hosts-bootstrap-agent-url')).not.toContainText('Unavailable');
    await expect(page.getByTestId('remote-hosts-bootstrap-agent-token')).not.toContainText('Unavailable');

    const bootstrapStatus = await page.getByTestId('remote-hosts-bootstrap-result').getAttribute('data-bootstrap-status');
    expect(['online', 'bootstrapped']).toContain(bootstrapStatus);

    await expect(page.getByTestId('remote-hosts-saved-list')).toContainText(remote.label, { timeout: 15_000 });

    await page.evaluate(async ({ label }) => {
      const token = window.localStorage.getItem('auth-token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const listResponse = await fetch('/api/remote-hosts', { headers });
      const listPayload = await listResponse.json();
      const matchingHosts = Array.isArray(listPayload?.hosts)
        ? listPayload.hosts.filter((host: { label?: string; id?: string }) => host.label === label)
        : [];

      await Promise.all(
        matchingHosts.map((host: { id?: string }) => (
          host.id
            ? fetch(`/api/remote-hosts/${encodeURIComponent(host.id)}`, {
              method: 'DELETE',
              headers,
            })
            : Promise.resolve()
        )),
      );
    }, { label: remote.label });
  });

  test('can start a remote Codex chat session against the remote host runtime', async ({ page }) => {
    test.setTimeout(300_000);
    const remote = remoteConfig!;
    const label = `${remote.label}-chat`;

    await page.goto('/');
    await waitForAuthenticatedShell(page);

    const createdHostId = await page.evaluate(async (payload) => {
      const token = window.localStorage.getItem('auth-token');
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const bootstrapResponse = await fetch('/api/remote-hosts/bootstrap', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: payload.label,
          connectionMode: 'bootstrap_ssh',
          host: payload.host,
          port: Number(payload.port),
          username: payload.username,
          authMethod: 'password',
          password: payload.password,
          workspaceRoot: payload.workspaceRoot,
        }),
      });

      if (!bootstrapResponse.ok) {
        throw new Error(await bootstrapResponse.text());
      }

      const bootstrapPayload = await bootstrapResponse.json();
      return bootstrapPayload?.host?.id as string;
    }, {
      label,
      host: remote.host,
      port: remote.port,
      username: remote.username,
      password: remote.password,
      workspaceRoot: '/opt/ccui-acceptance',
    });

    try {
      let remoteProject = null as Awaited<ReturnType<typeof fetchLiveProjects>>[number] | null;
      await expect.poll(async () => {
        const projects = await fetchLiveProjects(page);
        remoteProject = projects.find(
          (candidate) =>
            candidate.runtime === 'remote_host' &&
            candidate.fullPath === '/opt/ccui-acceptance' &&
            candidate.remote?.label === label,
        ) || null;
        return Boolean(remoteProject);
      }, {
        timeout: 60_000,
        message: 'Expected remote host project to appear after bootstrap.',
      }).toBe(true);

      if (!remoteProject) {
        throw new Error('Remote host project did not appear after bootstrap.');
      }

      const newSessionButton = await ensureProjectExpanded(page, remoteProject.name);
      await newSessionButton.click();

      const remoteProviderPanel = page.getByTestId('provider-selection-remote-host');
      await expect(remoteProviderPanel).toBeVisible();
      const remoteCodexCard = remoteProviderPanel.locator(
        '[data-testid="provider-selection-card"][data-provider-id="codex"]',
      ).first();
      await expect(remoteCodexCard).toBeVisible();
      await remoteCodexCard.click();

      const prompt = 'run pwd and then answer with just the basename of the current directory';
      await submitPrompt(page, prompt);

      let createdSessionId: string | null = null;
      await expect.poll(async () => {
        const payload = await page.evaluate(async ({ projectName }) => {
          const token = window.localStorage.getItem('auth-token');
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const response = await fetch(
            `/api/projects/${encodeURIComponent(projectName)}/sessions?provider=codex&limit=10&offset=0`,
            { headers },
          );
          return response.json();
        }, { projectName: remoteProject!.name });

        const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
        const match = sessions.find((candidate: { id?: string; provider?: string }) => candidate.provider === 'codex');
        createdSessionId = typeof match?.id === 'string' ? match.id : null;
        return createdSessionId;
      }, {
        timeout: 60_000,
        message: 'Expected a persisted remote Codex session after submitting the prompt.',
      }).not.toBeNull();

      await expect.poll(async () => {
        return page.evaluate(async ({ sessionId, projectName, projectPath }) => {
          const token = window.localStorage.getItem('auth-token');
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const response = await fetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages?provider=codex&projectName=${encodeURIComponent(projectName)}&projectPath=${encodeURIComponent(projectPath)}&mode=bootstrap`,
            { headers },
          );
          const payload = await response.json();
          const items = Array.isArray(payload?.messages) ? payload.messages : [];
          return items
            .filter((item: { kind?: string; role?: string; content?: string }) => item.kind === 'text' && item.role === 'assistant')
            .map((item: { content?: string }) => item.content || '')
            .join('\n');
        }, {
          sessionId: createdSessionId!,
          projectName: remoteProject!.name,
          projectPath: remoteProject!.fullPath || '/opt/ccui-acceptance',
        });
      }, {
        timeout: 60_000,
        message: 'Expected persisted remote Codex history to include the working-directory basename.',
      }).toContain('ccui-acceptance');
    } finally {
      if (!page.isClosed()) {
        await page.evaluate(async ({ hostId }) => {
          const token = window.localStorage.getItem('auth-token');
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          await fetch(`/api/remote-hosts/${encodeURIComponent(hostId)}`, {
            method: 'DELETE',
            headers,
          });
        }, { hostId: createdHostId });
      }
    }
  });
});
