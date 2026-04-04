import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildE2BSessionLaunchSpec,
  resolveE2BSessionTerminalSeed,
} = await import('../../terminald/runtime/index.js');

test('buildE2BSessionLaunchSpec resumes Claude with native session ids when available', () => {
  const sessionRecord = {
    agent: 'claude',
    metadata_json: JSON.stringify({
      nativeClaudeSessionId: 'claude-native-123',
      agentSessionId: 'fallback-agent-id',
    }),
  };

  assert.deepEqual(buildE2BSessionLaunchSpec(sessionRecord), {
    command: 'claude',
    args: ['--resume', 'claude-native-123'],
  });
});

test('resolveE2BSessionTerminalSeed keeps process ids and provider-native resume ids for codex', () => {
  const sessionRecord = {
    session_id: 'e2b_session_codex',
    agent: 'codex',
    metadata_json: JSON.stringify({
      processId: 'proc_77',
      agentSessionId: 'codex-thread-42',
    }),
  };

  assert.deepEqual(resolveE2BSessionTerminalSeed(sessionRecord), {
    provider: 'codex',
    processId: 'proc_77',
    resetProcessId: false,
    launchSpec: {
      command: 'codex',
      args: ['resume', 'codex-thread-42'],
    },
    metadata: {
      sessionId: 'e2b_session_codex',
      provider: 'codex',
      agentSessionId: 'codex-thread-42',
      nativeClaudeSessionId: null,
    },
  });
});

test('resolveE2BSessionTerminalSeed does not reuse claude-native bridge processes for interactive terminals', () => {
  const sessionRecord = {
    session_id: 'e2b_session_claude',
    agent: 'claude',
    metadata_json: JSON.stringify({
      runtime: 'claude-native',
      processId: 'proc_1',
      nativeClaudeSessionId: 'claude-native-123',
      agentSessionId: 'claude-native-123',
    }),
  };

  assert.deepEqual(resolveE2BSessionTerminalSeed(sessionRecord), {
    provider: 'claude',
    processId: null,
    resetProcessId: true,
    launchSpec: {
      command: 'claude',
      args: ['--resume', 'claude-native-123'],
    },
    metadata: {
      sessionId: 'e2b_session_claude',
      provider: 'claude',
      agentSessionId: 'claude-native-123',
      nativeClaudeSessionId: 'claude-native-123',
    },
  });
});
