import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, FolderPlus, Loader2, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, parseApiJson } from '../../../../../utils/api';
import { Badge, Button, Input } from '../../../../../shared/view/ui';
import RemoteDirectoryBrowserModal, { type RemoteDirectorySuggestion } from './RemoteDirectoryBrowserModal';

type ConnectionMode = 'bootstrap_ssh' | 'existing_agent';
type AuthMethod = 'password' | 'ssh_key';

type RemoteWorkspace = {
  id: string;
  remoteHostId: string;
  displayName: string | null;
  workspaceRoot: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

type RemoteHostRecord = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string | null;
  connectionMode: ConnectionMode;
  authMethod: AuthMethod | null;
  agentUrl: string | null;
  status: string;
  lastError: string | null;
  lastTestedAt: string | null;
  metadata?: {
    hasAgentToken?: boolean;
    hasManagedSshKey?: boolean;
    hasSavedSshPassword?: boolean;
    browseFallbackOrder?: string[];
    savePasswordFallbackEnabled?: boolean;
  } | null;
  createdAt?: string;
  updatedAt?: string;
  workspaces: RemoteWorkspace[];
};

type RemoteHostsResponse = {
  success?: boolean;
  error?: string;
  hosts?: RemoteHostRecord[];
};

type RemoteCommandProbe = {
  available?: boolean;
  path?: string | null;
};

type RemoteHostTestResult = {
  success?: boolean;
  status?: string;
  authVerified?: boolean;
  note?: string;
  error?: string;
  latencyMs?: number;
  targetHost?: string;
  targetPort?: number;
  warnings?: string[];
  remote?: {
    user?: string;
    host?: string;
    port?: number;
    home?: string | null;
    shell?: string | null;
    cwd?: string | null;
    system?: string | null;
    commands?: {
      git?: RemoteCommandProbe;
      tmux?: RemoteCommandProbe;
      claude?: RemoteCommandProbe;
      codex?: RemoteCommandProbe;
      aptGet?: RemoteCommandProbe;
    };
    configDirectories?: {
      claude?: boolean;
      codex?: boolean;
    };
    workspace?: {
      path?: string;
      parentPath?: string;
      exists?: boolean;
      isDirectory?: boolean;
      writable?: boolean;
      parentExists?: boolean;
      parentWritable?: boolean;
    };
  };
};

type RemoteWorkspaceProbe = NonNullable<RemoteHostTestResult['remote']>['workspace'];

type RemoteHostBootstrapResult = {
  success?: boolean;
  error?: string;
  note?: string;
  warnings?: string[];
  host?: RemoteHostRecord;
  bootstrap?: {
    agentUrl?: string;
    agentToken?: string;
    port?: number;
    installMode?: string;
    serviceName?: string;
    agentDir?: string | null;
    localHealthVerified?: boolean;
    platformHealthVerified?: boolean;
    platformHealthError?: string | null;
    health?: {
      version?: string | null;
    };
  };
};

type RemoteHostBrowseResult = {
  success?: boolean;
  error?: string;
  path?: string;
  suggestions?: RemoteDirectorySuggestion[];
};

type WorkspaceBrowserState =
  | {
    mode: 'form';
    initialPath: string;
  }
  | {
    mode: 'hostWorkspace';
    hostId: string;
    initialPath: string;
  };

type RemoteHostFormState = {
  label: string;
  connectionMode: ConnectionMode;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  savePasswordFallback: boolean;
  privateKey: string;
  passphrase: string;
  agentUrl: string;
  agentToken: string;
  workspaceRoot: string;
  displayName: string;
};

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const DEFAULT_FORM: RemoteHostFormState = {
  label: '',
  connectionMode: 'bootstrap_ssh',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  savePasswordFallback: false,
  privateKey: '',
  passphrase: '',
  agentUrl: '',
  agentToken: '',
  workspaceRoot: '',
  displayName: '',
};

function formatDateTime(value: string | null | undefined, translate: TranslateFn) {
  if (!value) {
    return translate('remoteHosts.shared.never', { defaultValue: 'Never' });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function getRemoteStatusLabel(status: string | null | undefined, translate: TranslateFn) {
  const normalized = typeof status === 'string' && status.trim() ? status.trim() : 'unknown';

  switch (normalized) {
    case 'reachable':
      return translate('remoteHosts.status.reachable', { defaultValue: 'reachable' });
    case 'online':
      return translate('remoteHosts.status.online', { defaultValue: 'online' });
    case 'bootstrapped':
      return translate('remoteHosts.status.bootstrapped', { defaultValue: 'bootstrapped' });
    case 'unreachable':
      return translate('remoteHosts.status.unreachable', { defaultValue: 'unreachable' });
    case 'offline':
      return translate('remoteHosts.status.offline', { defaultValue: 'offline' });
    case 'error':
      return translate('remoteHosts.status.error', { defaultValue: 'error' });
    default:
      return translate('remoteHosts.status.unknown', { defaultValue: 'unknown' });
  }
}

function getStatusBadgeClass(status: string) {
  if (status === 'reachable' || status === 'online') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300';
  }

  if (status === 'unreachable' || status === 'offline' || status === 'error') {
    return 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300';
  }

  return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
}

function getCommandBadgeClass(available?: boolean) {
  return available
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
    : 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300';
}

function getBrowseFallbackLabel(value: string, translate: TranslateFn) {
  switch (value) {
    case 'agent':
      return translate('remoteHosts.labels.agentFallback', { defaultValue: 'Agent' });
    case 'managed_key':
      return translate('remoteHosts.labels.managedSshKey', { defaultValue: 'Managed SSH Key' });
    case 'saved_password':
      return translate('remoteHosts.labels.savedPasswordFallback', { defaultValue: 'Saved Password' });
    default:
      return value;
  }
}

function describeWorkspaceProbe(workspace: RemoteWorkspaceProbe | undefined, translate: TranslateFn) {
  if (!workspace?.path) {
    return null;
  }

  if (workspace.exists && workspace.isDirectory && workspace.writable) {
    return translate('remoteHosts.workspaceProbe.existsWritable', {
      defaultValue: '{{path}} exists and is writable.',
      path: workspace.path,
    });
  }

  if (workspace.exists && workspace.isDirectory) {
    return translate('remoteHosts.workspaceProbe.existsReadonly', {
      defaultValue: '{{path}} exists but is not writable.',
      path: workspace.path,
    });
  }

  if (workspace.exists) {
    return translate('remoteHosts.workspaceProbe.existsNotDirectory', {
      defaultValue: '{{path}} exists but is not a directory.',
      path: workspace.path,
    });
  }

  if (workspace.parentExists && workspace.parentWritable) {
    return translate('remoteHosts.workspaceProbe.creatable', {
      defaultValue: '{{path}} does not exist yet, but {{parentPath}} is writable.',
      path: workspace.path,
      parentPath: workspace.parentPath || '/',
    });
  }

  if (workspace.parentExists) {
    return translate('remoteHosts.workspaceProbe.parentReadonly', {
      defaultValue: '{{path}} does not exist, and {{parentPath}} is not writable.',
      path: workspace.path,
      parentPath: workspace.parentPath || '/',
    });
  }

  return translate('remoteHosts.workspaceProbe.parentUnavailable', {
    defaultValue: '{{path}} does not exist, and its parent directory is unavailable.',
    path: workspace.path,
  });
}

export default function RemoteHostsSettingsTab() {
  const { t } = useTranslation('settings');
  const [hosts, setHosts] = useState<RemoteHostRecord[]>([]);
  const [form, setForm] = useState<RemoteHostFormState>(DEFAULT_FORM);
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [busyHostId, setBusyHostId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<RemoteHostTestResult | null>(null);
  const [bootstrapResult, setBootstrapResult] = useState<RemoteHostBootstrapResult | null>(null);
  const [workspaceBrowser, setWorkspaceBrowser] = useState<WorkspaceBrowserState | null>(null);

  const fetchHosts = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await api.remoteHosts.list();
      const payload = (await parseApiJson(response, 'Failed to load remote hosts')) as RemoteHostsResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load remote hosts');
      }

      setHosts(Array.isArray(payload?.hosts) ? payload.hosts : []);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load remote hosts');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHosts();
  }, [fetchHosts]);

  const resetTransientState = () => {
    setMessage(null);
    setError(null);
    setTestResult(null);
    setBootstrapResult(null);
  };

  const handleFormChange = <K extends keyof RemoteHostFormState>(key: K, value: RemoteHostFormState[K]) => {
    resetTransientState();
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const connectionSummary = useMemo(() => {
    if (form.connectionMode === 'existing_agent') {
      return form.agentUrl.trim() || t('remoteHosts.form.agentPlaceholder', { defaultValue: 'Existing remote agent URL' });
    }

    const host = form.host.trim() || t('remoteHosts.form.hostPlaceholder', { defaultValue: 'host.example.com' });
    const username = form.username.trim() || t('remoteHosts.shared.userFallback', { defaultValue: 'user' });
    const port = form.port.trim() || '22';
    return `${username}@${host}:${port}`;
  }, [form.agentUrl, form.connectionMode, form.host, form.port, form.username, t]);

  const fallbackUserLabel = t('remoteHosts.shared.userFallback', { defaultValue: 'user' });
  const fallbackHostLabel = t('remoteHosts.shared.hostFallback', { defaultValue: 'host' });
  const fallbackHomeLabel = t('remoteHosts.shared.homeUnavailable', { defaultValue: 'HOME unavailable' });
  const fallbackShellLabel = t('remoteHosts.shared.shellUnavailable', { defaultValue: 'unknown shell' });
  const fallbackSystemLabel = t('remoteHosts.shared.systemUnavailable', { defaultValue: 'OS unavailable' });
  const unavailableLabel = t('remoteHosts.shared.unavailable', { defaultValue: 'Unavailable' });
  const unknownLabel = t('remoteHosts.shared.unknown', { defaultValue: 'unknown' });

  const buildPayload = useCallback(() => ({
    label: form.label,
    connectionMode: form.connectionMode,
    host: form.host,
    port: Number.parseInt(form.port || '22', 10) || 22,
    username: form.username,
    authMethod: form.authMethod,
    password: form.password,
    savePasswordFallback: form.savePasswordFallback,
    privateKey: form.privateKey,
    passphrase: form.passphrase,
    agentUrl: form.agentUrl,
    agentToken: form.agentToken,
    workspaceRoot: form.workspaceRoot,
    displayName: form.displayName,
  }), [form]);

  const browseRemoteDirectories = useCallback(async (
    state: WorkspaceBrowserState,
    pathToBrowse: string,
    options: { showHidden: boolean },
  ) => {
    const draftPayload = buildPayload();
    const payload = state.mode === 'hostWorkspace'
      ? {
        hostId: state.hostId,
        path: pathToBrowse,
        showHidden: options.showHidden,
      }
      : {
        ...draftPayload,
        workspaceRoot: draftPayload.workspaceRoot.trim().startsWith('/') ? draftPayload.workspaceRoot.trim() : '',
        path: pathToBrowse,
        showHidden: options.showHidden,
      };

    const response = await api.remoteHosts.browse(payload);
    const parsed = (await parseApiJson(response, 'Failed to browse remote directories')) as RemoteHostBrowseResult | null;

    if (!response.ok) {
      throw new Error(parsed?.error || 'Failed to browse remote directories');
    }

    return {
      path: parsed?.path || pathToBrowse,
      suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions : [],
    };
  }, [buildPayload]);

  const handleWorkspaceBrowserBrowse = useCallback((
    pathToBrowse: string,
    options: { showHidden: boolean },
  ) => {
    if (!workspaceBrowser) {
      return Promise.resolve({ path: pathToBrowse, suggestions: [] as RemoteDirectorySuggestion[] });
    }

    return browseRemoteDirectories(workspaceBrowser, pathToBrowse, options);
  }, [browseRemoteDirectories, workspaceBrowser]);

  const openFormWorkspaceBrowser = () => {
    resetTransientState();
    setWorkspaceBrowser({
      mode: 'form',
      initialPath:
        form.workspaceRoot.trim()
        || testResult?.remote?.workspace?.path
        || testResult?.remote?.home
        || '/',
    });
  };

  const openHostWorkspaceBrowser = (host: RemoteHostRecord) => {
    resetTransientState();
    setWorkspaceBrowser({
      mode: 'hostWorkspace',
      hostId: host.id,
      initialPath: (workspaceDrafts[host.id] || '').trim() || host.workspaces[0]?.workspaceRoot || '/',
    });
  };

  const handleWorkspaceBrowserSelect = (selectedPath: string) => {
    resetTransientState();

    if (!workspaceBrowser) {
      return;
    }

    if (workspaceBrowser.mode === 'form') {
      setForm((current) => ({
        ...current,
        workspaceRoot: selectedPath,
      }));
    } else {
      setWorkspaceDrafts((current) => ({
        ...current,
        [workspaceBrowser.hostId]: selectedPath,
      }));
    }

    setWorkspaceBrowser(null);
  };

  const handleTestConnection = async () => {
    try {
      setIsTesting(true);
      resetTransientState();
      const response = await api.remoteHosts.test(buildPayload());
      const payload = (await parseApiJson(response, 'Failed to test remote host connectivity')) as RemoteHostTestResult | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to test remote host connectivity');
      }

      setTestResult(payload);
      setMessage(
        payload?.remote
          ? t('remoteHosts.messages.testSuccess', { defaultValue: 'Remote host probe completed.' })
          : t('remoteHosts.messages.connectionReachable', { defaultValue: 'Connection reachable.' }),
      );
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to test remote host connectivity');
    } finally {
      setIsTesting(false);
    }
  };

  const handleCreateHost = async () => {
    try {
      setIsSaving(true);
      resetTransientState();
      const response = await api.remoteHosts.create(buildPayload());
      const payload = await parseApiJson(response, 'Failed to save remote host');
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save remote host');
      }

      setForm(DEFAULT_FORM);
      setMessage(
        t('remoteHosts.messages.createSuccess', {
          defaultValue: 'Remote host metadata saved.',
        }),
      );
      await fetchHosts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to save remote host');
    } finally {
      setIsSaving(false);
    }
  };

  const handleBootstrapHost = async () => {
    try {
      setIsBootstrapping(true);
      resetTransientState();
      const response = await api.remoteHosts.bootstrap(buildPayload());
      const payload = (await parseApiJson(response, 'Failed to bootstrap remote host')) as RemoteHostBootstrapResult | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to bootstrap remote host');
      }

      setBootstrapResult(payload);
      setForm(DEFAULT_FORM);
      setMessage(
        t('remoteHosts.messages.bootstrapSuccess', { defaultValue: 'Remote host bootstrapped and saved.' }),
      );
      await fetchHosts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to bootstrap remote host');
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleDeleteHost = async (hostId: string) => {
    try {
      setBusyHostId(hostId);
      resetTransientState();
      const response = await api.remoteHosts.delete(hostId);
      const payload = await parseApiJson(response, 'Failed to delete remote host');
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to delete remote host');
      }

      setMessage(t('remoteHosts.messages.deleteHostSuccess', { defaultValue: 'Remote host deleted.' }));
      await fetchHosts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to delete remote host');
    } finally {
      setBusyHostId(null);
    }
  };

  const handleWorkspaceDraftChange = (hostId: string, value: string) => {
    resetTransientState();
    setWorkspaceDrafts((current) => ({
      ...current,
      [hostId]: value,
    }));
  };

  const handleAddWorkspace = async (hostId: string) => {
    try {
      setBusyHostId(hostId);
      resetTransientState();
      const workspaceRoot = (workspaceDrafts[hostId] || '').trim();
      const response = await api.remoteHosts.addWorkspace(hostId, { workspaceRoot });
      const payload = await parseApiJson(response, 'Failed to register remote workspace');
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to register remote workspace');
      }

      setWorkspaceDrafts((current) => ({
        ...current,
        [hostId]: '',
      }));
      setMessage(t('remoteHosts.messages.addWorkspaceSuccess', { defaultValue: 'Remote workspace registered.' }));
      await fetchHosts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to register remote workspace');
    } finally {
      setBusyHostId(null);
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    try {
      setBusyHostId(workspaceId);
      resetTransientState();
      const response = await api.remoteHosts.deleteWorkspace(workspaceId);
      const payload = await parseApiJson(response, 'Failed to delete remote workspace');
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to delete remote workspace');
      }

      setMessage(t('remoteHosts.messages.deleteWorkspaceSuccess', { defaultValue: 'Remote workspace deleted.' }));
      await fetchHosts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to delete remote workspace');
    } finally {
      setBusyHostId(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="remote-hosts-tab">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          {t('remoteHosts.title', { defaultValue: 'Remote Hosts' })}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'remoteHosts.description',
            {
              defaultValue:
                'Register remote machines and workspace roots for the remote-host runtime. Remote Claude, Codex, shell, version, auth, and resume behavior come from the remote machine itself.',
            },
          )}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t('remoteHosts.form.title', { defaultValue: 'Add Remote Host' })}
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'remoteHosts.form.description',
                {
                  defaultValue:
                    'Choose SSH bootstrap for a VS Code Remote SSH style first connection, or register an existing remote agent endpoint.',
                },
              )}
            </p>
          </div>
          <Badge variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
            {connectionSummary}
          </Badge>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">
              {t('remoteHosts.form.label', { defaultValue: 'Label' })}
            </span>
            <Input
              data-testid="remote-hosts-label"
              value={form.label}
              onChange={(event) => handleFormChange('label', event.target.value)}
              placeholder={t('remoteHosts.form.labelPlaceholder', { defaultValue: 'prod-api-host' })}
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">
              {t('remoteHosts.form.workspaceRoot', { defaultValue: 'Workspace Root' })}
            </span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                data-testid="remote-hosts-workspace-root"
                value={form.workspaceRoot}
                onChange={(event) => handleFormChange('workspaceRoot', event.target.value)}
                placeholder="/srv/app"
              />
              <Button
                data-testid="remote-hosts-browse-form-workspace-root"
                type="button"
                variant="outline"
                onClick={openFormWorkspaceBrowser}
                disabled={isTesting || isSaving || isBootstrapping}
                className="w-full justify-center sm:w-auto"
              >
                <FolderOpen className="h-4 w-4" />
                {t('remoteHosts.actions.browseRemote', { defaultValue: 'Browse Remote' })}
              </Button>
            </div>
          </div>

          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs font-medium text-foreground">
              {t('remoteHosts.form.connectionMode', { defaultValue: 'Connection Method' })}
            </span>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                data-testid="remote-hosts-mode-bootstrap"
                onClick={() => handleFormChange('connectionMode', 'bootstrap_ssh')}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  form.connectionMode === 'bootstrap_ssh'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border bg-background hover:bg-accent'
                }`}
              >
                <div className="text-sm font-semibold text-foreground">
                  {t('remoteHosts.form.modes.bootstrap', { defaultValue: 'Bootstrap via SSH' })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('remoteHosts.form.modes.bootstrapHint', { defaultValue: 'Host, port, username, and one-time SSH credentials.' })}
                </div>
              </button>

              <button
                type="button"
                data-testid="remote-hosts-mode-agent"
                onClick={() => handleFormChange('connectionMode', 'existing_agent')}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  form.connectionMode === 'existing_agent'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border bg-background hover:bg-accent'
                }`}
              >
                <div className="text-sm font-semibold text-foreground">
                  {t('remoteHosts.form.modes.agent', { defaultValue: 'Use Existing Agent' })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('remoteHosts.form.modes.agentHint', { defaultValue: 'Register a remote-agent endpoint and token.' })}
                </div>
              </button>
            </div>
          </label>

          {form.connectionMode === 'bootstrap_ssh' ? (
            <>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.host', { defaultValue: 'Host / IP' })}
                </span>
                <Input
                  data-testid="remote-hosts-host"
                  value={form.host}
                  onChange={(event) => handleFormChange('host', event.target.value)}
                  placeholder={t('remoteHosts.form.hostPlaceholder', { defaultValue: 'host.example.com' })}
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.port', { defaultValue: 'Port' })}
                </span>
                <Input
                  data-testid="remote-hosts-port"
                  value={form.port}
                  onChange={(event) => handleFormChange('port', event.target.value)}
                  inputMode="numeric"
                  placeholder="22"
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.username', { defaultValue: 'SSH Username' })}
                </span>
                <Input
                  data-testid="remote-hosts-username"
                  value={form.username}
                  onChange={(event) => handleFormChange('username', event.target.value)}
                  placeholder="ubuntu"
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.authMethod', { defaultValue: 'Auth Method' })}
                </span>
                <select
                  data-testid="remote-hosts-auth-method"
                  value={form.authMethod}
                  onChange={(event) => handleFormChange('authMethod', event.target.value as AuthMethod)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="password">{t('remoteHosts.form.passwordOption', { defaultValue: 'SSH Password' })}</option>
                  <option value="ssh_key">{t('remoteHosts.form.privateKeyOption', { defaultValue: 'SSH Private Key' })}</option>
                </select>
              </label>

              {form.authMethod === 'password' ? (
                <div className="space-y-3 md:col-span-2">
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {t('remoteHosts.form.password', { defaultValue: 'SSH Password' })}
                    </span>
                    <Input
                      data-testid="remote-hosts-password"
                      type="password"
                      value={form.password}
                      onChange={(event) => handleFormChange('password', event.target.value)}
                      placeholder={t('remoteHosts.form.passwordPlaceholder', { defaultValue: 'Used for initial bootstrap and managed-key install' })}
                    />
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5 text-sm text-foreground">
                    <input
                      data-testid="remote-hosts-save-password-fallback"
                      type="checkbox"
                      checked={form.savePasswordFallback}
                      onChange={(event) => handleFormChange('savePasswordFallback', event.target.checked)}
                      className="mt-0.5 h-4 w-4"
                    />
                    <span>
                      <span className="block font-medium">
                        {t('remoteHosts.form.savePasswordFallback', { defaultValue: 'Save password as fallback' })}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t('remoteHosts.form.savePasswordFallbackHint', {
                          defaultValue:
                            'Default off. The platform will still install and save a managed SSH key. Enable this only if you want password fallback after agent and managed-key access both fail.',
                        })}
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <>
                  <label className="space-y-1.5 md:col-span-2">
                    <span className="text-xs font-medium text-foreground">
                      {t('remoteHosts.form.privateKey', { defaultValue: 'SSH Private Key' })}
                    </span>
                    <textarea
                      data-testid="remote-hosts-private-key"
                      value={form.privateKey}
                      onChange={(event) => handleFormChange('privateKey', event.target.value)}
                      placeholder={t('remoteHosts.form.privateKeyPlaceholder', { defaultValue: 'Paste the PEM key used for bootstrap.' })}
                      className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </label>

                  <label className="space-y-1.5 md:col-span-2">
                    <span className="text-xs font-medium text-foreground">
                      {t('remoteHosts.form.passphrase', { defaultValue: 'Passphrase' })}
                    </span>
                    <Input
                      data-testid="remote-hosts-passphrase"
                      type="password"
                      value={form.passphrase}
                      onChange={(event) => handleFormChange('passphrase', event.target.value)}
                      placeholder={t('remoteHosts.form.passphrasePlaceholder', { defaultValue: 'Optional private key passphrase' })}
                    />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.agentUrl', { defaultValue: 'Agent URL' })}
                </span>
                <Input
                  data-testid="remote-hosts-agent-url"
                  value={form.agentUrl}
                  onChange={(event) => handleFormChange('agentUrl', event.target.value)}
                  placeholder="https://host.example.com:47100"
                />
              </label>

              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs font-medium text-foreground">
                  {t('remoteHosts.form.agentToken', { defaultValue: 'Agent Token' })}
                </span>
                <Input
                  data-testid="remote-hosts-agent-token"
                  type="password"
                  value={form.agentToken}
                  onChange={(event) => handleFormChange('agentToken', event.target.value)}
                  placeholder={t('remoteHosts.form.agentTokenPlaceholder', { defaultValue: 'Used for future agent authentication' })}
                />
              </label>
            </>
          )}

          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs font-medium text-foreground">
              {t('remoteHosts.form.displayName', { defaultValue: 'Initial Workspace Name' })}
            </span>
            <Input
              data-testid="remote-hosts-display-name"
              value={form.displayName}
              onChange={(event) => handleFormChange('displayName', event.target.value)}
              placeholder={t('remoteHosts.form.displayNamePlaceholder', { defaultValue: 'Optional friendly name for the first workspace' })}
            />
          </label>
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
          {t(
            'remoteHosts.form.securityNotice',
            {
              defaultValue:
                'For SSH bootstrap hosts, the platform installs and stores a managed SSH key for future access. Saving the SSH password as a fallback is optional and stays off by default. Agent tokens are also persisted when a remote agent is available.',
            },
          )}
        </div>

        {message && (
          <div data-testid="remote-hosts-message" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
            {message}
          </div>
        )}

        {error && (
          <div data-testid="remote-hosts-error" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        )}

        {testResult?.remote && (
          <div data-testid="remote-hosts-test-result" className="mt-4 rounded-xl border border-border/70 bg-background/80 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {t('remoteHosts.testResult.title', { defaultValue: 'Latest Probe Result' })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('remoteHosts.testResult.description', { defaultValue: 'Remote SSH probe completed.' })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" className={getStatusBadgeClass(testResult.status || 'unknown')}>
                  {getRemoteStatusLabel(testResult.status, t)}
                </Badge>
                <Badge variant="outline">
                  {testResult.authVerified
                    ? t('remoteHosts.testResult.authVerified', { defaultValue: 'SSH Auth Verified' })
                    : t('remoteHosts.testResult.authPending', { defaultValue: 'Auth Not Verified' })}
                </Badge>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('remoteHosts.testResult.remoteUser', { defaultValue: 'Remote User' })}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {testResult.remote.user || unknownLabel}@{testResult.remote.host || form.host || fallbackHostLabel}:{testResult.remote.port || form.port || '22'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {testResult.remote.home || fallbackHomeLabel}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('remoteHosts.testResult.shell', { defaultValue: 'Shell / OS' })}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {testResult.remote.shell || fallbackShellLabel}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {testResult.remote.system || fallbackSystemLabel}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-3 md:col-span-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('remoteHosts.testResult.workspace', { defaultValue: 'Workspace Root' })}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {testResult.remote.workspace?.path || form.workspaceRoot || '/'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {describeWorkspaceProbe(testResult.remote.workspace, t)}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {(['git', 'tmux', 'claude', 'codex'] as const).map((commandName) => {
                const probe = testResult.remote?.commands?.[commandName];
                return (
                  <Badge key={commandName} variant="secondary" className={getCommandBadgeClass(probe?.available)}>
                    {probe?.available
                      ? t('remoteHosts.testResult.commandAvailable', {
                        defaultValue: '{{command}}: {{path}}',
                        command: commandName,
                        path: probe.path || unknownLabel,
                      })
                      : t('remoteHosts.testResult.commandMissing', {
                        defaultValue: '{{command}}: missing',
                        command: commandName,
                      })}
                  </Badge>
                );
              })}
              <Badge
                variant="outline"
                className={testResult.remote?.configDirectories?.claude ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300' : ''}
              >
                {testResult.remote?.configDirectories?.claude
                  ? t('remoteHosts.testResult.configPresent', { defaultValue: '{{path}} present', path: '~/.claude' })
                  : t('remoteHosts.testResult.configMissing', { defaultValue: '{{path}} missing', path: '~/.claude' })}
              </Badge>
              <Badge
                variant="outline"
                className={testResult.remote?.configDirectories?.codex ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300' : ''}
              >
                {testResult.remote?.configDirectories?.codex
                  ? t('remoteHosts.testResult.configPresent', { defaultValue: '{{path}} present', path: '~/.codex' })
                  : t('remoteHosts.testResult.configMissing', { defaultValue: '{{path}} missing', path: '~/.codex' })}
              </Badge>
            </div>

            {testResult.note && (
              <div className="mt-3 rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                {testResult.note}
              </div>
            )}

            {typeof testResult.latencyMs === 'number' && (
              <div className="mt-3 text-xs text-muted-foreground">
                {t('remoteHosts.testResult.latency', { defaultValue: 'Probe latency:' })} {testResult.latencyMs} ms
              </div>
            )}

            {Array.isArray(testResult.warnings) && testResult.warnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                {testResult.warnings.join(' · ')}
              </div>
            )}
          </div>
        )}

        {bootstrapResult?.bootstrap && (
          <div
            data-testid="remote-hosts-bootstrap-result"
            data-bootstrap-status={bootstrapResult.bootstrap.platformHealthVerified ? 'online' : 'bootstrapped'}
            className="mt-4 rounded-xl border border-sky-200 bg-sky-50/70 p-4 text-sm dark:border-sky-900/50 dark:bg-sky-950/20"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-foreground">
                  {t('remoteHosts.bootstrap.title', { defaultValue: 'Remote Agent Bootstrapped' })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('remoteHosts.bootstrap.description', { defaultValue: 'The remote host was saved and a remote-agent was started over SSH.' })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge data-testid="remote-hosts-bootstrap-status" variant="secondary" className={getStatusBadgeClass(bootstrapResult.bootstrap.platformHealthVerified ? 'online' : 'bootstrapped')}>
                  {bootstrapResult.bootstrap.platformHealthVerified
                    ? getRemoteStatusLabel('online', t)
                    : getRemoteStatusLabel('bootstrapped', t)}
                </Badge>
                <Badge variant="outline">
                  {bootstrapResult.bootstrap.installMode || t('remoteHosts.bootstrap.installModeFallback', { defaultValue: 'bootstrap' })}
                </Badge>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-background/80 p-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('remoteHosts.bootstrap.agentUrl', { defaultValue: 'Agent URL' })}
                </div>
                <div data-testid="remote-hosts-bootstrap-agent-url" className="mt-1 break-all font-mono text-xs text-foreground">
                  {bootstrapResult.bootstrap.agentUrl || unavailableLabel}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-background/80 p-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('remoteHosts.bootstrap.version', { defaultValue: 'Agent Version' })}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {bootstrapResult.bootstrap.health?.version || unknownLabel}
                </div>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200 md:col-span-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em]">
                  {t('remoteHosts.bootstrap.agentToken', { defaultValue: 'Agent Token (shown once)' })}
                </div>
                <div data-testid="remote-hosts-bootstrap-agent-token" className="mt-1 break-all font-mono text-xs">
                  {bootstrapResult.bootstrap.agentToken || unavailableLabel}
                </div>
                <div className="mt-2 text-[11px]">
                  {t(
                    'remoteHosts.bootstrap.agentTokenHint',
                    {
                      defaultValue: 'The platform now stores this token for remote runtime access. Keep a copy if you want to re-register the host manually later.',
                    },
                  )}
                </div>
              </div>
            </div>

            {(bootstrapResult.bootstrap.agentDir || bootstrapResult.bootstrap.serviceName || typeof bootstrapResult.bootstrap.port === 'number') && (
              <div className="mt-3 text-xs text-muted-foreground">
                {[
                  bootstrapResult.bootstrap.serviceName,
                  bootstrapResult.bootstrap.agentDir,
                  typeof bootstrapResult.bootstrap.port === 'number'
                    ? t('remoteHosts.bootstrap.portLabel', {
                      defaultValue: 'port {{port}}',
                      port: bootstrapResult.bootstrap.port,
                    })
                    : null,
                ].filter(Boolean).join(' · ')}
              </div>
            )}

            {bootstrapResult.note && (
              <div className="mt-3 rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                {bootstrapResult.note}
              </div>
            )}

            {bootstrapResult.bootstrap.platformHealthError && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                {bootstrapResult.bootstrap.platformHealthError}
              </div>
            )}

            {Array.isArray(bootstrapResult.warnings) && bootstrapResult.warnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                {bootstrapResult.warnings.join(' · ')}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <Button data-testid="remote-hosts-test-connection-trigger" variant="outline" onClick={handleTestConnection} disabled={isTesting || isSaving || isBootstrapping}>
            {isTesting ? <Loader2 className="animate-spin" /> : <Server />}
            {t('remoteHosts.actions.testConnection', { defaultValue: 'Test Connection' })}
          </Button>
          {form.connectionMode === 'bootstrap_ssh' && (
            <Button data-testid="remote-hosts-bootstrap-trigger" variant="secondary" onClick={handleBootstrapHost} disabled={isBootstrapping || isSaving || isTesting}>
              {isBootstrapping ? <Loader2 className="animate-spin" /> : <Server />}
              {t('remoteHosts.actions.bootstrapHost', { defaultValue: 'Bootstrap & Save' })}
            </Button>
          )}
          <Button data-testid="remote-hosts-save-trigger" onClick={handleCreateHost} disabled={isSaving || isTesting || isBootstrapping}>
            {isSaving ? <Loader2 className="animate-spin" /> : <Plus />}
            {t('remoteHosts.actions.saveHost', { defaultValue: 'Save Remote Host' })}
          </Button>
        </div>
      </div>

      <div data-testid="remote-hosts-saved-list" className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t('remoteHosts.saved.title', { defaultValue: 'Saved Remote Hosts' })}
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'remoteHosts.saved.description',
                {
                  defaultValue:
                    'Each host can register one or more workspace roots. Workspace roots are selectable anywhere on the remote machine, but platform file and Git APIs will treat each workspace root as the project boundary.',
                },
              )}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchHosts} disabled={isLoading}>
            <RefreshCw className={isLoading ? 'animate-spin' : ''} />
            {t('remoteHosts.actions.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>

        {isLoading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('remoteHosts.saved.loading', { defaultValue: 'Loading remote hosts…' })}
          </div>
        ) : hosts.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
            {t('remoteHosts.saved.empty', { defaultValue: 'No remote hosts saved yet.' })}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {hosts.map((host) => (
              <div
                key={host.id}
                data-testid="remote-hosts-saved-host"
                data-host-id={host.id}
                className="rounded-2xl border border-border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h5 className="text-sm font-semibold text-foreground">{host.label}</h5>
                      <Badge variant="secondary" className={getStatusBadgeClass(host.status)}>
                        {getRemoteStatusLabel(host.status, t)}
                      </Badge>
                      <Badge variant="outline">
                        {host.connectionMode === 'bootstrap_ssh'
                          ? t('remoteHosts.labels.bootstrap', { defaultValue: 'SSH Bootstrap' })
                          : t('remoteHosts.labels.agent', { defaultValue: 'Existing Agent' })}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {host.connectionMode === 'bootstrap_ssh'
                        ? `${host.username || fallbackUserLabel}@${host.host}:${host.port}`
                        : host.agentUrl || `${host.host}:${host.port}`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('remoteHosts.labels.lastTested', { defaultValue: 'Last tested:' })} {formatDateTime(host.lastTestedAt, t)}
                    </div>
                    {Array.isArray(host.metadata?.browseFallbackOrder) && host.metadata.browseFallbackOrder.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {t('remoteHosts.labels.browseFallback', { defaultValue: 'Browse fallback:' })}{' '}
                        {host.metadata.browseFallbackOrder.map((step) => getBrowseFallbackLabel(step, t)).join(' -> ')}
                      </div>
                    )}
                    {(host.metadata?.hasManagedSshKey || host.metadata?.hasSavedSshPassword || host.metadata?.hasAgentToken) && (
                      <div className="flex flex-wrap gap-2">
                        {host.metadata?.hasManagedSshKey && (
                          <Badge variant="outline">
                            {t('remoteHosts.labels.managedSshKey', { defaultValue: 'Managed SSH Key' })}
                          </Badge>
                        )}
                        {host.metadata?.hasSavedSshPassword && (
                          <Badge variant="outline">
                            {t('remoteHosts.labels.savedPasswordFallback', { defaultValue: 'Saved Password' })}
                          </Badge>
                        )}
                        {host.metadata?.hasAgentToken && (
                          <Badge variant="outline">
                            {t('remoteHosts.labels.agentTokenSaved', { defaultValue: 'Agent Token' })}
                          </Badge>
                        )}
                      </div>
                    )}
                    {host.lastError && (
                      <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                        {host.lastError}
                      </div>
                    )}
                  </div>

                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDeleteHost(host.id)}
                    disabled={busyHostId === host.id}
                  >
                    {busyHostId === host.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    {t('remoteHosts.actions.deleteHost', { defaultValue: 'Delete Host' })}
                  </Button>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {t('remoteHosts.labels.workspaces', { defaultValue: 'Workspaces' })}
                  </div>

                  {host.workspaces.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
                      {t('remoteHosts.saved.emptyWorkspaces', { defaultValue: 'No workspace roots registered for this host yet.' })}
                    </div>
                  ) : (
                    host.workspaces.map((workspace) => (
                      <div key={workspace.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/80 p-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            {workspace.displayName || workspace.workspaceRoot}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{workspace.workspaceRoot}</div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteWorkspace(workspace.id)}
                          disabled={busyHostId === workspace.id}
                        >
                          {busyHostId === workspace.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                          {t('remoteHosts.actions.deleteWorkspace', { defaultValue: 'Delete' })}
                        </Button>
                      </div>
                    ))
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      data-testid="remote-hosts-add-workspace-input"
                      value={workspaceDrafts[host.id] || ''}
                      onChange={(event) => handleWorkspaceDraftChange(host.id, event.target.value)}
                      placeholder="/srv/another-project"
                    />
                    <Button
                      data-testid="remote-hosts-browse-host-workspace"
                      type="button"
                      variant="outline"
                      onClick={() => openHostWorkspaceBrowser(host)}
                      disabled={busyHostId === host.id}
                      className="w-full justify-center sm:w-auto"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t('remoteHosts.actions.browseRemote', { defaultValue: 'Browse Remote' })}
                    </Button>
                    <Button
                      data-testid="remote-hosts-add-workspace-trigger"
                      type="button"
                      variant="outline"
                      onClick={() => handleAddWorkspace(host.id)}
                      disabled={busyHostId === host.id}
                      className="w-full justify-center sm:w-auto"
                    >
                      {busyHostId === host.id ? <Loader2 className="animate-spin" /> : <FolderPlus />}
                      {t('remoteHosts.actions.addWorkspace', { defaultValue: 'Register Workspace' })}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <RemoteDirectoryBrowserModal
        isOpen={workspaceBrowser !== null}
        initialPath={workspaceBrowser?.initialPath || '/'}
        title={t('remoteHosts.browser.title', { defaultValue: 'Browse Remote Directories' })}
        description={t('remoteHosts.browser.description', {
          defaultValue: 'Open folders on the remote machine and choose a workspace root instead of typing the path manually.',
        })}
        onClose={() => setWorkspaceBrowser(null)}
        onSelect={handleWorkspaceBrowserSelect}
        onBrowse={handleWorkspaceBrowserBrowse}
      />
    </div>
  );
}
