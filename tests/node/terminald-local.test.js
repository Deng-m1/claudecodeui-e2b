import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-terminald-local-'));

const {
  attachLocalTerminal,
  buildTmuxSessionName,
  closeLocalTerminal,
  ensureLocalTerminal,
} = await import('../../terminald/runtime/local.js');

const hasTmux = (() => {
  try {
    execFileSync('sh', ['-lc', 'command -v tmux >/dev/null']);
    return true;
  } catch {
    return false;
  }
})();

async function waitFor(fn, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = fn();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for terminal output');
}

after(async () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('local terminal bridge survives detach and reattach via tmux', { skip: !hasTmux }, async (t) => {
  const projectRoot = path.join(tempRoot, 'workspace');
  fs.mkdirSync(projectRoot, { recursive: true });

  let record = {
    id: `terminald-local-${Date.now()}`,
    userId: 11,
    terminalKey: 'default',
    projectName: 'claudecodeui-e2b',
    runtime: 'local',
    tmuxSessionName: null,
  };
  const context = {
    projectRoot,
    runtime: 'local',
  };

  try {
    record = await ensureLocalTerminal(record, context);
    assert.ok(record.tmuxSessionName);
    assert.equal(buildTmuxSessionName(record).startsWith('ccui-local-11-'), true);

    let output = '';
    const firstBridge = attachLocalTerminal(record, context, { cols: 100, rows: 30 });
    firstBridge.onOutput((chunk) => {
      output += chunk;
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    firstBridge.write('printf "terminald-local-smoke\\n"\r');
    await waitFor(() => output.includes('terminald-local-smoke'));
    firstBridge.close();

    let secondOutput = '';
    const secondBridge = attachLocalTerminal(record, context, { cols: 100, rows: 30 });
    secondBridge.onOutput((chunk) => {
      secondOutput += chunk;
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    secondBridge.write('pwd\r');
    await waitFor(() => secondOutput.includes(projectRoot));
    secondBridge.close();
  } catch (error) {
    if (/forkpty\(3\) failed/i.test(String(error?.message || error))) {
      t.skip('PTY allocation is unavailable in this execution sandbox');
      return;
    }

    throw error;
  } finally {
    await closeLocalTerminal(record).catch(() => {});
  }
});
