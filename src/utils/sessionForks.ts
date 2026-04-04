import type { ProjectSession } from '../types/app';

export function getSessionForkedFromId(session: ProjectSession | null | undefined): string | null {
  if (!session || typeof session.forkedFromId !== 'string') {
    return null;
  }

  const normalized = session.forkedFromId.trim();
  return normalized || null;
}

export function getSessionForkChildCount(session: ProjectSession | null | undefined): number {
  const rawCount = Number(session?.forkChildCount || 0);
  return Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
}

export function formatShortSessionId(sessionId: string | null | undefined, length = 8): string {
  if (!sessionId) {
    return '';
  }

  return String(sessionId).slice(0, length);
}
