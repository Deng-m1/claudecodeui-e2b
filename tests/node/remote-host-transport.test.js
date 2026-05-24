import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { RemoteAgentError } from '../../server/providers/remote-host/agent-client.js';
import {
  executeRemoteProcessOverSsh,
  executeRemoteProcessWithFallback,
  getSshCredentialPlans,
  remoteAgentRequestWithRecovery,
} from '../../server/providers/remote-host/transport.js';

function buildRemoteHostFixture(overrides = {}) {
  return {
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    managed_ssh_private_key: 'managed-key',
    saved_ssh_password: 'saved-password',
    metadata: {
      bootstrap: {
        installMode: 'systemd',
        serviceName: 'claude-code-ui-remote-agent',
      },
    },
    ...overrides,
  };
}

test('remoteAgentRequestWithRecovery restarts the remote agent and retries once', async () => {
  const host = buildRemoteHostFixture();
  const calls = [];

  const response = await remoteAgentRequestWithRecovery(
    host,
    '/health',
    null,
    {
      agentRequest: async (_host, pathname) => {
        calls.push(pathname);
        if (calls.length === 1) {
          throw new RemoteAgentError('connect ECONNREFUSED 203.0.113.10:47100', 'REMOTE_AGENT_UNREACHABLE', 502);
        }

        return { ok: true };
      },
      restartAgent: async () => ({ recovered: true, via: 'managed SSH key' }),
    },
  );

  assert.deepEqual(calls, ['/health', '/health']);
  assert.deepEqual(response, { ok: true });
});

test('remoteAgentRequestWithRecovery retries against the recovered agent endpoint and persists it', async () => {
  const host = buildRemoteHostFixture({
    id: 'remote-host-1',
    user_id: 7,
    agent_url: 'http://203.0.113.10:47100',
    agent_token: 'stale-token',
  });
  const attempts = [];
  const persisted = [];

  const response = await remoteAgentRequestWithRecovery(
    host,
    '/health',
    null,
    {
      agentRequest: async (currentHost, pathname, _payload, requestOptions) => {
        attempts.push({
          pathname,
          agentUrl: currentHost.agent_url,
          agentToken: currentHost.agent_token,
          skipRecovery: requestOptions?.skipRecovery === true,
        });

        if (attempts.length === 1) {
          throw new RemoteAgentError('connect ECONNREFUSED 203.0.113.10:47100', 'REMOTE_AGENT_UNREACHABLE', 502);
        }

        return { ok: true, agentUrl: currentHost.agent_url };
      },
      restartAgent: async () => ({
        recovered: true,
        via: 'managed SSH key',
        agentUrl: 'http://203.0.113.10:47101',
        agentToken: 'fresh-token',
      }),
      persistRecoveredHost: async (originalHost, recoveredHost) => {
        persisted.push({
          hostId: originalHost.id,
          agentUrl: recoveredHost.agent_url,
          agentToken: recoveredHost.agent_token,
        });
      },
    },
  );

  assert.deepEqual(attempts, [
    {
      pathname: '/health',
      agentUrl: 'http://203.0.113.10:47100',
      agentToken: 'stale-token',
      skipRecovery: false,
    },
    {
      pathname: '/health',
      agentUrl: 'http://203.0.113.10:47101',
      agentToken: 'fresh-token',
      skipRecovery: true,
    },
  ]);
  assert.deepEqual(persisted, [
    {
      hostId: 'remote-host-1',
      agentUrl: 'http://203.0.113.10:47101',
      agentToken: 'fresh-token',
    },
  ]);
  assert.equal(host.agent_url, 'http://203.0.113.10:47101');
  assert.equal(host.agent_token, 'fresh-token');
  assert.deepEqual(response, { ok: true, agentUrl: 'http://203.0.113.10:47101' });
});

test('executeRemoteProcessWithFallback falls back to SSH when the agent remains unavailable', async () => {
  const host = buildRemoteHostFixture();
  let agentAttempts = 0;
  let sshAttempts = 0;

  const response = await executeRemoteProcessWithFallback(
    host,
    {
      command: 'python3',
      args: ['-c', 'print("ok")'],
      timeoutMs: 5000,
    },
    {
      agentRequest: async () => {
        agentAttempts += 1;
        throw new RemoteAgentError('connect ECONNREFUSED 203.0.113.10:47100', 'REMOTE_AGENT_UNREACHABLE', 502);
      },
      restartAgent: async () => {
        throw new Error('systemctl restart failed');
      },
      getCredentialPlans: () => [
        {
          label: 'managed SSH key',
          rawPayload: { privateKey: 'managed-key' },
          normalized: {
            host: '203.0.113.10',
            port: 22,
            username: 'root',
            authMethod: 'ssh_key',
          },
        },
      ],
      executeSshCommand: async () => {
        sshAttempts += 1;
        return {
          stdout: JSON.stringify({
            stdout: 'ok\n',
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        };
      },
    },
  );

  assert.equal(agentAttempts, 1);
  assert.equal(sshAttempts, 1);
  assert.equal(response.stdout, 'ok\n');
  assert.equal(response.exitCode, 0);
  assert.equal(response.timedOut, false);
});

test('executeRemoteProcessOverSsh honors login-shell semantics for SSH fallback commands', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-host-shell-'));
  const shellPath = path.join(tempDirectory, 'login-shell.sh');

  await fs.writeFile(
    shellPath,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-lc" ] || [ "$1" = "-c" ]; then',
      '  export CLIPROXY_API_KEY="from-login-shell"',
      'fi',
      'exec /bin/bash "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  try {
    const response = await executeRemoteProcessOverSsh(
      buildRemoteHostFixture(),
      {
        command: 'python3',
        args: ['-c', 'import os; print(os.environ.get("CLIPROXY_API_KEY", "missing"))'],
        loginShell: true,
        shell: shellPath,
        timeoutMs: 5000,
      },
      {
        getCredentialPlans: () => [
          {
            label: 'managed SSH key',
            rawPayload: { privateKey: 'managed-key' },
            normalized: {
              host: '203.0.113.10',
              port: 22,
              username: 'root',
              authMethod: 'ssh_key',
            },
          },
        ],
        executeSshCommand: async (_rawPayload, _normalized, remoteCommand) => {
          const completed = spawnSync('bash', ['-lc', remoteCommand], {
            encoding: 'utf8',
          });

          return {
            stdout: completed.stdout || '',
            stderr: completed.stderr || '',
            exitCode: completed.status ?? 1,
            timedOut: false,
          };
        },
      },
    );

    assert.equal(response.exitCode, 0);
    assert.equal(response.stdout.trim(), 'from-login-shell');
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('managed SSH key is preferred ahead of the saved password fallback', () => {
  const plans = getSshCredentialPlans(buildRemoteHostFixture()).map((plan) => plan.label);
  assert.deepEqual(plans, ['managed SSH key', 'saved password']);
});
