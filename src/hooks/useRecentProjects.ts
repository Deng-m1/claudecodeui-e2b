import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'recent-projects';
const SYNC_EVENT = 'recent-projects:sync';
const MAX_ENTRIES = 8;

export type RecentProjectEntry = {
  projectName: string;
  displayName?: string;
  runtime?: string;
  fullPath?: string;
  lastSelectedAt: number;
};

const readStored = (): RecentProjectEntry[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentProjectEntry =>
          !!entry
          && typeof entry === 'object'
          && typeof (entry as RecentProjectEntry).projectName === 'string'
          && typeof (entry as RecentProjectEntry).lastSelectedAt === 'number',
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
};

export function useRecentProjects() {
  const [entries, setEntries] = useState<RecentProjectEntry[]>(readStored);
  const instanceIdRef = useRef(`recent-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setEntries(readStored());
    };
    const handleSync = (event: Event) => {
      const customEvent = event as CustomEvent<{ sourceId: string }>;
      if (!customEvent.detail || customEvent.detail.sourceId === instanceIdRef.current) {
        return;
      }
      setEntries(readStored());
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(SYNC_EVENT, handleSync as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(SYNC_EVENT, handleSync as EventListener);
    };
  }, []);

  const trackSelection = useCallback((entry: Omit<RecentProjectEntry, 'lastSelectedAt'>) => {
    const next: RecentProjectEntry = {
      ...entry,
      lastSelectedAt: Date.now(),
    };

    setEntries((prev) => {
      const deduplicated = prev.filter((item) => item.projectName !== entry.projectName);
      const merged = [next, ...deduplicated].slice(0, MAX_ENTRIES);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        window.dispatchEvent(
          new CustomEvent(SYNC_EVENT, { detail: { sourceId: instanceIdRef.current } }),
        );
      } catch {
        // localStorage unavailable
      }
      return merged;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(
        new CustomEvent(SYNC_EVENT, { detail: { sourceId: instanceIdRef.current } }),
      );
    } catch {
      // localStorage unavailable
    }
  }, []);

  return { entries, trackSelection, clear };
}
