import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Eye, EyeOff, FolderOpen, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../../../../shared/view/ui';
import { getParentPath } from '../../../../project-creation-wizard/utils/pathUtils';

export type RemoteDirectorySuggestion = {
  name: string;
  path: string;
  type?: string;
};

type RemoteDirectoryBrowserModalProps = {
  isOpen: boolean;
  initialPath?: string;
  title: string;
  description?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  onBrowse: (
    pathToBrowse: string,
    options: { showHidden: boolean },
  ) => Promise<{ path: string; suggestions: RemoteDirectorySuggestion[] }>;
};

export default function RemoteDirectoryBrowserModal({
  isOpen,
  initialPath = '/',
  title,
  description,
  onClose,
  onSelect,
  onBrowse,
}: RemoteDirectoryBrowserModalProps) {
  const { t } = useTranslation(['settings', 'common']);
  const requestIdRef = useRef(0);
  const currentPathRef = useRef('/');
  const skipHiddenReloadRef = useRef(false);
  const initializedForOpenRef = useRef(false);
  const initializedPathRef = useRef('/');
  const [currentPath, setCurrentPath] = useState('/');
  const [pathDraft, setPathDraft] = useState('/');
  const [showHidden, setShowHidden] = useState(false);
  const [suggestions, setSuggestions] = useState<RemoteDirectorySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedPath, setHasLoadedPath] = useState(false);

  const loadPath = useCallback(async (targetPath: string, hidden: boolean) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await onBrowse(targetPath, { showHidden: hidden });
      if (requestId !== requestIdRef.current) {
        return;
      }

      setCurrentPath(result.path);
      currentPathRef.current = result.path;
      setPathDraft(result.path);
      setSuggestions(result.suggestions || []);
      setHasLoadedPath(true);
    } catch (caughtError) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setError(caughtError instanceof Error ? caughtError.message : 'Failed to browse remote directories');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [onBrowse]);

  useEffect(() => {
    if (!isOpen) {
      requestIdRef.current += 1;
      currentPathRef.current = '/';
      skipHiddenReloadRef.current = false;
      initializedForOpenRef.current = false;
      initializedPathRef.current = '/';
      setHasLoadedPath(false);
      return;
    }

    const nextInitialPath = initialPath.trim() || '/';
    if (initializedForOpenRef.current && initializedPathRef.current === nextInitialPath) {
      return;
    }

    initializedForOpenRef.current = true;
    initializedPathRef.current = nextInitialPath;
    setCurrentPath(nextInitialPath);
    currentPathRef.current = nextInitialPath;
    setPathDraft(nextInitialPath);
    setSuggestions([]);
    setError(null);
    setHasLoadedPath(false);
    skipHiddenReloadRef.current = true;
    void loadPath(nextInitialPath, showHidden);
  }, [initialPath, isOpen, loadPath]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (skipHiddenReloadRef.current) {
      skipHiddenReloadRef.current = false;
      return;
    }

    void loadPath(currentPathRef.current, showHidden);
  }, [isOpen, loadPath, showHidden]);

  const parentPath = useMemo(() => getParentPath(currentPath), [currentPath]);

  const handleSubmitPath = useCallback(() => {
    const nextPath = pathDraft.trim();
    if (!nextPath) {
      return;
    }

    void loadPath(nextPath, showHidden);
  }, [loadPath, pathDraft, showHidden]);

  const handleClose = useCallback(() => {
    requestIdRef.current += 1;
    setError(null);
    initializedForOpenRef.current = false;
    onClose();
  }, [onClose]);

  const handleSelectPath = useCallback((selectedPath: string) => {
    handleClose();
    queueMicrotask(() => {
      onSelect(selectedPath);
    });
  }, [handleClose, onSelect]);

  if (!isOpen) {
    return null;
  }

  const modalContent = (
    <div className="fixed inset-0 z-[10010] flex items-end justify-center bg-background/80 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        data-testid="remote-hosts-browser-modal"
        className="pointer-events-auto flex h-[100dvh] max-h-[100dvh] w-full max-w-3xl flex-col overflow-hidden border-0 bg-background shadow-2xl sm:h-auto sm:max-h-[85vh] sm:rounded-2xl sm:border sm:border-border"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            </div>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b border-border bg-muted/20 px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              data-testid="remote-hosts-browser-path-input"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder={t('remoteHosts.browser.pathPlaceholder', {
                ns: 'settings',
                defaultValue: 'Paste or type a remote directory path',
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSubmitPath();
                }
              }}
            />
            <Button
              type="button"
              data-testid="remote-hosts-browser-go"
              variant="outline"
              onClick={handleSubmitPath}
              disabled={loading}
              className="w-full justify-center sm:w-auto"
            >
              {t('remoteHosts.browser.go', { ns: 'settings', defaultValue: 'Go' })}
            </Button>
            <Button
              type="button"
              data-testid="remote-hosts-browser-toggle-hidden"
              variant="outline"
              onClick={() => setShowHidden((current) => !current)}
              className="w-full justify-center gap-2 sm:w-auto"
            >
              {showHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {showHidden
                ? t('remoteHosts.browser.hideHidden', { ns: 'settings', defaultValue: 'Hide Hidden' })
                : t('remoteHosts.browser.showHidden', { ns: 'settings', defaultValue: 'Show Hidden' })}
            </Button>
            <Button
              type="button"
              data-testid="remote-hosts-browser-refresh"
              variant="outline"
              onClick={() => void loadPath(currentPathRef.current, showHidden)}
              disabled={loading}
              className="w-full justify-center gap-2 sm:w-auto"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('buttons.refresh', { ns: 'common', defaultValue: 'Refresh' })}
            </Button>
          </div>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
              {error}
            </div>
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
          {!hasLoadedPath && loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div
              className={`space-y-2 transition-opacity ${loading ? 'pointer-events-none opacity-60' : 'opacity-100'}`}
              aria-busy={loading}
            >
              {parentPath && (
                <button
                  type="button"
                  data-testid="remote-hosts-browser-parent"
                  onClick={() => void loadPath(parentPath, showHidden)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <ChevronLeft className="h-4 w-4 text-muted-foreground" />
                  ..
                </button>
              )}

              {suggestions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('remoteHosts.browser.empty', {
                    ns: 'settings',
                    defaultValue: 'No subdirectories found here.',
                  })}
                </div>
              ) : (
                suggestions.map((suggestion) => (
                  <div key={suggestion.path} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <button
                      type="button"
                      data-testid="remote-hosts-browser-entry"
                      data-entry-path={suggestion.path}
                      onClick={() => void loadPath(suggestion.path, showHidden)}
                      className="flex flex-1 items-center gap-3 rounded-xl border border-border/60 bg-background px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent"
                    >
                      <FolderOpen className="h-4 w-4 text-primary" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{suggestion.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{suggestion.path}</div>
                      </div>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="remote-hosts-browser-select-entry"
                      data-entry-path={suggestion.path}
                      onClick={() => handleSelectPath(suggestion.path)}
                      className="w-full justify-center sm:w-auto"
                    >
                      {t('common.select', { ns: 'common', defaultValue: 'Select' })}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}

          {hasLoadedPath && loading && (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center bg-background/20 pt-6">
              <div className="rounded-full border border-border/60 bg-background/90 p-2 shadow-sm">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border bg-muted/20 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div data-testid="remote-hosts-browser-current-path" className="min-w-0 text-sm text-muted-foreground">
              {t('remoteHosts.browser.currentPath', {
                ns: 'settings',
                defaultValue: 'Current path:',
              })}{' '}
              <code className="truncate font-mono text-foreground">{currentPath}</code>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleClose} className="w-full justify-center sm:w-auto">
                {t('buttons.cancel', { ns: 'common', defaultValue: 'Cancel' })}
              </Button>
              <Button
                type="button"
                data-testid="remote-hosts-browser-select-current"
                onClick={() => handleSelectPath(currentPathRef.current)}
                className="w-full justify-center sm:w-auto"
              >
                {t('remoteHosts.browser.useCurrent', {
                  ns: 'settings',
                  defaultValue: 'Use This Directory',
                })}
              </Button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}
