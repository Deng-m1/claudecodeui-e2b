import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  buildRemoteHostPlatformSnapshot,
  syncRemoteHostSnapshot,
} from '../../server/providers/remote-host/full-sync.js';

const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

test('buildRemoteHostPlatformSnapshot redacts stored connection secrets by default', () => {
  const snapshot = buildRemoteHostPlatformSnapshot({
    host: {
      id: 'host-1',
      user_id: 7,
      label: 'demo',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
      connection_mode: 'bootstrap_ssh',
      auth_method: 'password',
      agent_token: 'agent-secret',
      managed_ssh_public_key: 'ssh-ed25519 AAAA',
      managed_ssh_private_key: 'private-key',
      saved_ssh_password: 'password-secret',
      status: 'online',
      metadata: { bootstrap: { installMode: 'systemd' } },
    },
    includeSecrets: false,
  });

  assert.equal(snapshot.host.agentToken, null);
  assert.equal(snapshot.host.managedSshPrivateKey, null);
  assert.equal(snapshot.host.savedSshPassword, null);
  assert.equal(snapshot.host.secretFlags.hasAgentToken, true);
  assert.equal(snapshot.host.secretFlags.hasManagedSshKey, true);
  assert.equal(snapshot.host.secretFlags.hasSavedSshPassword, true);
});

test('syncRemoteHostSnapshot writes manifest, platform export, and inspect output', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-remote-sync-'));
  tempRoots.push(outputDir);

  const archiveChecksum = 'abc123';
  const result = await syncRemoteHostSnapshot(
    {
      id: 'host-1',
      user_id: 7,
      label: 'demo-host',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
      connection_mode: 'bootstrap_ssh',
      auth_method: 'password',
      agent_token: 'agent-secret',
      managed_ssh_public_key: 'ssh-ed25519 AAAA',
      managed_ssh_private_key: 'private-key',
      saved_ssh_password: 'password-secret',
      status: 'online',
    },
    {
      workspaces: [
        {
          id: 'workspace-1',
          remote_host_id: 'host-1',
          display_name: 'demo workspace',
          workspace_root: '/root/work/demo',
          status: 'registered',
        },
      ],
      sessions: [
        {
          id: 1,
          remote_host_id: 'host-1',
          workspace_id: 'workspace-1',
          session_id: 'session-1',
          provider: 'codex',
          model: 'gpt-5.4',
          summary: 'demo session',
          status: 'completed',
          message_count: 1,
        },
      ],
      messagesBySession: {
        'session-1': [
          {
            id: 'message-1',
            kind: 'text',
            role: 'assistant',
            content: 'demo',
          },
        ],
      },
      outputDir,
      inspectTargets: async () => ({
        home: '/root',
        existingPaths: ['/root/.claude'],
        paths: [
          {
            path: '/root/.claude',
            exists: true,
          },
        ],
        via: 'managed SSH key',
      }),
      downloadArchive: async (_host, _existingPaths, archivePath) => {
        await fs.writeFile(archivePath, 'archive');
        return {
          archivePath,
          via: 'managed SSH key',
          bytesWritten: 7,
          checksumSha256: archiveChecksum,
        };
      },
    },
  );

  const platformState = JSON.parse(await fs.readFile(result.platformStatePath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  const inspectPayload = JSON.parse(await fs.readFile(result.inspectPath, 'utf8'));

  assert.equal(platformState.host.agentToken, null);
  assert.equal(platformState.sessions.length, 1);
  assert.equal(platformState.messagesBySession['session-1'].length, 1);
  assert.equal(manifest.existingPathCount, 1);
  assert.equal(manifest.archiveChecksumSha256, archiveChecksum);
  assert.equal(manifest.syncTransport.inspectVia, 'managed SSH key');
  assert.equal(manifest.syncTransport.archiveVia, 'managed SSH key');
  assert.equal(inspectPayload.existingPaths[0], '/root/.claude');
  assert.equal(result.archiveBytes, 7);
});
