import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;

const clampWidth = (value: number): number => {
  if (!Number.isFinite(value)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  if (value < SIDEBAR_MIN_WIDTH) return SIDEBAR_MIN_WIDTH;
  if (value > SIDEBAR_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;
  return Math.round(value);
};

const readStoredWidth = (): number => {
  if (typeof window === 'undefined') {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return clampWidth(parsed);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
};

export function useSidebarWidth() {
  const [width, setWidthState] = useState<number>(readStoredWidth);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const parsed = Number.parseInt(event.newValue, 10);
      if (Number.isFinite(parsed)) {
        setWidthState(clampWidth(parsed));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState((current) => {
      if (current === clamped) return current;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(clamped));
      } catch {
        // localStorage unavailable
      }
      return clamped;
    });
  }, []);

  return { width, setWidth };
}
