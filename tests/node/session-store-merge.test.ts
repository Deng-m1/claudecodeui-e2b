import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionMessageMergeInternals, type MergeableMessage } from '../../src/stores/sessionMessageMerge.ts';

const { computeMerged, reconcileRealtimeMessages } = sessionMessageMergeInternals;

function buildMessage(overrides: Partial<MergeableMessage> = {}): MergeableMessage {
  return {
    id: overrides.id || 'message-default',
    sessionId: overrides.sessionId || 'session-store-merge-test',
    timestamp: overrides.timestamp || '2026-04-01T00:00:00.000Z',
    provider: overrides.provider || 'codex',
    kind: overrides.kind || 'text',
    role: overrides.role,
    content: overrides.content,
    toolName: overrides.toolName,
    toolInput: overrides.toolInput,
    toolId: overrides.toolId,
    toolResult: overrides.toolResult,
    isError: overrides.isError,
    seq: overrides.seq,
  };
}

test('reconcileRealtimeMessages drops tool duplicates by toolId even when ids differ', () => {
  const serverMessages = [
    buildMessage({
      id: 'server-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:00:10.000Z',
      toolId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
    }),
    buildMessage({
      id: 'server-tool-result',
      kind: 'tool_result',
      timestamp: '2026-04-01T00:00:11.000Z',
      toolId: 'tool-1',
      content: '/workspace',
    }),
  ];

  const realtimeMessages = [
    buildMessage({
      id: 'realtime-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:10:10.000Z',
      toolId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
    }),
    buildMessage({
      id: 'realtime-tool-result',
      kind: 'tool_result',
      timestamp: '2026-04-01T00:10:11.000Z',
      toolId: 'tool-1',
      content: '/workspace',
    }),
  ];

  assert.deepEqual(reconcileRealtimeMessages(serverMessages, realtimeMessages), []);
});

test('computeMerged does not append trailing tool messages already represented on the server', () => {
  const serverMessages = [
    buildMessage({
      id: 'server-text-before',
      kind: 'text',
      role: 'assistant',
      content: 'Planning next step',
      seq: 1,
    }),
    buildMessage({
      id: 'server-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:00:10.000Z',
      toolId: 'tool-1',
      toolName: 'WriteFile',
      toolInput: { file_path: 'xxx-helloworld.md' },
      toolResult: { content: 'created', isError: false },
      seq: 2,
    }),
    buildMessage({
      id: 'server-text-after',
      kind: 'text',
      role: 'assistant',
      content: 'File created successfully',
      seq: 3,
    }),
  ];

  const realtimeMessages = [
    buildMessage({
      id: 'realtime-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:10:10.000Z',
      toolId: 'tool-1',
      toolName: 'WriteFile',
      toolInput: { file_path: 'xxx-helloworld.md' },
    }),
    buildMessage({
      id: 'realtime-tool-result',
      kind: 'tool_result',
      timestamp: '2026-04-01T00:10:11.000Z',
      toolId: 'tool-1',
      content: 'created',
    }),
  ];

  assert.deepEqual(
    computeMerged(serverMessages, realtimeMessages).map((message) => message.id),
    ['server-text-before', 'server-tool-use', 'server-text-after'],
  );
});

test('computeMerged keeps unmatched realtime messages visible', () => {
  const serverMessages = [
    buildMessage({
      id: 'server-text',
      kind: 'text',
      role: 'assistant',
      content: 'Existing history',
      seq: 1,
    }),
  ];

  const realtimeMessages = [
    buildMessage({
      id: 'realtime-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:10:10.000Z',
      toolId: 'tool-2',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
    }),
  ];

  assert.deepEqual(
    computeMerged(serverMessages, realtimeMessages).map((message) => message.id),
    ['server-text', 'realtime-tool-use'],
  );
});

test('computeMerged interleaves stale realtime tool messages before later server text instead of tail-appending them', () => {
  const serverMessages = [
    buildMessage({
      id: 'server-text-before',
      kind: 'text',
      role: 'assistant',
      content: 'Looking at the logs',
      timestamp: '2026-04-01T00:00:01.000Z',
      seq: 1,
    }),
    buildMessage({
      id: 'server-text-after',
      kind: 'text',
      role: 'assistant',
      content: 'The log tail is clean',
      timestamp: '2026-04-01T00:00:04.000Z',
      seq: 3,
    }),
  ];

  const realtimeMessages = [
    buildMessage({
      id: 'realtime-tool-use',
      kind: 'tool_use',
      timestamp: '2026-04-01T00:00:02.000Z',
      toolId: 'tool-tail',
      toolName: 'Bash',
      toolInput: { command: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'" },
    }),
    buildMessage({
      id: 'realtime-tool-result',
      kind: 'tool_result',
      timestamp: '2026-04-01T00:00:03.000Z',
      toolId: 'tool-tail',
      content: 'tail output',
    }),
  ];

  assert.deepEqual(
    computeMerged(serverMessages, realtimeMessages).map((message) => message.id),
    ['server-text-before', 'realtime-tool-use', 'realtime-tool-result', 'server-text-after'],
  );
});
