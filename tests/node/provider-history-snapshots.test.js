import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-history-snapshots-'));
const originalHome = process.env.HOME;
process.env.HOME = tempRoot;

const { claudeAdapter } = await import('../../server/providers/claude/adapter.js');
const { codexAdapter } = await import('../../server/providers/codex/adapter.js');
const { cursorAdapter } = await import('../../server/providers/cursor/adapter.js');
const { geminiAdapter } = await import('../../server/providers/gemini/adapter.js');

after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('claudeAdapter loads a session snapshot from the direct project file path', async () => {
  const projectName = 'provider-history-project';
  const sessionId = 'claude-history-session';
  const projectDir = path.join(tempRoot, '.claude', 'projects', projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-04-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Claude prompt' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Claude reply' }],
        },
      }),
    ].join('\n'),
    'utf8',
  );

  const snapshot = await claudeAdapter.loadHistorySnapshot(sessionId, { projectName });

  assert.deepEqual(snapshot.messages.map((message) => message.content), ['Claude prompt', 'Claude reply']);
});

test('codexAdapter resolves a rollout-prefixed nested session file without the global project index', async () => {
  const sessionId = 'codex-history-session';
  const targetDir = path.join(tempRoot, '.codex', 'sessions', '2026', '04', '01');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, `rollout-2026-04-01T00-00-00-${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-04-01T00:00:00.000Z',
        payload: {
          type: 'user_message',
          kind: 'plain',
          message: 'Codex prompt',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-04-01T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Codex reply' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-04-01T00:00:02.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 42 },
            model_context_window: 200000,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  );

  const snapshot = await codexAdapter.loadHistorySnapshot(sessionId, {});

  assert.deepEqual(snapshot.messages.map((message) => message.content), ['Codex prompt', 'Codex reply']);
  assert.equal(snapshot.tokenUsage.used, 42);
});

test('codexAdapter normalizes exec_command history entries into Bash tool messages', async () => {
  const sessionId = 'codex-exec-command-session';
  const targetDir = path.join(tempRoot, '.codex', 'sessions', '2026', '04', '02');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-04-02T00:00:01.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
          }),
          call_id: 'call-exec-command',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-04-02T00:00:02.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-exec-command',
          output: 'ok',
        },
      }),
    ].join('\n'),
    'utf8',
  );

  const snapshot = await codexAdapter.loadHistorySnapshot(sessionId, {});
  const toolUse = snapshot.messages.find((message) => message.kind === 'tool_use');

  assert.ok(toolUse);
  assert.equal(toolUse.toolName, 'Bash');
  assert.equal(
    toolUse.toolInput.command,
    "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
  );
  assert.deepEqual(toolUse.toolResult, { content: 'ok', isError: false });
});

test('cursorAdapter loads a snapshot from the specific store.db path', async () => {
  const { default: sqlite3 } = await import('sqlite3');
  const { open } = await import('sqlite');

  const sessionId = 'cursor-history-session';
  const projectPath = path.join(tempRoot, 'workspace', 'cursor-history-project');
  const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
  const cursorDir = path.join(tempRoot, '.cursor', 'chats', cwdId, sessionId);
  fs.mkdirSync(cursorDir, { recursive: true });
  const db = await open({
    filename: path.join(cursorDir, 'store.db'),
    driver: sqlite3.Database,
  });

  try {
    await db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    await db.run(
      'INSERT INTO blobs (id, data) VALUES (?, ?)',
      'a1'.repeat(16),
      Buffer.from(JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Cursor prompt' }] }), 'utf8'),
    );
    await db.run(
      'INSERT INTO blobs (id, data) VALUES (?, ?)',
      'b2'.repeat(16),
      Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Cursor reply' }] }), 'utf8'),
    );
  } finally {
    await db.close();
  }

  const snapshot = await cursorAdapter.loadHistorySnapshot(sessionId, { projectPath });

  assert.deepEqual(
    snapshot.messages.filter((message) => message.kind === 'text').map((message) => message.content),
    ['Cursor prompt', 'Cursor reply'],
  );
});

test('geminiAdapter loads a snapshot from the matching chat file', async () => {
  const sessionId = 'gemini-history-session';
  const chatsDir = path.join(tempRoot, '.gemini', 'tmp', 'gemini-project', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatsDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      messages: [
        {
          type: 'user',
          content: 'Gemini prompt',
          timestamp: '2026-04-01T00:00:00.000Z',
        },
        {
          type: 'assistant',
          content: 'Gemini reply',
          timestamp: '2026-04-01T00:00:01.000Z',
        },
      ],
    }),
    'utf8',
  );

  const snapshot = await geminiAdapter.loadHistorySnapshot(sessionId, {});

  assert.deepEqual(snapshot.messages.map((message) => message.content), ['Gemini prompt', 'Gemini reply']);
});
