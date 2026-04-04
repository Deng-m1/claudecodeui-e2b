import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempDbPath = path.join(os.tmpdir(), `claudecodeui-terminald-store-${process.pid}-${Date.now()}.sqlite`);
process.env.TERMINALD_DB_PATH = tempDbPath;

const {
  closeTerminalRecord,
  getProjectTerminal,
  getTerminalDatabasePath,
  listProjectTerminals,
  touchTerminal,
  upsertProjectTerminal,
} = await import('../../terminald/store.js');

after(() => {
  fs.rmSync(tempDbPath, { force: true });
  fs.rmSync(`${tempDbPath}-shm`, { force: true });
  fs.rmSync(`${tempDbPath}-wal`, { force: true });
});

test('terminald store persists project terminals with stable ids', () => {
  assert.equal(getTerminalDatabasePath(), tempDbPath);

  const created = upsertProjectTerminal({
    userId: 7,
    terminalKey: 'default',
    projectName: 'claudecodeui-e2b',
    projectRoot: '/tmp/claudecodeui-e2b',
    runtime: 'local',
    tmuxSessionName: 'ccui-local-7-main',
    processId: null,
    metadata: { source: 'test' },
    status: 'active',
  });

  assert.ok(created.id);
  assert.equal(created.projectName, 'claudecodeui-e2b');
  assert.equal(created.tmuxSessionName, 'ccui-local-7-main');

  const updated = upsertProjectTerminal({
    id: created.id,
    userId: 7,
    terminalKey: 'default',
    projectName: 'claudecodeui-e2b',
    projectRoot: '/tmp/claudecodeui-e2b',
    runtime: 'e2b',
    sandboxId: 'sandbox-123',
    tmuxSessionName: null,
    processId: 'proc-123',
    metadata: { source: 'test', migrated: true },
    status: 'active',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.runtime, 'e2b');
  assert.equal(updated.processId, 'proc-123');
  assert.equal(updated.tmuxSessionName, null);

  const fetched = getProjectTerminal(7, 'claudecodeui-e2b', 'default');
  assert.equal(fetched?.id, created.id);
  assert.equal(fetched?.sandboxId, 'sandbox-123');

  const touched = touchTerminal(created.id, 'active');
  assert.equal(touched?.status, 'active');
  assert.ok(touched?.lastAttachedAt);

  const listed = listProjectTerminals(7, 'claudecodeui-e2b');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const closed = closeTerminalRecord(created.id);
  assert.equal(closed?.status, 'closed');
});
