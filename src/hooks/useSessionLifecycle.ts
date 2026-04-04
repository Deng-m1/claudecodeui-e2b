import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SessionPhase =
  | 'idle'
  | 'submitting'
  | 'streaming'
  | 'processing'
  | 'complete'
  | 'error';

export type SessionLifecycleEntry = {
  phase: SessionPhase;
  text: string;
  tokens: number;
  canInterrupt: boolean;
  errorMessage?: string;
  updatedAt: number;
};

export type LifecycleAction =
  | { type: 'SUBMIT' }
  | { type: 'STREAM_ACTIVE' }
  | { type: 'SESSION_STATUS'; text: string; tokens: number; canInterrupt: boolean }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }
  | { type: 'ABORT' }
  | { type: 'PERMISSION_WAIT' }
  | { type: 'RESET' };

const IDLE_ENTRY: Readonly<SessionLifecycleEntry> = Object.freeze({
  phase: 'idle',
  text: '',
  tokens: 0,
  canInterrupt: false,
  updatedAt: 0,
});

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

function applyAction(
  entry: SessionLifecycleEntry,
  action: LifecycleAction,
): SessionLifecycleEntry {
  const now = Date.now();
  const { phase } = entry;

  switch (action.type) {
    case 'SUBMIT':
      if (phase !== 'idle' && phase !== 'complete' && phase !== 'error') return entry;
      return { phase: 'submitting', text: 'Processing', tokens: 0, canInterrupt: true, updatedAt: now };

    case 'STREAM_ACTIVE':
      if (phase === 'idle' || phase === 'complete') return entry;
      return { ...entry, phase: 'streaming', updatedAt: now };

    case 'SESSION_STATUS':
      return {
        phase: 'processing',
        text: action.text,
        tokens: action.tokens,
        canInterrupt: action.canInterrupt,
        updatedAt: now,
      };

    case 'PERMISSION_WAIT':
      return {
        phase: 'processing',
        text: 'Waiting for permission',
        tokens: 0,
        canInterrupt: true,
        updatedAt: now,
      };

    case 'COMPLETE':
      return { ...IDLE_ENTRY, phase: 'complete', updatedAt: now };

    case 'ERROR':
      return {
        phase: 'error',
        text: '',
        tokens: 0,
        canInterrupt: false,
        errorMessage: action.message,
        updatedAt: now,
      };

    case 'ABORT':
    case 'RESET':
      return { ...IDLE_ENTRY, updatedAt: now };

    default:
      return entry;
  }
}

type ClaudeStatusInfo = { text: string; tokens: number; can_interrupt: boolean } | null;

/**
 * Per-session lifecycle state machine.
 *
 * Maintains a Map<sessionId, Entry> in a ref so that non-viewed sessions
 * don't trigger re-renders. Only the actively-viewed session's entry is
 * exposed as reactive state.
 *
 * Replaces the scattered isLoading / canAbortSession / claudeStatus useState
 * with a single dispatch-driven model.
 */
export function useSessionLifecycle(activeSessionId: string | null) {
  const mapRef = useRef<Map<string, SessionLifecycleEntry>>(new Map());
  const [viewEntry, setViewEntry] = useState<SessionLifecycleEntry>(IDLE_ENTRY);
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  // Bump a counter whenever the map changes so processingSessions can re-derive
  const [mapVersion, setMapVersion] = useState(0);

  useEffect(() => {
    const entry = activeSessionId ? mapRef.current.get(activeSessionId) : null;
    setViewEntry(entry ?? IDLE_ENTRY);
  }, [activeSessionId]);

  const dispatch = useCallback((sessionId: string, action: LifecycleAction) => {
    const existing = mapRef.current.get(sessionId) ?? IDLE_ENTRY;
    const next = applyAction(existing, action);
    if (next === existing) return;

    if (next.phase === 'idle' || next.phase === 'complete') {
      mapRef.current.delete(sessionId);
    } else {
      mapRef.current.set(sessionId, next);
    }

    setMapVersion((v) => v + 1);

    if (sessionId === activeIdRef.current) {
      setViewEntry(next.phase === 'idle' ? IDLE_ENTRY : next);
    }
  }, []);

  // --- Derived values matching the existing consumer interface ---

  const isLoading =
    viewEntry.phase === 'submitting' ||
    viewEntry.phase === 'streaming' ||
    viewEntry.phase === 'processing';

  const canAbortSession = viewEntry.canInterrupt;

  const claudeStatus: ClaudeStatusInfo =
    viewEntry.phase === 'idle' || viewEntry.phase === 'complete'
      ? null
      : viewEntry.phase === 'error'
        ? { text: viewEntry.errorMessage || 'Error', tokens: 0, can_interrupt: false }
        : { text: viewEntry.text, tokens: viewEntry.tokens, can_interrupt: viewEntry.canInterrupt };

  // processingSessions: Set of session IDs currently in a non-idle/non-complete phase.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mapVersion is the invalidation signal
  const processingSessions = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const [sid, entry] of mapRef.current) {
      if (entry.phase !== 'idle' && entry.phase !== 'complete') {
        set.add(sid);
      }
    }
    return set;
  }, [mapVersion]);

  // Auto-expire stale entries
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let expired = false;

      for (const [sid, entry] of mapRef.current) {
        if (now - entry.updatedAt > PROCESSING_TIMEOUT_MS) {
          mapRef.current.delete(sid);
          expired = true;

          if (sid === activeIdRef.current) {
            setViewEntry(IDLE_ENTRY);
          }
        }
      }

      if (expired) {
        setMapVersion((v) => v + 1);
      }
    }, SWEEP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // Compat setters: wrappers around dispatch for callers that haven't migrated yet.
  // These allow gradual migration — callers can switch from setIsLoading(true) to
  // dispatch(sid, { type: 'SUBMIT' }) one at a time.
  const setIsLoading = useCallback((value: boolean) => {
    const sid = activeIdRef.current;
    if (!sid) return;
    if (value) {
      const existing = mapRef.current.get(sid);
      if (!existing || existing.phase === 'idle' || existing.phase === 'complete') {
        dispatch(sid, { type: 'SUBMIT' });
      }
    } else {
      dispatch(sid, { type: 'COMPLETE' });
    }
  }, [dispatch]);

  const setCanAbortSession = useCallback((value: boolean) => {
    const sid = activeIdRef.current;
    if (!sid) return;
    const existing = mapRef.current.get(sid);
    if (existing && existing.canInterrupt !== value) {
      mapRef.current.set(sid, { ...existing, canInterrupt: value, updatedAt: Date.now() });
      if (sid === activeIdRef.current) {
        setViewEntry((prev) => ({ ...prev, canInterrupt: value }));
      }
    }
  }, []);

  const setClaudeStatus = useCallback((status: ClaudeStatusInfo) => {
    const sid = activeIdRef.current;
    if (!sid) return;
    if (!status) {
      const existing = mapRef.current.get(sid);
      if (existing && existing.phase !== 'idle' && existing.phase !== 'complete') {
        dispatch(sid, { type: 'COMPLETE' });
      }
      return;
    }
    dispatch(sid, {
      type: 'SESSION_STATUS',
      text: status.text,
      tokens: status.tokens,
      canInterrupt: status.can_interrupt,
    });
  }, [dispatch]);

  return {
    dispatch,
    viewEntry,
    isLoading,
    canAbortSession,
    claudeStatus,
    processingSessions,
    mapRef,
    // Compat setters
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
  };
}
