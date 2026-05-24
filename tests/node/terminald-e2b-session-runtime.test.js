import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  __internal__resolveE2BTerminalProcessId,
  __internal__mergeLiveE2BSessionMetadata,
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

test('resolveE2BTerminalProcessId preserves an existing session shell process for claude-native sessions', () => {
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

  const sessionSeed = resolveE2BSessionTerminalSeed(sessionRecord);

  assert.equal(sessionSeed.processId, null);
  assert.equal(__internal__resolveE2BTerminalProcessId('proc_shell_5', sessionSeed), 'proc_shell_5');
  assert.equal(__internal__resolveE2BTerminalProcessId(null, sessionSeed), null);
});

test('mergeLiveE2BSessionMetadata prefers live sandbox agent session ids for terminal resume', () => {
  const sessionRecord = {
    session_id: 'e2b_session_codex',
    agent: 'codex',
    metadata_json: JSON.stringify({
      sandboxSessionId: 'e2b_session_codex',
      agentSessionId: 'stale-thread-id',
    }),
  };

  const merged = __internal__mergeLiveE2BSessionMetadata(sessionRecord, {
    sessionId: 'e2b_session_codex',
    agentSessionId: 'live-thread-id',
  });

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.metadata, {
    sandboxSessionId: 'e2b_session_codex',
    agentSessionId: 'live-thread-id',
  });
  assert.equal(merged.sessionRecord.metadata_json.agentSessionId, 'live-thread-id');
});
