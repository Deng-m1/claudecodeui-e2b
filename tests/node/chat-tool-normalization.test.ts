import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages.ts';
import { buildClaudeToolPermissionEntry } from '../../src/components/chat/utils/chatPermissions.ts';
import { normalizeToolDisplayCall } from '../../src/components/chat/utils/toolNormalization.ts';
import type { NormalizedMessage } from '../../src/stores/useSessionStore.ts';

test('normalizeToolDisplayCall maps exec_command tool calls to Bash', () => {
  const normalized = normalizeToolDisplayCall('exec_command', {
    cmd: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
    workdir: '/root/work/claudecodeui-e2b',
  });

  assert.equal(normalized.toolName, 'Bash');
  assert.deepEqual(normalized.toolInput, {
    cmd: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
    workdir: '/root/work/claudecodeui-e2b',
    command: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
  });
});

test('normalizedToChatMessages renders exec_command tool_use messages as Bash tool cards', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'tool-use-1',
      sessionId: 'session-1',
      timestamp: '2026-04-04T06:20:00.000Z',
      provider: 'codex',
      kind: 'tool_use',
      toolName: 'exec_command',
      toolInput: {
        cmd: "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
      },
      toolId: 'tool-1',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);
  const firstMessage = chatMessages[0];
  const parsedToolInput = JSON.parse(String(firstMessage?.toolInput || '{}'));

  assert.equal(chatMessages.length, 1);
  assert.equal(firstMessage?.type, 'assistant');
  assert.equal(firstMessage?.isToolUse, true);
  assert.equal(firstMessage?.toolName, 'Bash');
  assert.equal(
    parsedToolInput.command,
    "/bin/bash -lc 'tail -n 120 /tmp/claudecliui-server.log'",
  );
});

test('buildClaudeToolPermissionEntry treats exec_command as Bash for command permissions', () => {
  const entry = buildClaudeToolPermissionEntry('exec_command', {
    cmd: 'git status --short',
  });

  assert.equal(entry, 'Bash(git status:*)');
});

test('normalizedToChatMessages stringifies structured error payloads for display', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'error-1',
      sessionId: 'session-1',
      timestamp: '2026-04-07T07:00:00.000Z',
      provider: 'claude',
      kind: 'error',
      content: { message: 'Country, region, or territory not supported' } as any,
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0]?.type, 'error');
  assert.equal(chatMessages[0]?.content, 'Country, region, or territory not supported');
});
