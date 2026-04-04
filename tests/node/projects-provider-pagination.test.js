import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-provider-pagination-'));
const tempDbPath = path.join(tempRoot, 'auth.db');
const originalHome = process.env.HOME;
const originalDatabasePath = process.env.DATABASE_PATH;

process.env.HOME = tempRoot;
process.env.DATABASE_PATH = tempDbPath;
fs.closeSync(fs.openSync(tempDbPath, 'w'));

const {
  getProjectSessionsPage,
  getProjects,
} = await import('../../server/projects.js');
const {
  initializeDatabase,
  userDb,
  e2bSandboxDb,
  e2bSessionDb,
} = await import('../../server/database/db.js');

await initializeDatabase();

const writeCodexSessionFile = ({ sessionId, projectPath, timestamp, message, datePath = ['2026', '03', '31'] }) => {
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


const encodeProjectPath = (projectPath) => projectPath.replace(/[\/:\s~_]/g, '-');

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

test('getProjectSessionsPage paginates local Codex sessions and exposes provider hasMore metadata', async () => {
  const actualProjectPath = path.join(tempRoot, 'workspace', 'provider-filter-local');
  const projectName = actualProjectPath.replace(/[\\/:\s~_]/g, '-');
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.writeFileSync(
    path.join(actualProjectPath, 'package.json'),
    JSON.stringify({ name: 'provider-filter-local' }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, '.claude', 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        originalPath: actualProjectPath,
      },
    }),
    'utf8',
  );

  for (let index = 0; index < 6; index += 1) {
    writeCodexSessionFile({
      sessionId: `codex-local-${index}`,
      projectPath: actualProjectPath,
      timestamp: `2026-03-31T12:0${index}:00.000Z`,
      message: `Local Codex Session ${index}`,
    });
  }

  const page = await getProjectSessionsPage({
    projectName,
    projectPath: actualProjectPath,
    provider: 'codex',
    limit: 2,
    offset: 2,
  });

  assert.equal(page.total, 6);
  assert.equal(page.hasMore, true);
  assert.equal(page.sessions.length, 2);
  assert.deepEqual(page.sessions.map((session) => session.id), ['codex-local-3', 'codex-local-2']);

  const projects = await getProjects();
  const project = projects.find((candidate) => candidate.name === projectName);

  assert.ok(project);
  assert.equal(project.codexSessions?.length, 5);
  assert.equal(project.sessionMeta?.byProvider?.codex?.total, 6);
  assert.equal(project.sessionMeta?.byProvider?.codex?.hasMore, true);
});

test('getProjectSessionsPage paginates cloud sessions within the selected provider channel', async () => {
  const userId = userDb.createUser('provider-pagination-user', 'not-used').id;
  const sandboxId = 'e2b/provider-filter-cloud';
  const projectName = `e2b__${sandboxId}`;

  e2bSandboxDb.create(userId, sandboxId, {
    repoUrl: 'https://github.com/test-owner/provider-filter-cloud.git',
    branch: 'main',
    workspacePath: '/home/user/provider-filter-cloud',
  });

  for (let index = 0; index < 6; index += 1) {
    e2bSessionDb.upsert(userId, `cloud-codex-${index}`, {
      sandboxId,
      agent: 'codex',
      summary: `Cloud Codex ${index}`,
      status: 'active',
    });
  }

  for (let index = 0; index < 2; index += 1) {
    e2bSessionDb.upsert(userId, `cloud-claude-${index}`, {
      sandboxId,
      agent: 'claude',
      summary: `Cloud Claude ${index}`,
      status: 'active',
    });
  }

  const page = await getProjectSessionsPage({
    projectName,
    provider: 'codex',
    limit: 2,
    offset: 2,
  });

  assert.equal(page.total, 6);
  assert.equal(page.hasMore, true);
  assert.equal(page.sessions.length, 2);
  assert.ok(page.sessions.every((session) => session.provider === 'codex'));

  const projects = await getProjects(null, { userId });
  const project = projects.find((candidate) => candidate.name === projectName);

  assert.ok(project);
  assert.equal(project.runtime, 'e2b');
  assert.equal(project.sessionMeta?.byProvider?.codex?.total, 6);
  assert.equal(project.sessionMeta?.byProvider?.codex?.hasMore, true);
  assert.equal(project.sessionMeta?.byProvider?.claude?.total, 2);
});


test('getProjectSessionsPage deduplicates repeated Codex session ids before pagination', async () => {
  const actualProjectPath = path.join(tempRoot, 'workspace', 'provider-filter-codex-dedupe');
  const projectName = actualProjectPath.replace(/[\/:\s~_]/g, '-');

  fs.mkdirSync(actualProjectPath, { recursive: true });

  writeCodexSessionFile({
    sessionId: 'codex-dedupe-1',
    projectPath: actualProjectPath,
    timestamp: '2026-03-30T12:01:00.000Z',
    message: 'First version',
    datePath: ['2026', '03', '30'],
  });
  writeCodexSessionFile({
    sessionId: 'codex-dedupe-1',
    projectPath: actualProjectPath,
    timestamp: '2026-03-31T12:05:00.000Z',
    message: 'Second version',
    datePath: ['2026', '03', '31'],
  });
  writeCodexSessionFile({
    sessionId: 'codex-dedupe-2',
    projectPath: actualProjectPath,
    timestamp: '2026-03-31T12:03:00.000Z',
    message: 'Another unique session',
  });

  await new Promise((resolve) => setTimeout(resolve, 5200));

  const page = await getProjectSessionsPage({
    projectName,
    projectPath: actualProjectPath,
    provider: 'codex',
    limit: 5,
    offset: 0,
  });

  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.sessions.map((session) => session.id), ['codex-dedupe-1', 'codex-dedupe-2']);
});

test('getProjects skips invalid Cursor store schemas without repeating warnings', async () => {
  const { default: sqlite3 } = await import('sqlite3');
  const { open } = await import('sqlite');
  const { createHash } = await import('node:crypto');

  const actualProjectPath = path.join(tempRoot, 'workspace', 'cursor-invalid-schema-project');
  const projectName = encodeProjectPath(actualProjectPath);
  const claudeProjectDir = path.join(tempRoot, '.claude', 'projects', projectName);
  const cwdId = createHash('md5').update(actualProjectPath).digest('hex');
  const sessionId = 'cursor-invalid-schema-session';
  const cursorDir = path.join(tempRoot, '.cursor', 'chats', cwdId, sessionId);

  fs.mkdirSync(actualProjectPath, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, '.claude', 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        originalPath: actualProjectPath,
      },
    }),
    'utf8',
  );
  fs.mkdirSync(cursorDir, { recursive: true });

  const db = await open({
    filename: path.join(cursorDir, 'store.db'),
    driver: sqlite3.Database,
  });

  try {
    await db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  } finally {
    await db.close();
  }

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const firstProjects = await getProjects();
    const firstProject = firstProjects.find((candidate) => candidate.name === projectName);
    assert.ok(firstProject);
    assert.deepEqual(firstProject.cursorSessions, []);

    await getProjects();
  } finally {
    console.warn = originalWarn;
  }

  const invalidWarnings = warnings.filter((entry) => entry.includes(`Skipping Cursor session ${sessionId}: missing tables: meta`));
  assert.equal(invalidWarnings.length, 1);
});
