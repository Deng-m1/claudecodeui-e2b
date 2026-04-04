/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { SessionProvider } from '../types/app';
import { authenticatedFetch } from '../utils/api';
import { computeMerged, reconcileRealtimeMessages } from './sessionMessageMerge';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: SessionProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  images?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  seq?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  oldestSeq: number | null;
  newestSeq: number | null;
  lastSeq: number;
  sessionVersion: number | null;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    oldestSeq: null,
    newestSeq: null,
    lastSeq: 0,
    sessionVersion: null,
  };
}

type HistoryResponse = {
  messages?: NormalizedMessage[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
  limit?: number | null;
  tokenUsage?: unknown;
  lastSeq?: number | null;
  oldestSeq?: number | null;
  newestSeq?: number | null;
  sessionVersion?: number | null;
  mode?: string;
  resetRequired?: boolean;
};

function getMessageIdentity(message: NormalizedMessage): string {
  if (typeof message.seq === 'number' && Number.isFinite(message.seq)) {
    return `seq:${message.seq}`;
  }

  return `id:${message.id}`;
}

function mergeUniqueMessages(
  existingMessages: NormalizedMessage[],
  incomingMessages: NormalizedMessage[],
  direction: 'prepend' | 'append',
): NormalizedMessage[] {
  if (incomingMessages.length === 0) {
    return existingMessages;
  }

  const combined = direction === 'prepend'
    ? [...incomingMessages, ...existingMessages]
    : [...existingMessages, ...incomingMessages];
  const seen = new Set<string>();
  const merged: NormalizedMessage[] = [];

  for (const message of combined) {
    const identity = getMessageIdentity(message);
    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    merged.push(message);
  }

  return merged;
}

function toOptionalPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function getOldestSeq(messages: NormalizedMessage[]): number | null {
  for (const message of messages) {
    const seq = toOptionalPositiveNumber(message.seq);
    if (seq !== null) {
      return seq;
    }
  }

  return null;
}

function getNewestSeq(messages: NormalizedMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const seq = toOptionalPositiveNumber(messages[index]?.seq);
    if (seq !== null) {
      return seq;
    }
  }

  return null;
}

function applyHistoryResponseToSlot(
  slot: SessionSlot,
  data: HistoryResponse,
  options: { preserveHasMore?: boolean } = {},
) {
  const resolvedOldestSeq =
    toOptionalPositiveNumber(data.oldestSeq) ??
    getOldestSeq(slot.serverMessages);
  const resolvedNewestSeq =
    toOptionalPositiveNumber(data.newestSeq) ??
    getNewestSeq(slot.serverMessages);
  const resolvedLastSeq =
    toOptionalPositiveNumber(data.lastSeq) ??
    resolvedNewestSeq ??
    slot.lastSeq ??
    0;

  slot.total = data.total ?? slot.serverMessages.length;
  slot.hasMore = options.preserveHasMore
    ? slot.hasMore
    : Boolean(data.hasMore);
  slot.offset = slot.serverMessages.length;
  slot.fetchedAt = Date.now();
  slot.status = 'idle';
  slot.oldestSeq = resolvedOldestSeq;
  slot.newestSeq = resolvedNewestSeq;
  slot.lastSeq = resolvedLastSeq;
  slot.sessionVersion = toOptionalPositiveNumber(data.sessionVersion);

  if (data.tokenUsage !== undefined) {
    slot.tokenUsage = data.tokenUsage;
  }
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

const LRU_MAX_SESSIONS = 20;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  const accessOrderRef = useRef(0);
  const sessionAccessMap = useRef(new Map<string, number>());
  const replaceRequestSeqRef = useRef(new Map<string, number>());
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const touchAccess = useCallback((sessionId: string) => {
    sessionAccessMap.current.set(sessionId, ++accessOrderRef.current);
  }, []);

  const evictIfNeeded = useCallback(() => {
    const store = storeRef.current;
    const accessMap = sessionAccessMap.current;
    if (store.size <= LRU_MAX_SESSIONS) return;

    const activeId = activeSessionIdRef.current;
    const entries = [...accessMap.entries()]
      .filter(([sid]) => sid !== activeId)
      .sort((a, b) => a[1] - b[1]);

    const toRemove = store.size - LRU_MAX_SESSIONS;
    for (let i = 0; i < Math.min(toRemove, entries.length); i++) {
      store.delete(entries[i][0]);
      accessMap.delete(entries[i][0]);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    const previousSessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = sessionId;

    if (sessionId) {
      touchAccess(sessionId);
    }

    if (previousSessionId === sessionId || !sessionId) {
      return;
    }

    const slot = storeRef.current.get(sessionId);
    if (!slot) {
      return;
    }

    if (slot.merged.length > 0 || slot.serverMessages.length > 0 || slot.realtimeMessages.length > 0) {
      setTick((current) => current + 1);
    }
  }, [touchAccess]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    touchAccess(sessionId);
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
      evictIfNeeded();
    }
    return store.get(sessionId)!;
  }, [touchAccess, evictIfNeeded]);

  const has = useCallback((sessionId: string) => storeRef.current.has(sessionId), []);

  const beginReplaceRequest = useCallback((sessionId: string) => {
    const nextSeq = (replaceRequestSeqRef.current.get(sessionId) || 0) + 1;
    replaceRequestSeqRef.current.set(sessionId, nextSeq);
    return nextSeq;
  }, []);

  const isLatestReplaceRequest = useCallback((sessionId: string, requestSeq: number) => {
    return replaceRequestSeqRef.current.get(sessionId) === requestSeq;
  }, []);

  /**
   * Fetch messages from the unified endpoint and populate serverMessages.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const requestSeq = beginReplaceRequest(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);

      const requestedLimit = opts.limit === undefined ? 50 : opts.limit;
      if (requestedLimit === null) {
        params.append('offset', String(opts.offset ?? 0));
      } else {
        params.append('mode', 'bootstrap');
        params.append('limit', String(requestedLimit));
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: HistoryResponse = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      if (!isLatestReplaceRequest(sessionId, requestSeq)) {
        return storeRef.current.get(sessionId) ?? slot;
      }

      slot.serverMessages = messages;
      slot.realtimeMessages = reconcileRealtimeMessages(messages, slot.realtimeMessages);
      applyHistoryResponseToSlot(slot, data);
      recomputeMergedIfNeeded(slot);

      notify(sessionId);
      return slot;
    } catch (error) {
      if (!isLatestReplaceRequest(sessionId, requestSeq)) {
        return storeRef.current.get(sessionId) ?? slot;
      }
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      slot.status = 'error';
      notify(sessionId);
      return slot;
    }
  }, [beginReplaceRequest, getSlot, isLatestReplaceRequest, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    if (opts.provider) params.append('provider', opts.provider);
    if (opts.projectName) params.append('projectName', opts.projectName);
    if (opts.projectPath) params.append('projectPath', opts.projectPath);

    const limit = opts.limit ?? 20;
    const useSeqPagination = typeof slot.oldestSeq === 'number' && slot.oldestSeq > 0;

    if (useSeqPagination) {
      params.append('mode', 'before');
      params.append('beforeSeq', String(slot.oldestSeq));
      params.append('limit', String(limit));
    } else {
      params.append('limit', String(limit));
      params.append('offset', String(slot.offset));
    }

    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: HistoryResponse = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      slot.serverMessages = mergeUniqueMessages(slot.serverMessages, olderMessages, 'prepend');
      applyHistoryResponseToSlot(slot, data);
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    let updated = [...slot.realtimeMessages, msg];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    let updated = [...slot.realtimeMessages, ...msgs];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the unified endpoint (e.g., on projects_updated).
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const requestSeq = beginReplaceRequest(sessionId);
    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);

      const canUseDelta =
        typeof slot.sessionVersion === 'number' &&
        slot.sessionVersion > 0 &&
        typeof slot.lastSeq === 'number' &&
        slot.lastSeq > 0;

      if (canUseDelta) {
        params.append('mode', 'delta');
        params.append('afterSeq', String(slot.lastSeq));
        params.append('sessionVersion', String(slot.sessionVersion));
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: HistoryResponse = await response.json();

      if (!isLatestReplaceRequest(sessionId, requestSeq)) {
        return;
      }

      const mode = String(data.mode || '').toLowerCase();
      const incomingMessages: NormalizedMessage[] = data.messages || [];
      const shouldApplyDelta = canUseDelta && mode === 'delta' && !data.resetRequired;

      if (shouldApplyDelta) {
        slot.serverMessages = mergeUniqueMessages(slot.serverMessages, incomingMessages, 'append');
        applyHistoryResponseToSlot(slot, data, { preserveHasMore: true });
      } else {
        slot.serverMessages = incomingMessages;
        applyHistoryResponseToSlot(slot, data);
      }

      slot.realtimeMessages = reconcileRealtimeMessages(slot.serverMessages, slot.realtimeMessages);
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      if (!isLatestReplaceRequest(sessionId, requestSeq)) {
        return;
      }
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [beginReplaceRequest, getSlot, isLatestReplaceRequest, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: SessionProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
