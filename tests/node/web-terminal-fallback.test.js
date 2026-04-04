import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { handleWebTerminalFallbackConnection } from '../../server/utils/web-terminal-fallback.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = [];
  }

  send(data, callback) {
    this.sent.push(data);
    callback?.();
  }

  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }
}

function createFakePty() {
  const handlers = {
    data: null,
    exit: null,
  };

  return {
    writeCalls: [],
    resizeCalls: [],
    killCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    onData(callback) {
      handlers.data = callback;
    },
    onExit(callback) {
      handlers.exit = callback;
    },
    write(data) {
      this.writeCalls.push(data);
    },
    resize(cols, rows) {
      this.resizeCalls.push({ cols, rows });
    },
    kill() {
      this.killCalls += 1;
    },
    pause() {
      this.pauseCalls += 1;
    },
    resume() {
      this.resumeCalls += 1;
    },
    emitData(data) {
      handlers.data?.(data);
    },
    emitExit(event) {
      handlers.exit?.(event);
    },
  };
}

test('web terminal fallback speaks the plugin websocket protocol', () => {
  const ws = new FakeSocket();
  const fakePty = createFakePty();
  const spawnCalls = [];

  handleWebTerminalFallbackConnection(ws, {
    createSessionId: () => 'wt-test-session',
    defaultCwd: '/tmp/workspace',
    defaultShell: '/bin/bash',
    env: { HOME: '/tmp' },
    openState: 1,
    ptyModule: {
      spawn(shell, args, options) {
        spawnCalls.push({ shell, args, options });
        return fakePty;
      },
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].shell, '/bin/bash');
  assert.equal(spawnCalls[0].options.cwd, '/tmp/workspace');

  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), {
    type: 'ready',
    sessionId: 'wt-test-session',
    shell: '/bin/bash',
    cwd: '/tmp/workspace',
    fallback: true,
  });

  ws.emit('message', JSON.stringify({ type: 'input', data: 'pwd\n' }));
  ws.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  ws.emit('message', JSON.stringify({ type: 'ping' }));
  ws.emit('message', 'plain text input');

  assert.deepEqual(fakePty.writeCalls, ['pwd\n', 'plain text input']);
  assert.deepEqual(fakePty.resizeCalls, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(JSON.parse(ws.sent[1]), { type: 'pong', sessionId: 'wt-test-session' });

  fakePty.emitData('shell output');
  assert.equal(ws.sent[2], 'shell output');
  assert.equal(fakePty.pauseCalls, 1);
  assert.equal(fakePty.resumeCalls, 1);

  fakePty.emitExit({ exitCode: 7, signal: 15 });
  assert.deepEqual(JSON.parse(ws.sent[3]), {
    type: 'exit',
    sessionId: 'wt-test-session',
    exitCode: 7,
    signal: 15,
  });
  assert.deepEqual(ws.closed, [{ code: 1000, reason: 'shell exited' }]);
  assert.equal(fakePty.killCalls, 1);
});

test('web terminal fallback reports spawn failures to the client', () => {
  const ws = new FakeSocket();

  handleWebTerminalFallbackConnection(ws, {
    createSessionId: () => 'wt-fail-session',
    openState: 1,
    ptyModule: {
      spawn() {
        throw new Error('native module missing');
      },
    },
  });

  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), {
    type: 'error',
    message: 'Failed to spawn shell: native module missing',
  });
  assert.deepEqual(ws.closed, [{ code: 1011, reason: 'spawn failed' }]);
});
