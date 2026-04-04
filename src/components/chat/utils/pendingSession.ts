export type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

export function getPersistedPendingSessionId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return sessionStorage.getItem('pendingSessionId');
}

export function getPendingViewSessionId(
  currentSessionId: string | null,
  pendingViewSession: PendingViewSession | null,
): string | null {
  if (!pendingViewSession) {
    return null;
  }

  return pendingViewSession.sessionId || currentSessionId || null;
}
