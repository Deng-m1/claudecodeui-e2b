import { getProvider } from '../../providers/registry.js';

const MAX_CACHED_HISTORIES = 100;
const cache = new Map();
let accessCounter = 0;

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLimit(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function buildHistoryKey(sessionId, opts = {}) {
  const provider = String(opts.provider || 'claude').trim() || 'claude';
  const projectKey = String(opts.projectPath || opts.projectName || '').trim();
  return `${provider}::${projectKey}::${sessionId}`;
}

function normalizeComparableText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stableJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value ?? '');
  }
}

function getMessageSignature(message = {}) {
  return JSON.stringify({
    kind: message.kind || '',
    role: message.role || '',
    timestamp: message.timestamp || '',
    content: normalizeComparableText(message.content),
    text: normalizeComparableText(message.text),
    toolName: message.toolName || '',
    toolId: message.toolId || '',
    toolInput: stableJson(message.toolInput),
    toolResult: stableJson(message.toolResult),
    isError: Boolean(message.isError),
    requestId: message.requestId || '',
    status: message.status || '',
    summary: normalizeComparableText(message.summary),
    actualSessionId: message.actualSessionId || '',
    newSessionId: message.newSessionId || '',
    exitCode: message.exitCode ?? null,
  });
}

function computeSnapshotFingerprint(messages = [], tokenUsage = null) {
  const length = messages.length;
  const head = length > 0 ? getMessageSignature(messages[0]) : 'head:none';
  const tail = length > 0 ? getMessageSignature(messages[length - 1]) : 'tail:none';
  return `${length}:${head}:${tail}:${stableJson(tokenUsage)}`;
}

function touchEntry(key, entry) {
  entry.accessOrder = ++accessCounter;
  cache.set(key, entry);
}

function evictIfNeeded() {
  if (cache.size <= MAX_CACHED_HISTORIES) {
    return;
  }

  const ordered = [...cache.entries()].sort((left, right) => {
    return (left[1]?.accessOrder || 0) - (right[1]?.accessOrder || 0);
  });

  const toRemove = cache.size - MAX_CACHED_HISTORIES;
  for (let index = 0; index < toRemove; index += 1) {
    const candidate = ordered[index];
    if (!candidate) {
      break;
    }
    cache.delete(candidate[0]);
  }
}

function isAppendOnly(existingMessages = [], nextMessages = []) {
  if (!existingMessages.length) {
    return true;
  }

  if (nextMessages.length < existingMessages.length) {
    return false;
  }

  for (let index = 0; index < existingMessages.length; index += 1) {
    if (getMessageSignature(existingMessages[index]) !== getMessageSignature(nextMessages[index])) {
      return false;
    }
  }

  return true;
}

function assignSequences(messages = [], existingEntry = null) {
  const appendOnly = Boolean(existingEntry) && isAppendOnly(existingEntry.messages, messages);

  if (appendOnly && existingEntry) {
    const preservedLength = existingEntry.messages.length;
    const nextMessages = messages.map((message, index) => {
      if (index < preservedLength) {
        const existingMessage = existingEntry.messages[index];
        return existingMessage.seq === index + 1
          ? { ...message, seq: existingMessage.seq }
          : { ...message, seq: index + 1 };
      }

      return {
        ...message,
        seq: index + 1,
      };
    });

    return {
      messages: nextMessages,
      version: existingEntry.version,
      appendOnly: true,
    };
  }

  return {
    messages: messages.map((message, index) => ({
      ...message,
      seq: index + 1,
    })),
    version: existingEntry ? existingEntry.version + 1 : 1,
    appendOnly: false,
  };
}

async function loadAdapterSnapshot(providerName, adapter, sessionId, opts) {
  if (adapter && typeof adapter.loadHistorySnapshot === 'function') {
    return adapter.loadHistorySnapshot(sessionId, opts);
  }

  if (!adapter || typeof adapter.fetchHistory !== 'function') {
    throw new Error(`Provider ${providerName} does not implement fetchHistory`);
  }

  const legacy = await adapter.fetchHistory(sessionId, {
    ...opts,
    limit: null,
    offset: 0,
  });

  const messages = Array.isArray(legacy?.messages) ? legacy.messages : [];
  const tokenUsage = legacy?.tokenUsage || null;

  return {
    messages,
    tokenUsage,
    fingerprint: computeSnapshotFingerprint(messages, tokenUsage),
  };
}

async function ensureHistoryEntry(sessionId, opts = {}) {
  const providerName = String(opts.provider || 'claude').trim() || 'claude';
  const adapter = getProvider(providerName);
  if (!adapter) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  const key = buildHistoryKey(sessionId, { ...opts, provider: providerName });
  const existingEntry = cache.get(key) || null;
  const snapshot = await loadAdapterSnapshot(providerName, adapter, sessionId, opts);
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const tokenUsage = snapshot?.tokenUsage || null;
  const fingerprint = snapshot?.fingerprint || computeSnapshotFingerprint(messages, tokenUsage);

  if (existingEntry && existingEntry.fingerprint === fingerprint) {
    touchEntry(key, existingEntry);
    return existingEntry;
  }

  const sequenced = assignSequences(messages, existingEntry);
  const entry = {
    key,
    provider: providerName,
    fingerprint,
    version: sequenced.version,
    messages: sequenced.messages,
    tokenUsage,
    lastSeq: sequenced.messages.length > 0 ? sequenced.messages[sequenced.messages.length - 1].seq : 0,
    accessOrder: 0,
    updatedAt: Date.now(),
  };

  touchEntry(key, entry);
  evictIfNeeded();
  return entry;
}

function buildResponse(entry, messages, extras = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  return {
    messages: safeMessages,
    total: entry.messages.length,
    hasMore: Boolean(extras.hasMore),
    offset: extras.offset ?? 0,
    limit: extras.limit ?? null,
    tokenUsage: entry.tokenUsage,
    lastSeq: entry.lastSeq,
    oldestSeq: safeMessages.length > 0 ? safeMessages[0].seq ?? null : null,
    newestSeq: safeMessages.length > 0 ? safeMessages[safeMessages.length - 1].seq ?? null : null,
    sessionVersion: entry.version,
    mode: extras.mode || 'legacy',
    resetRequired: Boolean(extras.resetRequired),
  };
}

function legacyPaginate(entry, limit = null, offset = 0) {
  if (limit === null) {
    return buildResponse(entry, entry.messages, {
      limit: null,
      offset: 0,
      hasMore: false,
      mode: 'legacy',
    });
  }

  const safeLimit = Math.max(0, Number(limit) || 0);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const total = entry.messages.length;
  const startIndex = Math.max(0, total - safeOffset - safeLimit);
  const endIndex = Math.max(startIndex, total - safeOffset);

  return buildResponse(entry, entry.messages.slice(startIndex, endIndex), {
    limit: safeLimit,
    offset: safeOffset,
    hasMore: startIndex > 0,
    mode: 'legacy',
  });
}

function bootstrapPaginate(entry, limit = 50) {
  const safeLimit = Math.max(1, Number(limit) || 50);
  const total = entry.messages.length;
  const startIndex = Math.max(0, total - safeLimit);
  return buildResponse(entry, entry.messages.slice(startIndex), {
    limit: safeLimit,
    offset: 0,
    hasMore: startIndex > 0,
    mode: 'bootstrap',
  });
}

function beforePaginate(entry, beforeSeq, limit = 50) {
  const safeLimit = Math.max(1, Number(limit) || 50);
  const targetSeq = Math.max(1, Number(beforeSeq) || 0);
  const endIndex = targetSeq > 0
    ? entry.messages.findIndex((message) => (message.seq || 0) >= targetSeq)
    : entry.messages.length;
  const resolvedEnd = endIndex >= 0 ? endIndex : entry.messages.length;
  const startIndex = Math.max(0, resolvedEnd - safeLimit);
  return buildResponse(entry, entry.messages.slice(startIndex, resolvedEnd), {
    limit: safeLimit,
    offset: 0,
    hasMore: startIndex > 0,
    mode: 'before',
  });
}

function deltaPaginate(entry, afterSeq, clientVersion, limit = null) {
  const numericClientVersion = normalizeInteger(clientVersion, 0);
  if (numericClientVersion > 0 && numericClientVersion !== entry.version) {
    return {
      ...bootstrapPaginate(entry, limit ?? 50),
      resetRequired: true,
      mode: 'delta',
    };
  }

  const safeAfterSeq = Math.max(0, Number(afterSeq) || 0);
  const startIndex = safeAfterSeq <= 0
    ? 0
    : entry.messages.findIndex((message) => (message.seq || 0) > safeAfterSeq);
  const resolvedStart = startIndex >= 0 ? startIndex : entry.messages.length;
  const rawMessages = entry.messages.slice(resolvedStart);
  const safeLimit = limit === null ? null : Math.max(0, Number(limit) || 0);
  const messages = safeLimit === null ? rawMessages : rawMessages.slice(0, safeLimit);

  return buildResponse(entry, messages, {
    limit: safeLimit,
    offset: 0,
    hasMore: false,
    mode: 'delta',
  });
}

export async function fetchSessionHistory(sessionId, opts = {}, query = {}) {
  const entry = await ensureHistoryEntry(sessionId, opts);
  const mode = String(query.mode || '').trim().toLowerCase();

  if (mode === 'bootstrap') {
    return bootstrapPaginate(entry, normalizeLimit(query.limit, 50) ?? 50);
  }

  if (mode === 'before') {
    return beforePaginate(
      entry,
      normalizeInteger(query.beforeSeq, 0),
      normalizeLimit(query.limit, 50) ?? 50,
    );
  }

  if (mode === 'delta') {
    return deltaPaginate(
      entry,
      normalizeInteger(query.afterSeq, 0),
      normalizeInteger(query.sessionVersion, 0),
      normalizeLimit(query.limit, null),
    );
  }

  return legacyPaginate(
    entry,
    normalizeLimit(query.limit, null),
    normalizeInteger(query.offset, 0),
  );
}

export function clearSessionHistoryCache() {
  cache.clear();
  accessCounter = 0;
}

export function getSessionHistoryCacheSize() {
  return cache.size;
}

export function __internal__buildHistoryKey(sessionId, opts = {}) {
  return buildHistoryKey(sessionId, opts);
}
