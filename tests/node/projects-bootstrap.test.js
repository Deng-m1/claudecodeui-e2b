import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-projects-test-'));
const tempDbPath = path.join(tempRoot, 'auth.db');
const originalHome = process.env.HOME;
const originalDatabasePath = process.env.DATABASE_PATH;

process.env.HOME = tempRoot;
process.env.DATABASE_PATH = tempDbPath;
fs.closeSync(fs.openSync(tempDbPath, 'w'));

const {
  getProjects,
  getSessionBootstrap,
} = await import('../../server/projects.js');
const {
  initializeDatabase,
  e2bSandboxDb,
  e2bSessionDb,
  e2bSessionMessagesDb,
  userDb,
} = await import('../../server/database/db.js');

await initializeDatabase();

const writeCodexSessionFile = ({
  sessionId,
  projectPath,
  timestamp,
  message,
  datePath = ['2026', '03', '31'],
  forkedFromId = null,
}) => {
  const targetDir = path.join(tempRoot, '.codex', 'sessions', ...datePath);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp,
        payload: {
          id: sessionId,
          cwd: projectPath,
          model: 'gpt-5-codex',
          ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp,
        payload: {
          type: 'user_message',
          kind: 'plain',
          message,
        },
      }),
    ].join('\n'),
    'utf8',
  );
};

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

test('getSessionBootstrap restores the real local project cwd even when the first entry lacks cwd', async () => {
  const actualProjectPath = path.join(tempRoot, 'workspace', 'foo-bar');
  const sessionId = 'session-with-queue-preface';
  const projectName = actualProjectPath.replace(/[\\/:\s~_]/g, '-');
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);
  const sessionFile = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.writeFileSync(
    path.join(actualProjectPath, 'package.json'),
    JSON.stringify({ name: 'foo-bar' }, null, 2),
    'utf8',
  );

  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-03-31T12:00:00.000Z',
        sessionId,
      }),
      JSON.stringify({
        parentUuid: null,
        cwd: actualProjectPath,
        sessionId,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'resume this local session' }],
        },
        uuid: 'user-message-1',
        timestamp: '2026-03-31T12:00:01.000Z',
      }),
    ].join('\n'),
    'utf8',
  );

  const bootstrap = await getSessionBootstrap(sessionId);

  assert.ok(bootstrap);
  assert.equal(bootstrap.provider, 'claude');
  assert.equal(bootstrap.project.fullPath, actualProjectPath);
  assert.equal(bootstrap.project.path, actualProjectPath);
  assert.equal(bootstrap.project.displayName, 'foo-bar');
  assert.equal(bootstrap.session.cwd, actualProjectPath);
  assert.deepEqual(bootstrap.project.capabilities, { files: true, git: true, shell: true });
});

test('getProjects and getSessionBootstrap expose cloud capabilities for E2B sandboxes', async () => {
  const user = userDb.createUser('cloud-user', 'hash');
  const userId = user.id;
  const sandboxId = 'sandbox-capabilities';
  const sessionId = 'cloud-session-capabilities';

  e2bSandboxDb.create(userId, sandboxId, {
    repoUrl: 'https://github.com/example/cloud-repo.git',
    branch: 'main',
    workspacePath: '/home/user/cloud-repo',
  });
  e2bSessionDb.upsert(userId, sessionId, {
    sandboxId,
    agent: 'codex',
    summary: 'Cloud capability session',
  });

  const projects = await getProjects(null, { userId });
  const cloudProject = projects.find((project) => project.name === `e2b__${sandboxId}`);

  assert.ok(cloudProject);
  assert.equal(cloudProject.kind, 'cloud');
  assert.equal(cloudProject.runtime, 'e2b');
  assert.deepEqual(cloudProject.capabilities, { files: true, git: true, shell: true });

  const bootstrap = await getSessionBootstrap(sessionId, { userId });

  assert.ok(bootstrap);
  assert.equal(bootstrap.project.runtime, 'e2b');
  assert.deepEqual(bootstrap.project.capabilities, { files: true, git: true, shell: true });
  assert.equal(bootstrap.session.__runtime, 'e2b');
  assert.equal(bootstrap.session.__provider, 'codex');
});


test('getProjects and getSessionBootstrap include persisted E2B message counts', async () => {
  const user = userDb.createUser('cloud-count-user', 'hash');
  const userId = user.id;
  const sandboxId = 'sandbox-message-counts';
  const sessionId = 'cloud-session-message-counts';

  e2bSandboxDb.create(userId, sandboxId, {
    repoUrl: 'https://github.com/example/cloud-repo.git',
    branch: 'main',
    workspacePath: '/home/user/cloud-repo',
  });
  e2bSessionDb.upsert(userId, sessionId, {
    sandboxId,
    agent: 'codex',
    summary: 'Cloud count session',
  });
  e2bSessionMessagesDb.append(sessionId, {
    id: 'cloud-count-user-message',
    sessionId,
    kind: 'text',
    role: 'user',
    content: 'hello from cloud',
    timestamp: '2026-03-31T12:00:00.000Z',
  });
  e2bSessionMessagesDb.append(sessionId, {
    id: 'cloud-count-assistant-message',
    sessionId,
    kind: 'stream_delta',
    content: 'hello back',
    timestamp: '2026-03-31T12:00:01.000Z',
  });

  const projects = await getProjects(null, { userId });
  const cloudProject = projects.find((project) => project.name === `e2b__${sandboxId}`);

  assert.ok(cloudProject);
  assert.equal(cloudProject.e2bSessions?.[0]?.messageCount, 2);

  const bootstrap = await getSessionBootstrap(sessionId, { userId });

  assert.ok(bootstrap);
  assert.equal(bootstrap.session.messageCount, 2);
  assert.equal(bootstrap.project.e2bSessions?.find((session) => session.id === sessionId)?.messageCount, 2);
});

test('bootstrap for an older local Codex session preloads only the selected Codex session', async () => {
  const actualProjectPath = path.join(tempRoot, 'workspace', 'bootstrap-codex-project');
  const projectName = actualProjectPath.replace(/[\/:\s~_]/g, '-');
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.writeFileSync(
    path.join(actualProjectPath, 'package.json'),
    JSON.stringify({ name: 'bootstrap-codex-project' }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, '.claude', 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        originalPath: actualProjectPath,
        manuallyAdded: true,
      },
    }),
    'utf8',
  );

  for (let index = 0; index < 6; index += 1) {
    writeCodexSessionFile({
      sessionId: `bootstrap-codex-${index}`,
      projectPath: actualProjectPath,
      timestamp: `2026-03-31T12:0${index}:00.000Z`,
      message: `Bootstrap Codex Session ${index}`,
      datePath: ['2026', '03', '31'],
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 5200));

  const bootstrap = await getSessionBootstrap('bootstrap-codex-0');

  assert.ok(bootstrap);
  assert.equal(bootstrap.provider, 'codex');
  assert.equal(bootstrap.project.codexSessions?.length, 1);
  assert.equal(bootstrap.project.codexSessions?.[0]?.id, 'bootstrap-codex-0');
  assert.equal(bootstrap.project.sessionMeta?.byProvider?.codex?.total, 1);
  assert.equal(bootstrap.project.sessionMeta?.byProvider?.codex?.hasMore, false);
});

test('Codex session discovery exposes fork lineage for parent and child sessions', async () => {
  const actualProjectPath = path.join(tempRoot, 'workspace', 'codex-fork-project');
  const projectName = actualProjectPath.replace(/[\\/:\s~_]/g, '-');
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);
  const parentSessionId = 'codex-fork-parent';
  const childSessionId = 'codex-fork-child';

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(actualProjectPath, 'package.json'),
    JSON.stringify({ name: 'codex-fork-project' }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(claudeProjectDir, 'seed.jsonl'),
    `${JSON.stringify({ cwd: actualProjectPath, timestamp: '2026-04-04T11:59:00.000Z' })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(tempRoot, '.claude', 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        originalPath: actualProjectPath,
      },
    }),
    'utf8',
  );

  writeCodexSessionFile({
    sessionId: parentSessionId,
    projectPath: actualProjectPath,
    timestamp: '2026-04-04T12:00:00.000Z',
    message: 'original parent session',
    datePath: ['2026', '04', '04'],
  });
  writeCodexSessionFile({
    sessionId: childSessionId,
    projectPath: actualProjectPath,
    timestamp: '2026-04-04T12:10:00.000Z',
    message: 'fork child session',
    datePath: ['2026', '04', '04'],
    forkedFromId: parentSessionId,
  });

  await new Promise((resolve) => setTimeout(resolve, 5200));

  const projects = await getProjects();
  const project = projects.find((candidate) => candidate.fullPath === actualProjectPath);
  const parentSession = project?.codexSessions?.find((candidate) => candidate.id === parentSessionId);
  const childSession = project?.codexSessions?.find((candidate) => candidate.id === childSessionId);

  assert.ok(project);
  assert.ok(parentSession);
  assert.ok(childSession);
  assert.equal(childSession.forkedFromId, parentSessionId);
  assert.equal(parentSession.forkChildCount, 1);
  assert.deepEqual(parentSession.forkChildIds, [childSessionId]);

  const parentBootstrap = await getSessionBootstrap(parentSessionId);
  const childBootstrap = await getSessionBootstrap(childSessionId);

  assert.equal(parentBootstrap?.session.forkChildCount, 1);
  assert.deepEqual(parentBootstrap?.session.forkChildIds, [childSessionId]);
  assert.equal(childBootstrap?.session.forkedFromId, parentSessionId);
});

test('uuid-like session bootstrap prefers Codex thread metadata and only preloads the selected session', async () => {
  const sessionId = '019d41db-ab8d-78a0-aa57-23deb9a251b9';
  const actualProjectPath = path.join(tempRoot, 'workspace', 'codex-state-bootstrap');
  const projectName = actualProjectPath.replace(/[\\/:\s~_]/g, '-');
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);
  const rolloutDir = path.join(tempRoot, '.codex', 'sessions', '2026', '04', '04');
  const rolloutPath = path.join(rolloutDir, `rollout-${sessionId}.jsonl`);
  const codexStateDbPath = path.join(tempRoot, '.codex', 'state_5.sqlite');

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.mkdirSync(path.dirname(codexStateDbPath), { recursive: true });

  fs.writeFileSync(
    path.join(actualProjectPath, 'package.json'),
    JSON.stringify({ name: 'codex-state-bootstrap' }, null, 2),
    'utf8',
  );

  fs.writeFileSync(
    path.join(claudeProjectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        parentUuid: null,
        cwd: actualProjectPath,
        sessionId,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'this should not win bootstrap priority' }],
        },
        uuid: 'claude-user-message-1',
        timestamp: '2026-04-04T10:00:00.000Z',
      }),
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-04T10:01:00.000Z',
        payload: {
          id: sessionId,
          cwd: actualProjectPath,
          model: 'gpt-5-codex',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-04-04T10:02:00.000Z',
        payload: {
          type: 'user_message',
          kind: 'plain',
          message: 'use the codex bootstrap path',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-04-04T10:03:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
        },
      }),
    ].join('\n'),
    'utf8',
  );

  const db = await open({
    filename: codexStateDbPath,
    driver: sqlite3.Database,
  });

  try {
    await db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        cwd TEXT,
        title TEXT,
        updated_at TEXT,
        model_provider TEXT
      )
    `);

    await db.run(
      `INSERT INTO threads (id, rollout_path, cwd, title, updated_at, model_provider)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      rolloutPath,
      actualProjectPath,
      'Codex UUID bootstrap',
      '2026-04-04T10:03:00.000Z',
      'openai',
    );
  } finally {
    await db.close();
  }

  const bootstrap = await getSessionBootstrap(sessionId);

  assert.ok(bootstrap);
  assert.equal(bootstrap.provider, 'codex');
  assert.equal(bootstrap.session.__provider, 'codex');
  assert.equal(bootstrap.project.fullPath, actualProjectPath);
  assert.equal(bootstrap.project.sessions?.length, 0);
  assert.equal(bootstrap.project.codexSessions?.length, 1);
  assert.equal(bootstrap.project.codexSessions?.[0]?.id, sessionId);
  assert.equal(bootstrap.project.sessionMeta?.byProvider?.claude?.total, 0);
  assert.equal(bootstrap.project.sessionMeta?.byProvider?.codex?.total, 1);
});
