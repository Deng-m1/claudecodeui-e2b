import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const { fetchSessionHistory, clearSessionHistoryCache } = await import('../../server/services/session-history/store.js');
const { getProvider } = await import('../../server/providers/registry.js');

const provider = getProvider('claude');
const originalLoadHistorySnapshot = provider.loadHistorySnapshot;

function buildMessage(index) {
  return {
    id: `message-${index}`,
    sessionId: 'session-history-test',
    timestamp: `2026-04-01T00:00:0${index}.000Z`,
    provider: 'claude',
    kind: 'text',
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `message ${index}`,
  };
}

afterEach(() => {
  clearSessionHistoryCache();
  provider.loadHistorySnapshot = originalLoadHistorySnapshot;
});

test('session history bootstrap returns the newest tail with sequence metadata', async () => {
  provider.loadHistorySnapshot = async () => ({
    messages: [1, 2, 3, 4, 5].map(buildMessage),
    tokenUsage: { used: 12, total: 100 },
    fingerprint: 'bootstrap-v1',
  });

  const result = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    { mode: 'bootstrap', limit: '2' },
  );

  assert.equal(result.mode, 'bootstrap');
  assert.equal(result.total, 5);
  assert.equal(result.hasMore, true);
  assert.equal(result.sessionVersion, 1);
  assert.equal(result.lastSeq, 5);
  assert.equal(result.oldestSeq, 4);
  assert.equal(result.newestSeq, 5);
  assert.deepEqual(result.messages.map((message) => message.id), ['message-4', 'message-5']);
  assert.deepEqual(result.messages.map((message) => message.seq), [4, 5]);
});

test('session history before pagination returns older messages before the cursor', async () => {
  provider.loadHistorySnapshot = async () => ({
    messages: [1, 2, 3, 4, 5].map(buildMessage),
    tokenUsage: null,
    fingerprint: 'before-v1',
  });

  await fetchSessionHistory('session-history-test', { provider: 'claude' }, { mode: 'bootstrap', limit: '2' });
  const result = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    { mode: 'before', beforeSeq: '4', limit: '2' },
  );

  assert.equal(result.mode, 'before');
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.messages.map((message) => message.id), ['message-2', 'message-3']);
  assert.deepEqual(result.messages.map((message) => message.seq), [2, 3]);
});

test('session history delta returns only appended messages without resetting the version', async () => {
  let snapshot = {
    messages: [1, 2, 3, 4, 5].map(buildMessage),
    tokenUsage: null,
    fingerprint: 'delta-v1',
  };

  provider.loadHistorySnapshot = async () => snapshot;

  const bootstrap = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    { mode: 'bootstrap', limit: '2' },
  );

  snapshot = {
    messages: [1, 2, 3, 4, 5, 6, 7].map(buildMessage),
    tokenUsage: null,
    fingerprint: 'delta-v2',
  };

  const delta = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    {
      mode: 'delta',
      afterSeq: String(bootstrap.lastSeq),
      sessionVersion: String(bootstrap.sessionVersion),
    },
  );

  assert.equal(delta.mode, 'delta');
  assert.equal(delta.resetRequired, false);
  assert.equal(delta.sessionVersion, 1);
  assert.equal(delta.lastSeq, 7);
  assert.deepEqual(delta.messages.map((message) => message.id), ['message-6', 'message-7']);
  assert.deepEqual(delta.messages.map((message) => message.seq), [6, 7]);
});

test('session history delta requests reset when the conversation shape changed', async () => {
  let snapshot = {
    messages: [1, 2, 3, 4, 5].map(buildMessage),
    tokenUsage: null,
    fingerprint: 'reset-v1',
  };

  provider.loadHistorySnapshot = async () => snapshot;

  const bootstrap = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    { mode: 'bootstrap', limit: '2' },
  );

  snapshot = {
    messages: [
      buildMessage(1),
      { ...buildMessage(2), content: 'message 2 rewritten' },
      buildMessage(3),
      buildMessage(4),
      buildMessage(5),
      buildMessage(6),
    ],
    tokenUsage: null,
    fingerprint: 'reset-v2',
  };

  const delta = await fetchSessionHistory(
    'session-history-test',
    { provider: 'claude' },
    {
      mode: 'delta',
      afterSeq: String(bootstrap.lastSeq),
      sessionVersion: String(bootstrap.sessionVersion),
      limit: '2',
    },
  );

  assert.equal(delta.mode, 'delta');
  assert.equal(delta.resetRequired, true);
  assert.equal(delta.sessionVersion, 2);
  assert.equal(delta.lastSeq, 6);
  assert.deepEqual(delta.messages.map((message) => message.id), ['message-5', 'message-6']);
});
