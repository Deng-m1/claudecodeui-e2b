import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';
import { Button, Input } from '../../../shared/view/ui';
import { browseFilesystemFolders, createFolderInFilesystem } from '../data/workspaceApi';
import { getParentPath, joinFolderPath } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  initialPath?: string;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

export default function FolderBrowserModal({
  isOpen,
  initialPath = '',
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('~');
  const [pathDraft, setPathDraft] = useState('~');
  const currentPathRef = useRef('~');
  const skipHiddenReloadRef = useRef(false);
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = useCallback(async (pathToLoad: string) => {
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders(pathToLoad, {
        showHidden: showHiddenFolders,
      });
      setCurrentPath(result.path);
      currentPathRef.current = result.path;
      setPathDraft(result.path);
      setFolders(result.suggestions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load folders');
    } finally {
      setLoadingFolders(false);
    }
  }, [showHiddenFolders]);

  useEffect(() => {
    if (!isOpen) {
      skipHiddenReloadRef.current = false;
      return;
    }

    const nextInitialPath = initialPath.trim() || '~';
    skipHiddenReloadRef.current = true;
    void loadFolders(nextInitialPath);
  }, [initialPath, isOpen, loadFolders]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (skipHiddenReloadRef.current) {
      skipHiddenReloadRef.current = false;
      return;
    }

    void loadFolders(currentPathRef.current);
  }, [isOpen, loadFolders, showHiddenFolders]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    setError(null);
    resetNewFolderState();
    onClose();
  };

  const handlePathSubmit = useCallback(() => {
    const nextPath = pathDraft.trim();
    if (!nextPath) {
      return;
    }

    void loadFolders(nextPath);
  }, [loadFolders, pathDraft]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(currentPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      resetNewFolderState();
      await loadFolders(createdPath);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }, [currentPath, loadFolders, newFolderName]);

  const parentPath = getParentPath(currentPath);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.step2.selectFolder')}
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={showHiddenFolders
                ? t('projectWizard.step2.hideHiddenFolders')
                : t('projectWizard.step2.showHiddenFolders')}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={t('projectWizard.step2.createNewFolder')}
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder={t('projectWizard.step2.pathInputPlaceholder')}
              className="flex-1"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handlePathSubmit();
                }
              }}
            />
            <Button variant="outline" onClick={handlePathSubmit} disabled={loadingFolders}>
              {t('projectWizard.step2.goToPath')}
            </Button>
          </div>
        </div>

        {showNewFolderInput && (
          <div className="border-b border-gray-200 bg-blue-50 px-4 py-3 dark:border-gray-700 dark:bg-blue-900/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('projectWizard.step2.newFolderName')}
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : t('projectWizard.step2.createFolder')}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                {t('projectWizard.step2.cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">..</span>
                </button>
              )}

              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('projectWizard.step2.noSubfolders')}
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-2">
                    <button
                      onClick={() => loadFolders(folder.path)}
                      className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <FolderPlus className="h-5 w-5 text-blue-500" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        {folder.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                      className="px-3 text-xs"
                    >
                      Select
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/50">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {t('projectWizard.step2.currentPath')}
            </span>
            <code className="flex-1 truncate font-mono text-sm text-gray-900 dark:text-white">
              {currentPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              {t('projectWizard.step2.cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => onFolderSelected(currentPath, autoAdvanceOnSelect)}
            >
              {t('projectWizard.step2.useFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
