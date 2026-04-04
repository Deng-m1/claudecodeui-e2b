import { useCallback, useEffect, useRef, useState } from 'react';

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PROCESSING_SWEEP_INTERVAL_MS = 30 * 1000; // sweep every 30s

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());

  // Track when each session entered or exited processing so UI can ignore stale races.
  const processingTimestamps = useRef<Map<string, number>>(new Map());
  const notProcessingTimestamps = useRef<Map<string, number>>(new Map());

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const markSessionAsProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    processingTimestamps.current.set(sessionId, Date.now());
    notProcessingTimestamps.current.delete(sessionId);
    setProcessingSessions((prev) => {
      if (prev.has(sessionId)) return prev;
      return new Set([...prev, sessionId]);
    });
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    processingTimestamps.current.delete(sessionId);
    notProcessingTimestamps.current.set(sessionId, Date.now());
    setProcessingSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const wasSessionMarkedProcessingRecently = useCallback((sessionId?: string | null, windowMs = 2_500) => {
    if (!sessionId) {
      return false;
    }

    const startedAt = processingTimestamps.current.get(sessionId);
    if (!startedAt) {
      return false;
    }

    return Date.now() - startedAt <= windowMs;
  }, []);

  const wasSessionMarkedNotProcessingRecently = useCallback((sessionId?: string | null, windowMs = 10_000) => {
    if (!sessionId) {
      return false;
    }

    const stoppedAt = notProcessingTimestamps.current.get(sessionId);
    if (!stoppedAt) {
      return false;
    }

    return Date.now() - stoppedAt <= windowMs;
  }, []);

  // Periodic sweep: auto-expire processing sessions that have been stuck
  // longer than PROCESSING_TIMEOUT_MS (e.g. missed `complete` WebSocket message).
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      for (const [sid, startedAt] of processingTimestamps.current) {
        if (now - startedAt > PROCESSING_TIMEOUT_MS) {
          expired.push(sid);
        }
      }

      if (expired.length === 0) {
        return;
      }

      for (const sid of expired) {
        processingTimestamps.current.delete(sid);
        notProcessingTimestamps.current.set(sid, now);
      }

      setProcessingSessions((prev) => {
        const next = new Set(prev);
        for (const sid of expired) {
          next.delete(sid);
        }
        return next.size === prev.size ? prev : next;
      });
    }, PROCESSING_SWEEP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const replaceTemporarySession = useCallback((realSessionId?: string | null) => {
    if (!realSessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set<string>();
      for (const sessionId of prev) {
        if (!sessionId.startsWith('new-session-')) {
          next.add(sessionId);
        }
      }
      next.add(realSessionId);
      return next;
    });
  }, []);

  return {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    wasSessionMarkedProcessingRecently,
    wasSessionMarkedNotProcessingRecently,
    replaceTemporarySession,
  };
}
