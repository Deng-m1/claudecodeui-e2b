import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const remoteHost = process.env.REMOTE_HOST_E2E_HOST?.trim();
const remoteUsername = process.env.REMOTE_HOST_E2E_USERNAME?.trim();
const remotePassword = process.env.REMOTE_HOST_E2E_PASSWORD?.trim();
const remotePort = Number.parseInt(process.env.REMOTE_HOST_E2E_PORT || '22', 10);
const workspaceRoot = process.env.REMOTE_HOST_E2E_WORKSPACE_ROOT?.trim() || '/root';

const hasRemoteConfig = Boolean(remoteHost && remoteUsername && remotePassword);

const {
  bootstrapSshRemoteHost,
  browseSavedRemoteHostDirectories,
  provisionManagedSshAccess,
  testSshRemoteHost,
  validateHostPayload,
} = await import('../../server/routes/remote-hosts.js');
const {
  syncRemoteHostSnapshot,
} = await import('../../server/providers/remote-host/full-sync.js');
const {
  executeRemoteProcessWithFallback,
} = await import('../../server/providers/remote-host/transport.js');

test('remote host SSH probe returns remote environment details', { skip: !hasRemoteConfig }, async () => {
  const payload = {
    label: `node-probe-${Date.now()}`,
    connectionMode: 'bootstrap_ssh',
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    authMethod: 'password',
    password: remotePassword,
    workspaceRoot,
  };

  const normalized = validateHostPayload(payload, { requireLabel: false });
  const result = await testSshRemoteHost(payload, normalized);

  assert.equal(result.success, true);
  assert.equal(result.authVerified, true);
  assert.equal(result.remote.user, remoteUsername);
  assert.equal(result.remote.workspace.path, workspaceRoot);
});

test('remote host SSH bootstrap installs a minimal remote-agent', { skip: !hasRemoteConfig }, async () => {
  const payload = {
    label: `node-bootstrap-${Date.now()}`,
    connectionMode: 'bootstrap_ssh',
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    authMethod: 'password',
    password: remotePassword,
    workspaceRoot,
  };

  const normalized = validateHostPayload(payload);
  const result = await bootstrapSshRemoteHost(payload, normalized);

  assert.match(result.status, /^(online|bootstrapped)$/);
  assert.equal(result.bootstrap.localHealthVerified, true);
  assert.ok(result.bootstrap.agentUrl);
  assert.ok(result.bootstrap.agentToken);
  assert.ok(result.bootstrap.agentDir);
});

test('remote host managed SSH key installation supports saved-host browse fallback after agent failure', { skip: !hasRemoteConfig }, async () => {
  const payload = {
    label: `node-managed-key-${Date.now()}`,
    connectionMode: 'bootstrap_ssh',
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    authMethod: 'password',
    password: remotePassword,
    workspaceRoot,
  };

  const normalized = validateHostPayload(payload);
  const managedKey = await provisionManagedSshAccess(payload, normalized);

  assert.match(managedKey.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.match(managedKey.publicKey, /^ssh-ed25519\s+/);

  const result = await browseSavedRemoteHostDirectories({
    label: payload.label,
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    agent_url: 'http://127.0.0.1:9',
    agent_token: 'invalid-token',
    managed_ssh_private_key: managedKey.privateKey,
    saved_ssh_password: remotePassword,
  }, workspaceRoot);

  assert.equal(result.path, workspaceRoot);
  assert.ok(Array.isArray(result.suggestions));
});

test('saved-host browse falls back to saved password when the managed SSH key is unusable', { skip: !hasRemoteConfig }, async () => {
  const result = await browseSavedRemoteHostDirectories({
    label: `node-saved-password-${Date.now()}`,
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    managed_ssh_private_key: 'invalid-private-key',
    saved_ssh_password: remotePassword,
  }, workspaceRoot);

  assert.equal(result.path, workspaceRoot);
  assert.ok(Array.isArray(result.suggestions));
});

test('remote process execution falls back to managed-key SSH when the remote agent endpoint is unreachable', { skip: !hasRemoteConfig, timeout: 180_000 }, async () => {
  const payload = {
    label: `node-transport-fallback-${Date.now()}`,
    connectionMode: 'bootstrap_ssh',
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    authMethod: 'password',
    password: remotePassword,
    workspaceRoot,
  };

  const normalized = validateHostPayload(payload);
  const bootstrapResult = await bootstrapSshRemoteHost(payload, normalized);
  const managedKey = await provisionManagedSshAccess(payload, normalized);
  const result = await executeRemoteProcessWithFallback({
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    agent_url: 'http://127.0.0.1:9',
    agent_token: bootstrapResult.bootstrap.agentToken,
    managed_ssh_private_key: managedKey.privateKey,
    metadata: {
      bootstrap: {
        installMode: bootstrapResult.bootstrap.installMode,
        serviceName: bootstrapResult.bootstrap.serviceName,
        agentDir: bootstrapResult.bootstrap.agentDir,
      },
    },
  }, {
    command: 'python3',
    args: ['-c', 'print("ccui-remote-fallback")'],
    cwd: workspaceRoot,
    timeoutMs: 15000,
  });

  assert.match(result.stdout, /ccui-remote-fallback/);
  assert.equal(result.exitCode, 0);
});

test('remote host sync snapshot exports inspect metadata and a tarball over managed-key SSH', { skip: !hasRemoteConfig, timeout: 180_000 }, async () => {
  const payload = {
    label: `node-sync-${Date.now()}`,
    connectionMode: 'bootstrap_ssh',
    host: remoteHost,
    port: remotePort,
    username: remoteUsername,
    authMethod: 'password',
    password: remotePassword,
    workspaceRoot,
  };

  const normalized = validateHostPayload(payload);
  const managedKey = await provisionManagedSshAccess(payload, normalized);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-remote-sync-live-'));

  try {
    const result = await syncRemoteHostSnapshot({
      id: 'live-sync-host',
      user_id: 1,
      label: payload.label,
      host: remoteHost,
      port: remotePort,
      username: remoteUsername,
      connection_mode: 'bootstrap_ssh',
      auth_method: 'password',
      managed_ssh_private_key: managedKey.privateKey,
      managed_ssh_public_key: managedKey.publicKey,
      status: 'online',
    }, {
      workspaces: [
        {
          id: 'workspace-live-sync',
          remote_host_id: 'live-sync-host',
          display_name: 'root-home',
          workspace_root: workspaceRoot,
          status: 'registered',
        },
      ],
      sessions: [],
      messagesBySession: {},
      outputDir,
      homeTargets: ['.ssh'],
      workspaceTargets: ['.cloudcli-data'],
      maxDbHits: 25,
    });

    const manifestRaw = await fs.readFile(result.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const inspect = JSON.parse(await fs.readFile(result.inspectPath, 'utf8'));

    assert.ok(Array.isArray(inspect.paths));
    assert.ok(manifest.existingPathCount >= 1);
    assert.ok(result.archivePath);
    assert.ok(result.archiveBytes > 0);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
