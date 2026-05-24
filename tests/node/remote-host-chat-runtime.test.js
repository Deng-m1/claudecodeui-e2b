import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-remote-chat-'));
const tempDbPath = path.join(tempRoot, 'auth.db');
const originalHome = process.env.HOME;
const originalDatabasePath = process.env.DATABASE_PATH;

process.env.HOME = tempRoot;
process.env.DATABASE_PATH = tempDbPath;
fs.closeSync(fs.openSync(tempDbPath, 'w'));

const {
  getProjectSessionsPage,
  getProjects,
  getSessionBootstrap,
} = await import('../../server/projects.js');
const {
  initializeDatabase,
  remoteHostSessionMessagesDb,
  remoteHostSessionsDb,
  remoteHostsDb,
  remoteWorkspacesDb,
  userDb,
} = await import('../../server/database/db.js');
const {
  buildRemoteCodexExecutionProfile,
  buildRemoteProcessPayload,
  inferStoredRemoteCodexExecutionProfile,
  parseClaudeJsonOutput,
  parseCodexJsonOutput,
  resolveRemoteCodexSessionReuse,
} = await import('../../server/providers/remote-host/chat-runtime.js');

await initializeDatabase();

after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote chat parsers normalize Codex and Claude structured output', () => {
  const codex = parseCodexJsonOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'tool-1',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/workspace/demo\n',
        exit_code: 0,
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'assistant-1',
        type: 'agent_message',
        text: 'demo',
      },
    }),
  ].join('\n'));

  assert.equal(codex.actualSessionId, 'codex-thread-1');
  assert.deepEqual(
    codex.messages.map((message) => message.kind),
    ['tool_use', 'tool_result', 'text'],
  );
  assert.equal(codex.messages.at(-1)?.content, 'demo');

  const claude = parseClaudeJsonOutput([
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude-session-1',
      error: 'authentication_failed',
      message: {
        content: [
          { type: 'text', text: 'Failed to authenticate.' },
        ],
      },
    }),
  ].join('\n'));

  assert.equal(claude.actualSessionId, 'claude-session-1');
  assert.equal(claude.messages.length, 1);
  assert.equal(claude.messages[0].kind, 'error');
  assert.match(claude.messages[0].content, /Failed to authenticate/);
});

test('remote chat payloads execute through the remote login shell', () => {
  const codexPayload = buildRemoteProcessPayload('codex', {
    command: 'pwd',
    model: 'gpt-5.4',
    cwd: '/opt/remote-demo',
    permissionMode: 'bypassPermissions',
  });
  assert.equal(codexPayload.loginShell, true);
  assert.equal(codexPayload.command, 'codex');
  assert.deepEqual(
    codexPayload.args,
    ['-a', 'never', '-s', 'danger-full-access', 'exec', '--json', '--skip-git-repo-check', '--model', 'gpt-5.4', 'pwd'],
  );

  const codexDefaultPayload = buildRemoteProcessPayload('codex', {
    command: 'pwd',
    model: 'gpt-5.4',
    cwd: '/opt/remote-demo',
    permissionMode: 'default',
  });
  assert.deepEqual(
    codexDefaultPayload.args,
    ['-a', 'untrusted', '-s', 'workspace-write', 'exec', '--json', '--skip-git-repo-check', '--model', 'gpt-5.4', 'pwd'],
  );

  const claudePayload = buildRemoteProcessPayload('claude', {
    command: 'pwd',
    model: 'sonnet',
    cwd: '/opt/remote-demo',
    remoteUsername: 'root',
    permissionMode: 'bypassPermissions',
  });
  assert.equal(claudePayload.loginShell, true);
  assert.equal(claudePayload.command, 'claude');
  assert.deepEqual(
    claudePayload.args,
    ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--model', 'sonnet', 'pwd'],
  );
});

test('remote Codex session reuse only resumes matching execution profiles', () => {
  const bypassProfile = buildRemoteCodexExecutionProfile('bypassPermissions');
  const previousBypass = inferStoredRemoteCodexExecutionProfile({
    codexExecutionProfile: bypassProfile,
  });

  assert.deepEqual(previousBypass, bypassProfile);

  const inferredFromArgs = inferStoredRemoteCodexExecutionProfile({
    remoteArgs: ['-a', 'never', '-s', 'danger-full-access', 'exec', 'resume', 'thread-1', '--json'],
  });
  assert.deepEqual(inferredFromArgs, bypassProfile);

  const compatible = resolveRemoteCodexSessionReuse(
    'thread-1',
    { metadata: { codexExecutionProfile: bypassProfile } },
    'bypassPermissions',
  );
  assert.equal(compatible.resumeSessionId, 'thread-1');
  assert.equal(compatible.reuseMode, 'resume_existing');

  const mismatched = resolveRemoteCodexSessionReuse(
    'thread-1',
    { metadata: { codexExecutionProfile: bypassProfile } },
    'default',
  );
  assert.equal(mismatched.resumeSessionId, null);
  assert.equal(mismatched.reuseMode, 'new_session_profile_mismatch');

  const unknown = resolveRemoteCodexSessionReuse(
    'thread-legacy',
    { metadata: { remoteArgs: ['exec', 'resume', 'thread-legacy', '--json'] } },
    'bypassPermissions',
  );
  assert.equal(unknown.resumeSessionId, null);
  assert.equal(unknown.reuseMode, 'new_session_unknown_profile');
});

test('remote host sessions appear in project discovery, pagination, and session bootstrap', async () => {
  const userId = userDb.createUser('remote-chat-user', 'not-used').id;
  const remoteHost = remoteHostsDb.create(userId, {
    label: 'remote-ci-host',
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    connectionMode: 'bootstrap_ssh',
    authMethod: 'password',
    agentUrl: 'http://203.0.113.10:47100',
    agentToken: 'remote-test-token',
    status: 'online',
  });
  const workspace = remoteWorkspacesDb.create(userId, {
    remoteHostId: remoteHost.id,
    displayName: 'remote demo',
    workspaceRoot: '/opt/remote-demo',
  });
  const projectName = `remote__${workspace.id}`;

  remoteHostSessionsDb.upsert(userId, 'remote-codex-1', {
    remoteHostId: remoteHost.id,
    workspaceId: workspace.id,
    provider: 'codex',
    summary: 'Remote Codex One',
    status: 'completed',
  });
  remoteHostSessionsDb.upsert(userId, 'remote-codex-2', {
    remoteHostId: remoteHost.id,
    workspaceId: workspace.id,
    provider: 'codex',
    summary: 'Remote Codex Two',
    status: 'completed',
  });
  remoteHostSessionsDb.upsert(userId, 'remote-claude-1', {
    remoteHostId: remoteHost.id,
    workspaceId: workspace.id,
    provider: 'claude',
    summary: 'Remote Claude One',
    status: 'error',
  });

  remoteHostSessionMessagesDb.append('remote-codex-1', {
    id: 'msg-1',
    sessionId: 'remote-codex-1',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: 'Remote Codex One',
    timestamp: '2026-04-05T00:00:00.000Z',
  });

  const page = await getProjectSessionsPage({
    projectName,
    provider: 'codex',
    limit: 1,
    offset: 1,
    userId,
  });

  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].provider, 'codex');

  const projects = await getProjects(null, { userId });
  const project = projects.find((candidate) => candidate.name === projectName);

  assert.ok(project);
  assert.equal(project.runtime, 'remote_host');
  assert.equal(project.remote?.workspaceRoot, '/opt/remote-demo');
  assert.equal(project.sessionMeta?.byProvider?.codex?.total, 2);
  assert.equal(project.sessionMeta?.byProvider?.claude?.total, 1);

  const bootstrap = await getSessionBootstrap('remote-codex-1', { userId });
  assert.ok(bootstrap);
  assert.equal(bootstrap?.provider, 'codex');
  assert.equal(bootstrap?.project.runtime, 'remote_host');
  assert.equal(bootstrap?.session.__runtime, 'remote_host');
  assert.equal(bootstrap?.session.__projectName, projectName);
});
