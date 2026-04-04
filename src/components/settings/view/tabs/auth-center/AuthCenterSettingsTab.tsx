import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, FolderOpen, HardDriveDownload, KeyRound, Link2, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../../shared/view/ui';
import { authenticatedFetch, parseApiJson } from '../../../../../utils/api';
import type { SettingsProject } from '../../../types/types';

type ProviderId = 'claude' | 'cursor' | 'codex' | 'gemini';
type AuthSelectionMode = 'auto' | 'disabled' | 'profile';
type LoginFlow = 'callback' | 'device';
type CreateMethod = 'host' | 'path' | 'apiKey' | 'callback' | 'device';

type ProjectAuthSelection = {
  mode: AuthSelectionMode;
  profileId?: number | null;
};

type AuthProfile = {
  id: number;
  provider: ProviderId;
  name: string;
  source?: string | null;
  email?: string | null;
  summary?: string | null;
  files?: string[];
  envKeys?: string[];
  warnings?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type ProviderCapabilities = {
  supportsCallback?: boolean;
  supportsDevice?: boolean;
  supportsApiKey?: boolean;
  supportsPathImport?: boolean;
  supportsHostSnapshot?: boolean;
};

type HostAuthInfo = {
  authenticated?: boolean;
  email?: string | null;
  error?: string | null;
  method?: string | null;
  auto?: {
    summary?: string;
  };
};

type ProviderOverview = {
  host?: HostAuthInfo;
  capabilities?: ProviderCapabilities;
  profiles?: AuthProfile[];
};

type AuthCenterOverviewResponse = {
  success?: boolean;
  error?: string;
  providers?: Partial<Record<ProviderId, ProviderOverview>>;
  defaultSelections?: Partial<Record<ProviderId, ProjectAuthSelection>>;
};

type LoginStartResponse = {
  success?: boolean;
  draftId?: string;
  authUrl?: string;
  redirectUri?: string;
  verificationUrl?: string;
  userCode?: string;
  flow?: LoginFlow;
  instructions?: string;
  error?: string;
};

type ProviderFormState = {
  method: CreateMethod;
  name: string;
  path: string;
  apiKey: string;
  callbackUrl: string;
  draftId: string | null;
  authUrl: string;
  redirectUri: string;
  verificationUrl: string;
  userCode: string;
  instructions: string;
};

type QuickLoginCard = {
  key: string;
  provider: ProviderId;
  flow: LoginFlow;
};

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
];

const EMPTY_PROVIDER_FORM = (method: CreateMethod): ProviderFormState => ({
  method,
  name: '',
  path: '',
  apiKey: '',
  callbackUrl: '',
  draftId: null,
  authUrl: '',
  redirectUri: '',
  verificationUrl: '',
  userCode: '',
  instructions: '',
});

const DEFAULT_FORMS: Record<ProviderId, ProviderFormState> = {
  claude: EMPTY_PROVIDER_FORM('callback'),
  cursor: EMPTY_PROVIDER_FORM('apiKey'),
  codex: EMPTY_PROVIDER_FORM('callback'),
  gemini: EMPTY_PROVIDER_FORM('callback'),
};

const QUICK_LOGIN_CARDS: QuickLoginCard[] = [
  { key: 'codexOauth', provider: 'codex', flow: 'callback' },
  { key: 'claudeOauth', provider: 'claude', flow: 'callback' },
  { key: 'geminiOauth', provider: 'gemini', flow: 'callback' },
  { key: 'codexDevice', provider: 'codex', flow: 'device' },
];

const parseProfileId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const toErrorMessage = (value: unknown, fallback: string): string => {
  if (typeof value === 'string') {
    return value.trim() || fallback;
  }

  if (value instanceof Error) {
    return value.message || fallback;
  }

  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error_description', 'errorDescription', 'message', 'error', 'detail', 'details']) {
    if (key in record) {
      const nested = toErrorMessage(record[key], '');
      if (nested) {
        return nested;
      }
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
};

const normalizeProjectSelection = (
  rawValue: unknown,
  defaults: Partial<Record<ProviderId, ProjectAuthSelection>>,
): Record<ProviderId, ProjectAuthSelection> => {
  const source = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};
  const normalized = {} as Record<ProviderId, ProjectAuthSelection>;

  for (const { id } of PROVIDERS) {
    const rawSelection = source[id];
    const fallback = defaults[id]?.mode === 'disabled' ? 'disabled' : 'auto';
    const mode =
      rawSelection && typeof rawSelection === 'object' && (rawSelection as { mode?: string }).mode === 'profile'
        ? 'profile'
        : rawSelection && typeof rawSelection === 'object' && (rawSelection as { mode?: string }).mode === 'disabled'
          ? 'disabled'
          : fallback;

    normalized[id] = {
      mode,
      profileId:
        mode === 'profile' && rawSelection && typeof rawSelection === 'object'
          ? parseProfileId((rawSelection as { profileId?: unknown }).profileId)
          : null,
    };
  }

  return normalized;
};

const getProviderLabel = (provider: ProviderId) =>
  PROVIDERS.find((item) => item.id === provider)?.label || provider;

const getMethodOptions = (
  provider: ProviderId,
  capabilities: ProviderCapabilities | undefined,
  translate: (key: string, options?: Record<string, unknown>) => string,
) => {
  const options: { id: CreateMethod; label: string }[] = [];

  if (capabilities?.supportsCallback) {
    options.push({ id: 'callback', label: translate('authCenter.methods.callback', { defaultValue: 'Paste Callback' }) });
  }

  if (provider === 'codex' && capabilities?.supportsDevice) {
    options.push({ id: 'device', label: translate('authCenter.methods.device', { defaultValue: 'Device Code' }) });
  }

  if (capabilities?.supportsApiKey) {
    options.push({ id: 'apiKey', label: translate('authCenter.methods.apiKey', { defaultValue: 'API Key' }) });
  }

  if (capabilities?.supportsPathImport) {
    options.push({ id: 'path', label: translate('authCenter.methods.path', { defaultValue: 'Import Path' }) });
  }

  if (capabilities?.supportsHostSnapshot) {
    options.push({ id: 'host', label: translate('authCenter.methods.host', { defaultValue: 'Host Snapshot' }) });
  }

  return options;
};

type AuthCenterSettingsTabProps = {
  projects: SettingsProject[];
};

export default function AuthCenterSettingsTab({ projects }: AuthCenterSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [overview, setOverview] = useState<Record<ProviderId, ProviderOverview>>({
    claude: {},
    cursor: {},
    codex: {},
    gemini: {},
  });
  const [defaultSelections, setDefaultSelections] = useState<Partial<Record<ProviderId, ProjectAuthSelection>>>({});
  const [forms, setForms] = useState<Record<ProviderId, ProviderFormState>>(DEFAULT_FORMS);
  const [selectedProjectName, setSelectedProjectName] = useState('');
  const [projectSelections, setProjectSelections] = useState<Record<ProviderId, ProjectAuthSelection>>({
    claude: { mode: 'auto', profileId: null },
    cursor: { mode: 'auto', profileId: null },
    codex: { mode: 'auto', profileId: null },
    gemini: { mode: 'auto', profileId: null },
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        ...project,
        label: project.displayName || project.name,
      })),
    [projects],
  );

  const selectedProject = useMemo(
    () => projectOptions.find((project) => project.name === selectedProjectName) || null,
    [projectOptions, selectedProjectName],
  );

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/auth-center/overview');
      const data = (await parseApiJson(
        response,
        'Failed to load auth center overview',
      )) as AuthCenterOverviewResponse | null;
      if (!response.ok || !data?.success) {
        throw new Error(toErrorMessage(data?.error, 'Failed to load auth center overview'));
      }

      setOverview({
        claude: data.providers?.claude || {},
        cursor: data.providers?.cursor || {},
        codex: data.providers?.codex || {},
        gemini: data.providers?.gemini || {},
      });
      setDefaultSelections(data.defaultSelections || {});
    } catch (loadError) {
      setError(toErrorMessage(loadError, 'Failed to load auth center overview'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedProjectName && projectOptions.length > 0) {
      setSelectedProjectName(projectOptions[0].name);
    }
  }, [projectOptions, selectedProjectName]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    setProjectSelections(normalizeProjectSelection(selectedProject.authSelections, defaultSelections));
  }, [defaultSelections, selectedProject]);

  const setForm = useCallback((provider: ProviderId, patch: Partial<ProviderFormState>) => {
    setForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...patch,
      },
    }));
  }, []);

  const resetDraft = useCallback((provider: ProviderId) => {
    setForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        draftId: null,
        authUrl: '',
        redirectUri: '',
        verificationUrl: '',
        userCode: '',
        instructions: '',
        callbackUrl: '',
      },
    }));
  }, []);

  const handleProjectSelectionChange = (provider: ProviderId, rawValue: string) => {
    setProjectSelections((current) => {
      if (rawValue === 'auto' || rawValue === 'disabled') {
        return {
          ...current,
          [provider]: {
            mode: rawValue,
            profileId: null,
          },
        };
      }

      const profileId = rawValue.startsWith('profile:') ? parseProfileId(rawValue.slice(8)) : null;
      return {
        ...current,
        [provider]: {
          mode: profileId ? 'profile' : 'auto',
          profileId,
        },
      };
    });
  };

  const saveProjectSelections = async () => {
    if (!selectedProject) {
      return;
    }

    setIsSavingProject(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(`/api/auth-center/projects/${encodeURIComponent(selectedProject.name)}/selections`, {
        method: 'PUT',
        body: JSON.stringify({ authSelections: projectSelections }),
      });
      const data = await parseApiJson(response, 'Failed to save project auth selections');
      if (!response.ok || !data?.success) {
        throw new Error(toErrorMessage(data?.error, 'Failed to save project auth selections'));
      }

      setMessage(t('authCenter.messages.projectMappingSaved', { defaultValue: 'Project auth mapping saved.' }));
      await window.refreshProjects?.();
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save project auth selections'));
    } finally {
      setIsSavingProject(false);
    }
  };

  const createProfileRequest = async (provider: ProviderId, endpoint: string, body: Record<string, unknown>) => {
    setBusyProvider(provider);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await parseApiJson(response, 'Profile creation failed');
      if (!response.ok || !data?.success) {
        throw new Error(toErrorMessage(data?.error, 'Profile creation failed'));
      }

      setMessage(
        t('authCenter.messages.profileSaved', {
          defaultValue: '{{provider}} profile saved.',
          provider: getProviderLabel(provider),
        }),
      );
      await loadOverview();
      return true;
    } catch (requestError) {
      setError(toErrorMessage(requestError, 'Profile creation failed'));
      return false;
    } finally {
      setBusyProvider(null);
    }
  };

  const handleHostSnapshot = async (provider: ProviderId) => {
    const form = forms[provider];
    const success = await createProfileRequest(provider, '/api/auth-center/profiles/host-snapshot', {
      provider,
      name: form.name,
    });
    if (success) {
      setForm(provider, { name: '' });
    }
  };

  const handleImportPath = async (provider: ProviderId) => {
    const form = forms[provider];
    const success = await createProfileRequest(provider, '/api/auth-center/profiles/import-path', {
      provider,
      name: form.name,
      path: form.path,
    });
    if (success) {
      setForm(provider, { name: '', path: '' });
    }
  };

  const handleApiKeyCreate = async (provider: ProviderId) => {
    const form = forms[provider];
    const success = await createProfileRequest(provider, '/api/auth-center/profiles/api-key', {
      provider,
      name: form.name,
      apiKey: form.apiKey,
    });
    if (success) {
      setForm(provider, { name: '', apiKey: '' });
    }
  };

  const handleStartLogin = async (provider: ProviderId, flow: LoginFlow) => {
    setBusyProvider(provider);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/auth-center/login/start', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          flow,
          name: forms[provider].name,
        }),
      });
      const data = (await parseApiJson(
        response,
        'Could not start login flow',
      )) as LoginStartResponse | null;
      if (!response.ok || !data?.success || !data?.draftId) {
        throw new Error(toErrorMessage(data?.error, 'Could not start login flow'));
      }

      setForm(provider, {
        draftId: data.draftId,
        authUrl: data.authUrl || '',
        redirectUri: data.redirectUri || '',
        verificationUrl: data.verificationUrl || '',
        userCode: data.userCode || '',
        instructions: data.instructions || '',
      });
    } catch (startError) {
      setError(toErrorMessage(startError, 'Could not start login flow'));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleCompleteLogin = async (provider: ProviderId) => {
    const form = forms[provider];
    if (!form.draftId) {
      return;
    }

    const body =
      form.method === 'device'
        ? { draftId: form.draftId }
        : { draftId: form.draftId, callbackUrl: form.callbackUrl };

    const success = await createProfileRequest(provider, '/api/auth-center/login/complete', body);
    if (success) {
      setForm(provider, {
        name: '',
        callbackUrl: '',
      });
      resetDraft(provider);
    }
  };

  const handleDeleteProfile = async (provider: ProviderId, profileId: number) => {
    setBusyProvider(provider);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(`/api/auth-center/profiles/${profileId}`, {
        method: 'DELETE',
      });
      const data = await parseApiJson(response, 'Failed to delete profile');
      if (!response.ok || !data?.success) {
        throw new Error(toErrorMessage(data?.error, 'Failed to delete profile'));
      }

      setProjectSelections((current) => {
        if (current[provider].mode === 'profile' && current[provider].profileId === profileId) {
          return {
            ...current,
            [provider]: { mode: 'auto', profileId: null },
          };
        }
        return current;
      });
      setMessage(t('authCenter.messages.profileDeleted', { defaultValue: 'Profile deleted.' }));
      await loadOverview();
    } catch (deleteError) {
      setError(toErrorMessage(deleteError, 'Failed to delete profile'));
    } finally {
      setBusyProvider(null);
    }
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      window.setTimeout(() => setCopiedValue((current) => (current === value ? null : current)), 1500);
    } catch {
      setError(t('authCenter.messages.clipboardFailed', { defaultValue: 'Clipboard access failed' }));
    }
  };

  const openExternalUrl = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const startQuickLogin = (provider: ProviderId, flow: LoginFlow) => {
    resetDraft(provider);
    setForm(provider, { method: flow === 'device' ? 'device' : 'callback' });
    void handleStartLogin(provider, flow);
  };

  const quickLoginCards = QUICK_LOGIN_CARDS.filter((card) => {
    const capabilities = overview[card.provider]?.capabilities;
    return card.flow === 'device' ? Boolean(capabilities?.supportsDevice) : Boolean(capabilities?.supportsCallback);
  });

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border border-border bg-card px-6 py-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-4xl space-y-2">
            <h3 className="text-xl font-semibold text-foreground">
              {t('authCenter.title', { defaultValue: 'Auth Center' })}
            </h3>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
              {t('authCenter.description', {
                defaultValue:
                  'CLIProxy-style auth management for Claude, Codex, Gemini, and Cursor. Create reusable profiles, complete callback or device login flows, and bind each project to Auto Copy, Disabled, or a saved profile.',
              })}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Button variant="outline" onClick={() => void loadOverview()} disabled={isLoading}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('authCenter.actions.refresh', { defaultValue: 'Refresh' })}
            </Button>
          </div>
        </div>
      </div>

      {message && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm leading-6 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm leading-6 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-3xl border border-border bg-card px-6 py-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(260px,0.42fr)_minmax(0,0.58fr)] xl:items-start">
          <div className="space-y-2">
            <p className="text-base font-semibold text-foreground">
              {t('authCenter.sections.projectBinding.title', { defaultValue: 'Project Binding' })}
            </p>
            <p className="text-sm leading-7 text-muted-foreground">
              {t('authCenter.sections.projectBinding.description', {
                defaultValue:
                  'Choose which auth source each project should use. Cloud projects apply these selections inside E2B. Local projects keep the mapping in project config.',
              })}
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0 flex-1">
                <label className="mb-2 block text-sm font-medium text-foreground">
                  {t('authCenter.project', { defaultValue: 'Project' })}
                </label>
                <select
                  value={selectedProjectName}
                  onChange={(event) => setSelectedProjectName(event.target.value)}
                  className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none"
                >
                  {projectOptions.map((project) => (
                    <option key={project.name} value={project.name}>
                      {project.label}
                      {project.runtime === 'e2b'
                        ? ` • ${t('authCenter.labels.cloudProject', { defaultValue: 'Cloud' })}`
                        : ` • ${t('authCenter.labels.localProject', { defaultValue: 'Local' })}`}
                    </option>
                  ))}
                </select>
              </div>

              <Button onClick={saveProjectSelections} disabled={!selectedProject || isSavingProject} className="lg:self-end">
                {isSavingProject ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                {t('authCenter.actions.save', { defaultValue: 'Save' })}
              </Button>
            </div>

            {selectedProject ? (
              <div className="grid gap-3 2xl:grid-cols-2">
                {PROVIDERS.map(({ id, label }) => {
                  const profiles = overview[id]?.profiles || [];
                  const selection = projectSelections[id];
                  const selectValue =
                    selection.mode === 'profile' && selection.profileId
                      ? `profile:${selection.profileId}`
                      : selection.mode;

                  return (
                    <div key={`project-selection-${id}`} className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                      <div className="mb-2 text-sm font-medium text-foreground">{label}</div>
                      <select
                        value={selectValue}
                        onChange={(event) => handleProjectSelectionChange(id, event.target.value)}
                        className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                      >
                        <option value="auto">{t('authCenter.modes.auto', { defaultValue: 'Auto Copy Host Auth' })}</option>
                        <option value="disabled">{t('authCenter.modes.disabled', { defaultValue: 'Disabled' })}</option>
                        {profiles.map((profile) => (
                          <option key={profile.id} value={`profile:${profile.id}`}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background px-5 py-5 text-sm leading-6 text-muted-foreground">
                {t('authCenter.empty.noProjects', { defaultValue: 'No projects detected yet.' })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border bg-card px-6 py-6">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <p className="text-base font-semibold text-foreground">
              {t('authCenter.sections.oauth.title', { defaultValue: 'OAuth Login Center' })}
            </p>
            <p className="max-w-4xl text-sm leading-7 text-muted-foreground">
              {t('authCenter.sections.oauth.description', {
                defaultValue:
                  'Use the same callback paste-back flow as CLIProxyAPI. Start the login, open the authorization URL, then paste the final callback URL back here.',
              })}
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            {t('authCenter.sections.oauth.flowCount', {
              count: quickLoginCards.length,
              defaultValue: '{{count}} flows',
            })}
          </span>
        </div>

        <div className="space-y-4">
          {quickLoginCards.map((card) => {
            const providerOverview = overview[card.provider] || {};
            const form = forms[card.provider];
            const activeMethod = card.flow === 'device' ? 'device' : 'callback';
            const isDraftVisible = form.draftId && form.method === activeMethod;
            const hostInfo = providerOverview.host;
            const hostStatus = hostInfo?.authenticated
              ? hostInfo.email || hostInfo.method || t('authCenter.status.authenticated', { defaultValue: 'Authenticated' })
              : hostInfo?.error || t('authCenter.status.noHostAuth', { defaultValue: 'No host auth detected' });

            const cardTitle = t(`authCenter.cards.${card.key}.title`, {
              defaultValue: card.key,
            });
            const cardDescription = t(`authCenter.cards.${card.key}.description`, {
              defaultValue: '',
            });
            const primaryButtonLabel = t(`authCenter.cards.${card.key}.button`, {
              defaultValue:
                card.flow === 'device'
                  ? t('authCenter.actions.startDeviceLogin', { defaultValue: 'Start Device Login' })
                  : t('authCenter.actions.login', { defaultValue: 'Login' }),
            });

            return (
              <div key={card.key} className="rounded-2xl border border-border/70 bg-background px-5 py-5">
                <div className="grid gap-5 xl:grid-cols-[minmax(240px,0.34fr)_minmax(0,0.66fr)]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-base font-semibold text-foreground">{cardTitle}</p>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                          hostInfo?.authenticated
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {hostInfo?.authenticated
                          ? t('authCenter.status.ready', { defaultValue: 'Ready' })
                          : t('authCenter.status.off', { defaultValue: 'Off' })}
                      </span>
                    </div>
                    <p className="text-sm leading-7 text-muted-foreground">{cardDescription}</p>
                    <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                        {t('authCenter.labels.hostStatus', { defaultValue: 'Host Status' })}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-foreground">{hostStatus}</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-foreground">
                        {t('authCenter.fields.profileName', {
                          defaultValue: '{{provider}} profile name',
                          provider: getProviderLabel(card.provider),
                        })}
                      </label>
                      <input
                        value={form.name}
                        onChange={(event) => setForm(card.provider, { name: event.target.value })}
                        placeholder={t('authCenter.placeholders.profileName', {
                          defaultValue: '{{provider}} profile name',
                          provider: getProviderLabel(card.provider),
                        })}
                        className="w-full rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none"
                      />
                    </div>

                    {!isDraftVisible && (
                      <Button
                        variant="outline"
                        disabled={busyProvider === card.provider}
                        onClick={() => startQuickLogin(card.provider, card.flow)}
                        className="w-full justify-center"
                      >
                        {busyProvider === card.provider ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                        {primaryButtonLabel}
                      </Button>
                    )}

                    {isDraftVisible && (
                      <div className="space-y-4 rounded-2xl border border-border/70 bg-card px-4 py-4">
                        {form.instructions && (
                          <p className="text-sm leading-7 text-muted-foreground">{form.instructions}</p>
                        )}

                        {form.authUrl && (
                          <div className="space-y-3">
                            <label className="block text-sm font-medium text-foreground">
                              {t('authCenter.labels.authorizationUrl', { defaultValue: 'Authorization URL' })}
                            </label>
                            <div className="rounded-2xl border border-border bg-muted/20 px-4 py-3 text-sm leading-7 text-muted-foreground break-all">
                              {form.authUrl}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button variant="outline" size="sm" onClick={() => openExternalUrl(form.authUrl)}>
                                <ExternalLink className="mr-2 h-4 w-4" />
                                {t('authCenter.actions.openUrl', { defaultValue: 'Open URL' })}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => void copyValue(form.authUrl)}>
                                <Copy className="mr-2 h-4 w-4" />
                                {copiedValue === form.authUrl
                                  ? t('authCenter.actions.copied', { defaultValue: 'Copied' })
                                  : t('authCenter.actions.copy', { defaultValue: 'Copy' })}
                              </Button>
                            </div>
                          </div>
                        )}

                        {form.redirectUri && (
                          <div className="space-y-2">
                            <label className="block text-sm font-medium text-foreground">
                              {t('authCenter.labels.redirectUri', { defaultValue: 'Redirect URI' })}
                            </label>
                            <div className="rounded-2xl border border-border bg-muted/20 px-4 py-3 text-sm leading-7 text-muted-foreground break-all">
                              {form.redirectUri}
                            </div>
                          </div>
                        )}

                        {form.verificationUrl && (
                          <div className="space-y-3">
                            <label className="block text-sm font-medium text-foreground">
                              {t('authCenter.labels.verificationUrl', { defaultValue: 'Verification URL' })}
                            </label>
                            <div className="rounded-2xl border border-border bg-muted/20 px-4 py-3 text-sm leading-7 text-muted-foreground break-all">
                              {form.verificationUrl}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button variant="outline" size="sm" onClick={() => openExternalUrl(form.verificationUrl)}>
                                <ExternalLink className="mr-2 h-4 w-4" />
                                {t('authCenter.actions.openUrl', { defaultValue: 'Open URL' })}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => void copyValue(form.verificationUrl)}>
                                <Copy className="mr-2 h-4 w-4" />
                                {copiedValue === form.verificationUrl
                                  ? t('authCenter.actions.copied', { defaultValue: 'Copied' })
                                  : t('authCenter.actions.copy', { defaultValue: 'Copy' })}
                              </Button>
                            </div>
                            {form.userCode && (
                              <div className="rounded-2xl border border-border bg-background px-4 py-3 text-sm font-semibold text-foreground">
                                {t('authCenter.labels.code', { defaultValue: 'Code' })}: {form.userCode}
                              </div>
                            )}
                          </div>
                        )}

                        {card.flow === 'callback' && (
                          <div className="space-y-3">
                            <p className="text-sm leading-7 text-muted-foreground">
                              {t('authCenter.hints.remoteBrowserMode', {
                                defaultValue:
                                  'Remote browser mode: when the authorization flow redirects to http://localhost:..., copy the full callback URL and paste it below.',
                              })}
                            </p>
                            <textarea
                              value={form.callbackUrl}
                              onChange={(event) => setForm(card.provider, { callbackUrl: event.target.value })}
                              placeholder={t('authCenter.placeholders.callbackUrl', {
                                defaultValue: 'http://localhost:1455/auth/callback?code=...&state=...',
                              })}
                              className="min-h-28 w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none"
                            />
                          </div>
                        )}

                        <div className="flex flex-wrap gap-3">
                          <Button
                            disabled={busyProvider === card.provider || (card.flow === 'callback' && !form.callbackUrl.trim())}
                            onClick={() => void handleCompleteLogin(card.provider)}
                          >
                            {busyProvider === card.provider ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                            {card.flow === 'device'
                              ? t('authCenter.actions.submitDeviceLogin', { defaultValue: 'Submit Device Login' })
                              : t('authCenter.actions.submitCallback', { defaultValue: 'Submit Callback URL' })}
                          </Button>
                          <Button variant="outline" onClick={() => resetDraft(card.provider)}>
                            {t('authCenter.actions.cancel', { defaultValue: 'Cancel' })}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-5 2xl:grid-cols-2">
        {PROVIDERS.map(({ id, label }) => {
          const providerOverview = overview[id] || {};
          const capabilities = providerOverview.capabilities || {};
          const profiles = providerOverview.profiles || [];
          const form = forms[id];
          const managementOptions = getMethodOptions(id, capabilities, t).filter(
            (option) => option.id === 'host' || option.id === 'path' || option.id === 'apiKey',
          );
          const activeMethod = managementOptions.some((option) => option.id === form.method)
            ? form.method
            : managementOptions[0]?.id || 'host';
          const hostInfo = providerOverview.host;
          const hostStatus = hostInfo?.authenticated
            ? hostInfo.email || hostInfo.method || t('authCenter.status.authenticated', { defaultValue: 'Authenticated' })
            : hostInfo?.error || t('authCenter.status.noHostAuth', { defaultValue: 'No host auth detected' });

          return (
            <div key={id} className="rounded-3xl border border-border bg-card px-6 py-6">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <h4 className="text-base font-semibold text-foreground">
                    {t('authCenter.sections.providers.title', {
                      defaultValue: '{{provider}} Profiles',
                      provider: label,
                    })}
                  </h4>
                  <p className="text-sm leading-7 text-muted-foreground">{hostStatus}</p>
                  {hostInfo?.auto?.summary && (
                    <p className="text-xs leading-6 text-muted-foreground">{hostInfo.auto.summary}</p>
                  )}
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                    hostInfo?.authenticated
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {hostInfo?.authenticated
                    ? t('authCenter.status.ready', { defaultValue: 'Ready' })
                    : t('authCenter.status.off', { defaultValue: 'Off' })}
                </span>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {managementOptions.map((option) => (
                  <button
                    key={`${id}-${option.id}`}
                    type="button"
                    onClick={() => {
                      resetDraft(id);
                      setForm(id, { method: option.id });
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeMethod === option.id
                        ? 'bg-foreground text-background'
                        : 'border border-border text-foreground hover:bg-accent'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">
                    {t('authCenter.fields.profileName', {
                      defaultValue: '{{provider}} profile name',
                      provider: label,
                    })}
                  </label>
                  <input
                    value={form.name}
                    onChange={(event) => setForm(id, { name: event.target.value })}
                    placeholder={t('authCenter.placeholders.profileName', {
                      defaultValue: '{{provider}} profile name',
                      provider: label,
                    })}
                    className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none"
                  />
                </div>

                {activeMethod === 'host' && (
                  <Button
                    variant="outline"
                    disabled={busyProvider === id}
                    onClick={() => void handleHostSnapshot(id)}
                    className="w-full"
                  >
                    {busyProvider === id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <HardDriveDownload className="mr-2 h-4 w-4" />}
                    {t('authCenter.actions.saveCurrentHostAuth', { defaultValue: 'Save Current Host Auth' })}
                  </Button>
                )}

                {activeMethod === 'path' && (
                  <>
                    <div className="relative">
                      <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={form.path}
                        onChange={(event) => setForm(id, { path: event.target.value })}
                        placeholder={t('authCenter.placeholders.importPath', { defaultValue: 'Path to auth file or folder' })}
                        className="w-full rounded-2xl border border-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none"
                      />
                    </div>
                    <Button variant="outline" disabled={busyProvider === id || !form.path.trim()} onClick={() => void handleImportPath(id)} className="w-full">
                      {busyProvider === id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}
                      {t('authCenter.actions.importPath', { defaultValue: 'Import Path' })}
                    </Button>
                  </>
                )}

                {activeMethod === 'apiKey' && (
                  <>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="password"
                        value={form.apiKey}
                        onChange={(event) => setForm(id, { apiKey: event.target.value })}
                        placeholder={t('authCenter.placeholders.apiKey', { defaultValue: 'Paste API key' })}
                        className="w-full rounded-2xl border border-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none"
                      />
                    </div>
                    <Button variant="outline" disabled={busyProvider === id || !form.apiKey.trim()} onClick={() => void handleApiKeyCreate(id)} className="w-full">
                      {busyProvider === id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                      {t('authCenter.actions.saveApiKeyProfile', { defaultValue: 'Save API Key Profile' })}
                    </Button>
                  </>
                )}
              </div>

              <div className="mt-6 border-t border-border/60 pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">
                    {t('authCenter.sections.providers.savedProfiles', { defaultValue: 'Saved Profiles' })}
                  </p>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{profiles.length}</span>
                </div>

                {profiles.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background px-5 py-5 text-sm leading-6 text-muted-foreground">
                    {t('authCenter.empty.noSavedProfiles', { defaultValue: 'No saved profiles yet.' })}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {profiles.map((profile) => {
                      const isSelected =
                        projectSelections[id].mode === 'profile' &&
                        projectSelections[id].profileId === profile.id;

                      return (
                        <div key={profile.id} className="rounded-2xl border border-border/70 bg-background p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-medium text-foreground">{profile.name}</p>
                                {isSelected && (
                                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                    {t('authCenter.labels.projectBadge', { defaultValue: 'Project' })}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                                {profile.email || profile.summary || profile.source || t('authCenter.labels.savedProfile', { defaultValue: 'Saved profile' })}
                              </p>
                              {!!profile.files?.length && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {t('authCenter.labels.files', { defaultValue: 'Files' })}: {profile.files.join(' • ')}
                                </p>
                              )}
                              {!!profile.envKeys?.length && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {t('authCenter.labels.env', { defaultValue: 'Env' })}: {profile.envKeys.join(', ')}
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 gap-2">
                              <Button variant="outline" size="sm" onClick={() => handleProjectSelectionChange(id, `profile:${profile.id}`)}>
                                {t('authCenter.actions.use', { defaultValue: 'Use' })}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => void handleDeleteProfile(id, profile.id)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
