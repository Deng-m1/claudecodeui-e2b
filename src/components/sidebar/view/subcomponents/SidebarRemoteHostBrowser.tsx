import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, parseApiJson } from '../../../../utils/api';
import RemoteDirectoryBrowserModal, {
  type RemoteDirectorySuggestion,
} from '../../../settings/view/tabs/remote-hosts-settings/RemoteDirectoryBrowserModal';

type SidebarRemoteHostBrowserProps = {
  hostId: string;
  hostLabel: string;
  initialPath?: string;
  onClose: () => void;
  onWorkspaceAdded?: () => void;
};

type BrowseResult = {
  success?: boolean;
  error?: string;
  path?: string;
  suggestions?: RemoteDirectorySuggestion[];
};

export default function SidebarRemoteHostBrowser({
  hostId,
  hostLabel,
  initialPath,
  onClose,
  onWorkspaceAdded,
}: SidebarRemoteHostBrowserProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const handleBrowse = useCallback(
    async (path: string, options: { showHidden: boolean }) => {
      const response = await api.remoteHosts.browse({ hostId, path, showHidden: options.showHidden });
      const payload = (await parseApiJson(response, 'Failed to browse remote directories')) as BrowseResult | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to browse remote directories');
      }
      return {
        path: payload?.path || path,
        suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : [],
      };
    },
    [hostId],
  );

  const handleSelect = useCallback(
    async (selectedPath: string) => {
      try {
        setRegisterError(null);
        const response = await api.remoteHosts.addWorkspace(hostId, { workspaceRoot: selectedPath });
        const payload = await parseApiJson(response, 'Failed to register remote workspace');
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to register remote workspace');
        }
        if (typeof window !== 'undefined' && typeof window.refreshProjects === 'function') {
          void window.refreshProjects();
        }
        onWorkspaceAdded?.();
        onClose();
      } catch (caughtError) {
        setRegisterError(
          caughtError instanceof Error ? caughtError.message : 'Failed to register remote workspace',
        );
      }
    },
    [hostId, onClose, onWorkspaceAdded],
  );

  return (
    <RemoteDirectoryBrowserModal
      isOpen
      initialPath={initialPath || '/'}
      title={t('remoteHosts.browser.title', { defaultValue: 'Browse Remote Directories' }) + ` · ${hostLabel}`}
      description={
        registerError
          ? registerError
          : t('remoteHosts.browser.description', {
            defaultValue: 'Open folders on the remote machine and choose a workspace root instead of typing the path manually.',
          })
      }
      onClose={onClose}
      onSelect={(p) => {
        void handleSelect(p);
      }}
      onBrowse={handleBrowse}
    />
  );
}
