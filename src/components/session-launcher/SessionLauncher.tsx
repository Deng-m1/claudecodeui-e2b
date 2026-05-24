import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, FolderPlus, GitBranch, Loader2, Monitor, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';
import { Button } from '../../shared/view/ui';
import { authenticatedFetch, parseApiJson } from '../../utils/api';
import {
  type GitHubBranch,
  type GitHubRepo,
  fetchGitHubBranches,
  fetchGitHubOAuthStatus,
  fetchGitHubRepos,
  mergeGitHubRepos,
  matchesGitHubRepoQuery,
  resolveGitHubBranchSelection,
} from '../../utils/github';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../shared/modelConstants';
import type { Project, SessionProvider } from '../../types/app';

type SessionLauncherProps = {
  projects: Project[];
  onClose: () => void;
  onOpenProject: (project: Project) => void;
  onOpenNewProjectWizard: () => void;
};

type LauncherMode = 'local' | 'cloud' | 'project';

type ProviderDef = {
  id: Exclude<SessionProvider, 'e2b'>;
  name: string;
  accent: string;
  ring: string;
  check: string;
};

type CloudAuthMode = 'auto' | 'profile' | 'disabled';

type CloudAuthSelection = {
  mode: CloudAuthMode;
  profileId?: number | null;
};

type CloudAuthProfile = {
  id: number;
  name: string;
  email?: string | null;
  summary?: string | null;
  source?: string | null;
};

type CloudAuthSource = {
  authenticated?: boolean;
  email?: string | null;
  error?: string | null;
  method?: string | null;
  defaultMode?: CloudAuthMode;
  profiles?: CloudAuthProfile[];
  auto?: {
    available?: boolean;
    summary?: string;
    files?: string[];
    envKeys?: string[];
    warnings?: string[];
  };
};

type AuthSourcesResponse = {
  success?: boolean;
  error?: string;
  providers?: Partial<Record<ProviderDef['id'], { host?: CloudAuthSource; profiles?: CloudAuthProfile[] }>>;
  defaultSelections?: Partial<Record<ProviderDef['id'], CloudAuthSelection>>;
};

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    accent: 'border-primary',
    ring: 'ring-primary/15',
    check: 'bg-primary text-primary-foreground',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    accent: 'border-violet-500 dark:border-violet-400',
    ring: 'ring-violet-500/15',
    check: 'bg-violet-500 text-white',
  },
  {
    id: 'codex',
    name: 'Codex',
    accent: 'border-emerald-600 dark:border-emerald-400',
    ring: 'ring-emerald-600/15',
    check: 'bg-emerald-600 text-white dark:bg-emerald-500',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    accent: 'border-blue-500 dark:border-blue-400',
    ring: 'ring-blue-500/15',
    check: 'bg-blue-500 text-white',
  },
];

const getModelConfig = (provider: ProviderDef['id']) => {
  if (provider === 'claude') return CLAUDE_MODELS;
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'gemini') return GEMINI_MODELS;
  return CURSOR_MODELS;
};

const getInitialProvider = (): ProviderDef['id'] => {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('selected-provider') : null;
  if (stored === 'cursor' || stored === 'codex' || stored === 'gemini') {
    return stored;
  }
  return 'claude';
};

const VALID_CURSOR_MODELS = new Set(CURSOR_MODELS.OPTIONS.map((option) => option.value));

const getInitialCursorModel = () => {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('cursor-model') : null;
  return stored && VALID_CURSOR_MODELS.has(stored) ? stored : CURSOR_MODELS.DEFAULT;
};

const dispatchLaunchConfig = (detail: Record<string, unknown>) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof detail.provider === 'string' && detail.provider) {
    localStorage.setItem('selected-provider', detail.provider);
  }

  if (typeof detail.runtimeMode === 'string' && detail.runtimeMode) {
    localStorage.setItem('runtime-mode', detail.runtimeMode);
  }

  if (typeof detail.claudeModel === 'string' && detail.claudeModel) {
    localStorage.setItem('claude-model', detail.claudeModel);
  }

  if (typeof detail.cursorModel === 'string' && detail.cursorModel) {
    localStorage.setItem('cursor-model', detail.cursorModel);
  }

  if (typeof detail.codexModel === 'string' && detail.codexModel) {
    localStorage.setItem('codex-model', detail.codexModel);
  }

  if (typeof detail.geminiModel === 'string' && detail.geminiModel) {
    localStorage.setItem('gemini-model', detail.geminiModel);
  }

  window.dispatchEvent(new CustomEvent('claudecodeui:launch-config', { detail }));
};

const createDefaultAuthSelection = (): CloudAuthSelection => ({
  mode: 'auto',
  profileId: null,
});

const createDefaultAuthSource = (): CloudAuthSource => ({
  authenticated: false,
  email: null,
  error: null,
  method: null,
  defaultMode: 'auto',
  profiles: [],
  auto: {
    available: false,
    summary: 'No syncable local auth detected',
    files: [],
    envKeys: [],
    warnings: [],
  },
});

const buildEmptyAuthSourceMap = (): Record<ProviderDef['id'], CloudAuthSource> => ({
  claude: createDefaultAuthSource(),
  cursor: createDefaultAuthSource(),
  codex: createDefaultAuthSource(),
  gemini: createDefaultAuthSource(),
});

const buildEmptyAuthSelectionMap = (): Record<ProviderDef['id'], CloudAuthSelection> => ({
  claude: createDefaultAuthSelection(),
  cursor: createDefaultAuthSelection(),
  codex: createDefaultAuthSelection(),
  gemini: createDefaultAuthSelection(),
});

export default function SessionLauncher({
  projects,
  onClose,
  onOpenProject,
  onOpenNewProjectWizard,
}: SessionLauncherProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<LauncherMode>('local');
  const [provider, setProvider] = useState<ProviderDef['id']>(getInitialProvider);
  const [claudeModel, setClaudeModel] = useState(() => localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT);
  const [cursorModel, setCursorModel] = useState(getInitialCursorModel);
  const [codexModel, setCodexModel] = useState(() => localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT);
  const [geminiModel, setGeminiModel] = useState(() => localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT);
  const [selectedLocalProjectName, setSelectedLocalProjectName] = useState('');
  const [githubConnected, setGithubConnected] = useState(false);
  const [e2bConfigured, setE2BConfigured] = useState(false);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoCatalog, setRepoCatalog] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isCreatingCloudProject, setIsCreatingCloudProject] = useState(false);
  const [isLoadingAuthSources, setIsLoadingAuthSources] = useState(false);
  const [authSources, setAuthSources] = useState<Record<ProviderDef['id'], CloudAuthSource>>(buildEmptyAuthSourceMap);
  const [authSelections, setAuthSelections] = useState<Record<ProviderDef['id'], CloudAuthSelection>>(buildEmptyAuthSelectionMap);
  const [hasInitializedAuthSelections, setHasInitializedAuthSelections] = useState(false);
  const hasUserTouchedAuthSelectionsRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);

  const localProjects = useMemo(
    () => projects.filter((project) => project.runtime !== 'e2b'),
    [projects],
  );

  const currentModel = useMemo(() => {
    if (provider === 'claude') return claudeModel;
    if (provider === 'codex') return codexModel;
    if (provider === 'gemini') return geminiModel;
    return cursorModel;
  }, [claudeModel, codexModel, cursorModel, geminiModel, provider]);

  useEffect(() => {
    if (!selectedLocalProjectName && localProjects.length > 0) {
      setSelectedLocalProjectName(localProjects[0].name);
    }
  }, [localProjects, selectedLocalProjectName]);

  useEffect(() => {
    let cancelled = false;

    authenticatedFetch('/api/e2b/status')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setE2BConfigured(Boolean(data?.configured));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setE2BConfigured(false);
        }
      });

    const syncGitHubConnection = async () => {
      try {
        const connected = await fetchGitHubOAuthStatus();
        if (cancelled) {
          return;
        }

        setGithubConnected(connected);
        if (!connected) {
          setRepos([]);
          setRepoCatalog([]);
          setBranches([]);
          setSelectedRepo(null);
          setSelectedBranch('');
        }
      } catch {
        if (cancelled) {
          return;
        }

        setGithubConnected(false);
        setRepos([]);
        setRepoCatalog([]);
        setBranches([]);
        setSelectedRepo(null);
        setSelectedBranch('');
      }
    };

    const handleOAuthSuccess = (event: MessageEvent) => {
      if (event.data?.type === 'github-oauth-success') {
        void syncGitHubConnection();
      }
    };

    void syncGitHubConnection();
    window.addEventListener('message', handleOAuthSuccess);

    return () => {
      cancelled = true;
      window.removeEventListener('message', handleOAuthSuccess);
    };
  }, []);

  const loadAuthSources = useCallback(async ({ resetSelections = false }: { resetSelections?: boolean } = {}) => {
    setIsLoadingAuthSources(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/auth-center/overview');
      const data = (await parseApiJson(
        response,
        'Failed to load cloud auth sources',
      )) as AuthSourcesResponse | null;
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to load cloud auth sources');
      }

      const nextSources = buildEmptyAuthSourceMap();
      for (const item of PROVIDERS) {
        const providerOverview = data.providers?.[item.id];
        if (!providerOverview) {
          continue;
        }

        nextSources[item.id] = {
          ...createDefaultAuthSource(),
          ...(providerOverview.host || {}),
          profiles: providerOverview.profiles || [],
        };
      }

      setAuthSources(nextSources);

      if (!hasInitializedAuthSelections || resetSelections) {
        if (!hasUserTouchedAuthSelectionsRef.current) {
          const defaults = {
            ...buildEmptyAuthSelectionMap(),
            ...(data.defaultSelections || {}),
          } as Record<ProviderDef['id'], CloudAuthSelection>;
          setAuthSelections(defaults);
        }

        setHasInitializedAuthSelections(true);
      }
    } catch (loadError) {
      console.error('Failed to load E2B auth sources:', loadError);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load cloud auth sources');
      if (resetSelections) {
        setAuthSelections(buildEmptyAuthSelectionMap());
        setHasInitializedAuthSelections(true);
      }
    } finally {
      setIsLoadingAuthSources(false);
    }
  }, [hasInitializedAuthSelections]);

  useEffect(() => {
    void loadAuthSources();
  }, [loadAuthSources]);

  const fetchRepos = useCallback(async (search: string) => {
    setIsLoadingRepos(true);
    try {
      const nextRepos = await fetchGitHubRepos(search);
      setRepos(nextRepos);
      setRepoCatalog((currentRepos) => mergeGitHubRepos(currentRepos, nextRepos));
    } catch (fetchError) {
      console.error('Failed to load repositories:', fetchError);
      setRepos([]);
    } finally {
      setIsLoadingRepos(false);
    }
  }, []);

  const fetchBranches = useCallback(async (repo: GitHubRepo, preferredBranch?: string) => {
    setIsLoadingBranches(true);
    try {
      const { branches: nextBranches, defaultBranch } = await fetchGitHubBranches(repo);
      setBranches(nextBranches);
      setSelectedBranch(resolveGitHubBranchSelection(preferredBranch, nextBranches, defaultBranch));
    } catch (fetchError) {
      console.error('Failed to load branches:', fetchError);
      setBranches([]);
      setSelectedBranch(preferredBranch || repo.defaultBranch || '');
    } finally {
      setIsLoadingBranches(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== 'cloud' || !githubConnected) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void fetchRepos(repoSearch);
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [fetchRepos, githubConnected, mode, repoSearch]);

  const handleModelChange = (value: string) => {
    if (provider === 'claude') {
      setClaudeModel(value);
      return;
    }

    if (provider === 'codex') {
      setCodexModel(value);
      return;
    }

    if (provider === 'gemini') {
      setGeminiModel(value);
      return;
    }

    setCursorModel(value);
  };

  const selectProvider = (nextProvider: ProviderDef['id']) => {
    setProvider(nextProvider);
    setError(null);
  };

  const handleAuthModeChange = (providerId: ProviderDef['id'], nextMode: CloudAuthMode) => {
    hasUserTouchedAuthSelectionsRef.current = true;
    setAuthSelections((current) => ({
      ...current,
      [providerId]: {
        mode: nextMode,
        profileId: nextMode === 'profile' ? current[providerId]?.profileId || null : null,
      },
    }));
  };

  const handleAuthProfileChange = (providerId: ProviderDef['id'], profileId: string) => {
    hasUserTouchedAuthSelectionsRef.current = true;
    const parsed = Number.parseInt(profileId, 10);
    setAuthSelections((current) => ({
      ...current,
      [providerId]: {
        ...current[providerId],
        profileId: Number.isFinite(parsed) ? parsed : null,
      },
    }));
  };

  const isAuthConfigValid = useMemo(
    () => PROVIDERS.every(({ id }) => {
      const selection = authSelections[id];
      if (!selection || selection.mode !== 'profile') {
        return true;
      }

      return Boolean(selection.profileId);
    }),
    [authSelections],
  );

  const selectedLocalProject = localProjects.find((project) => project.name === selectedLocalProjectName) || null;
  const visibleRepos = useMemo(
    () => mergeGitHubRepos(repos, repoCatalog).filter((repo) => matchesGitHubRepoQuery(repo, repoSearch)),
    [repoCatalog, repos, repoSearch],
  );

  const handleStartLocalSession = () => {
    if (!selectedLocalProject) {
      return;
    }

    dispatchLaunchConfig({
      provider,
      runtimeMode: selectedLocalProject.runtime || 'local',
      claudeModel,
      cursorModel,
      codexModel,
      geminiModel,
    });

    onClose();
    onOpenProject(selectedLocalProject);
  };

  const handleRepoSelect = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setRepoSearch(repo.fullName);
    setShowRepoDropdown(false);
    setError(null);
    void fetchBranches(repo, repo.defaultBranch);
  };

  const openAuthCenter = useCallback(() => {
    onClose();
    window.setTimeout(() => {
      window.openSettings?.('authCenter');
    }, 0);
  }, [onClose]);

  const handleCreateCloudProject = async () => {
    if (!selectedRepo) {
      return;
    }

    setIsCreatingCloudProject(true);
    setError(null);

    try {
      const repoUrl = selectedRepo.cloneUrl;
      const branch = selectedBranch || selectedRepo.defaultBranch;
      const response = await authenticatedFetch('/api/e2b/sandbox/create-with-repo', {
        method: 'POST',
        body: JSON.stringify({
          repoUrl,
          branch,
          ...(hasInitializedAuthSelections
            ? {
                authSelections: Object.fromEntries(
                  PROVIDERS.map(({ id }) => [
                    id,
                    {
                      mode: authSelections[id]?.mode || 'auto',
                      profileId: authSelections[id]?.profileId || undefined,
                    },
                  ]),
                ),
              }
            : {}),
        }),
      });
      const data = await parseApiJson(response, 'Failed to create cloud project');
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to create cloud project');
      }

      const workspacePath = `/home/user/${selectedRepo.name}`;
      const createdProject: Project = {
        name: `e2b__${data.sandboxId}`,
        displayName: selectedRepo.name,
        path: workspacePath,
        fullPath: workspacePath,
        kind: 'cloud',
        runtime: 'e2b',
        sessions: [],
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        e2bSessions: [],
        sessionMeta: {
          hasMore: false,
          total: 0,
        },
        cloud: {
          sandboxId: data.sandboxId,
          status: 'running',
          repoUrl,
          branch,
          workspacePath,
        },
      };

      dispatchLaunchConfig({
        provider,
        runtimeMode: 'e2b',
        claudeModel,
        cursorModel,
        codexModel,
        geminiModel,
      });

      // Close the launcher before switching the selected project so the
      // portal does not linger above the newly opened cloud workspace.
      onClose();
      onOpenProject(createdProject);
      void window.refreshProjects?.();
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Failed to create cloud project';
      setError(message);
    } finally {
      setIsCreatingCloudProject(false);
    }
  };

  const providerCards = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {PROVIDERS.map((item) => {
        const active = provider === item.id;
        return (
          <button
            key={item.id}
            type="button"
            data-testid="launcher-provider-card"
            data-provider-id={item.id}
            onClick={() => selectProvider(item.id)}
            className={`relative flex flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-center transition-all ${
              active
                ? `${item.accent} ${item.ring} bg-card shadow-sm ring-2`
                : 'border-border bg-card/60 hover:border-border/80 hover:bg-card'
            }`}
          >
            <SessionProviderLogo provider={item.id} className={`h-8 w-8 ${active ? 'scale-105' : ''}`} />
            <div className="text-xs font-semibold text-foreground">{item.name}</div>
            {active && (
              <div className={`absolute -right-1 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full ${item.check}`}>
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );

  const modelPicker = (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-muted/30 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          {t('providerSelection.selectModel', { defaultValue: 'Select Model' })}
        </p>
        <p className="text-xs text-muted-foreground">
          {provider === 'claude' ? 'Claude Code' : provider === 'cursor' ? 'Cursor' : provider === 'codex' ? 'Codex' : 'Gemini'}
        </p>
      </div>
      <div className="relative">
        <select
          data-testid="launcher-model-select"
          value={currentModel}
          onChange={(event) => handleModelChange(event.target.value)}
          className="appearance-none rounded-xl border border-border/60 bg-background px-3 py-2 pr-8 text-sm text-foreground outline-none"
        >
          {getModelConfig(provider).OPTIONS.map(({ value, label }: { value: string; label: string }) => (
            <option key={`${value}-${label}`} value={value}>
              {label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    </div>
  );

  const cloudAuthPanel = (
    <div className="rounded-3xl border border-border/60 bg-card/70 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Cloud Auth</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings:authCenter.hints.launcherDescription', {
              defaultValue:
                'Default behavior is to mirror usable host auth into the E2B project. You can also bind a provider to a saved Auth Center profile or disable it for this cloud project.',
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openAuthCenter}>
            {t('settings:authCenter.actions.openCenter', { defaultValue: 'Open Auth Center' })}
          </Button>
          {isLoadingAuthSources && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Refreshing
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((item) => {
          const source = authSources[item.id] || createDefaultAuthSource();
          const selection = authSelections[item.id] || createDefaultAuthSelection();
          const autoWarnings = source.auto?.warnings || [];
          const savedProfiles = source.profiles || [];
          const authSubtitle = source.authenticated
            ? source.email || source.method || 'Authenticated on host'
            : source.error || 'No host auth detected';

          return (
            <div
              key={`auth-${item.id}`}
              data-testid="launcher-cloud-auth-card"
              data-provider-id={item.id}
              className="rounded-2xl border border-border/60 bg-background/80 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border ${item.accent} bg-card`}>
                    <SessionProviderLogo provider={item.id} className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{item.name}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                          source.authenticated
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {source.authenticated ? 'Ready' : 'Off'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{authSubtitle}</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={openAuthCenter}
                  className="rounded-xl border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  {t('settings:authCenter.title', { defaultValue: 'Auth Center' })}
                </button>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="launcher-cloud-auth-auto"
                  data-provider-id={item.id}
                  onClick={() => handleAuthModeChange(item.id, 'auto')}
                  className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                    selection.mode === 'auto'
                      ? 'bg-sky-500 text-white'
                      : 'border border-border/60 text-foreground hover:bg-accent'
                  }`}
                >
                  Auto Copy
                </button>
                <button
                  type="button"
                  data-testid="launcher-cloud-auth-profile"
                  data-provider-id={item.id}
                  onClick={() => handleAuthModeChange(item.id, 'profile')}
                  className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                    selection.mode === 'profile'
                      ? 'bg-foreground text-background'
                      : 'border border-border/60 text-foreground hover:bg-accent'
                  }`}
                >
                  Saved Profile
                </button>
                <button
                  type="button"
                  data-testid="launcher-cloud-auth-disabled"
                  data-provider-id={item.id}
                  onClick={() => handleAuthModeChange(item.id, 'disabled')}
                  className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                    selection.mode === 'disabled'
                      ? 'bg-muted text-foreground'
                      : 'border border-border/60 text-foreground hover:bg-accent'
                  }`}
                >
                  Disable
                </button>
              </div>

              {selection.mode === 'profile' && (
                <div className="mt-3">
                  <select
                    data-testid="launcher-cloud-auth-profile-select"
                    data-provider-id={item.id}
                    value={selection.profileId || ''}
                    onChange={(event) => handleAuthProfileChange(item.id, event.target.value)}
                    className="w-full rounded-2xl border border-border/60 bg-background px-4 py-3 text-sm text-foreground outline-none"
                  >
                    <option value="">Select a saved profile</option>
                    {savedProfiles.map((profile) => (
                      <option key={`${item.id}-profile-${profile.id}`} value={profile.id}>
                        {profile.name}
                        {profile.email ? ` • ${profile.email}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {savedProfiles.length > 0
                      ? t('settings:authCenter.hints.savedProfilesFromCenter', {
                          defaultValue: 'Profiles come from Settings > Auth Center.',
                        })
                      : t('settings:authCenter.hints.createProfilesFirst', {
                          defaultValue: 'Create reusable profiles in Settings > Auth Center first.',
                        })}
                  </p>
                </div>
              )}

              {selection.mode === 'auto' && (
                <div className="mt-3 rounded-2xl border border-border/50 bg-muted/20 px-3 py-2">
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    {source.auto?.summary || 'No syncable local auth detected'}
                  </p>
                  {(source.auto?.files?.length || 0) > 0 && (
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {source.auto?.files?.join(' • ')}
                    </p>
                  )}
                </div>
              )}

              {selection.mode === 'disabled' && (
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                  This provider will stay unauthenticated inside the cloud project until you sync auth later.
                </p>
              )}

              {autoWarnings.length > 0 && (
                <p className="mt-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                  {autoWarnings[0]}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/55 backdrop-blur-sm" data-scroll-container>
        <div className="flex min-h-full items-stretch justify-center p-0 sm:h-full sm:min-h-0 sm:p-4">
          <div
            className="flex min-h-full w-full flex-col rounded-none border-0 bg-background shadow-2xl sm:h-auto sm:max-h-[90vh] sm:min-h-0 sm:max-w-5xl sm:overflow-hidden sm:rounded-3xl sm:border sm:border-border/60"
            data-testid="session-launcher"
          >
          <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-border/60 px-5 py-4 sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Workspace Launcher
              </p>
              <h2 className="mt-1 text-xl font-semibold text-foreground">
                Start Local Or Cloud Work
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Local sessions stay on this machine. Cloud projects create a shared E2B workspace.
              </p>
            </div>
            <button
              type="button"
              data-testid="launcher-close"
              onClick={onClose}
              className="rounded-xl p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close launcher"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-0 sm:min-h-0 sm:flex-row">
            <div className="flex-shrink-0 border-b border-border/60 bg-muted/20 p-3 sm:w-56 sm:border-b-0 sm:border-r">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-1">
                <button
                  type="button"
                  data-testid="launcher-mode-local"
                  onClick={() => setMode('local')}
                  className={`flex items-center gap-2 rounded-2xl px-3 py-3 text-left text-sm font-medium transition-colors ${mode === 'local' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                >
                  <Monitor className="h-4 w-4" />
                  Local
                </button>
                <button
                  type="button"
                  data-testid="launcher-mode-cloud"
                  onClick={() => setMode('cloud')}
                  className={`flex items-center gap-2 rounded-2xl px-3 py-3 text-left text-sm font-medium transition-colors ${mode === 'cloud' ? 'bg-sky-50 text-sky-700 shadow-sm dark:bg-sky-500/10 dark:text-sky-300' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                >
                  <Cloud className="h-4 w-4" />
                  E2B Cloud
                </button>
                <button
                  type="button"
                  data-testid="launcher-mode-project"
                  onClick={() => setMode('project')}
                  className={`flex items-center gap-2 rounded-2xl px-3 py-3 text-left text-sm font-medium transition-colors ${mode === 'project' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                >
                  <FolderPlus className="h-4 w-4" />
                  New Project
                </button>
              </div>
            </div>

            <div className="flex-1 px-5 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:min-h-0 sm:overflow-y-auto sm:overscroll-contain sm:px-6 sm:pb-5">
              {mode === 'local' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Local Session</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose an existing local project, then start a fresh session with your preferred agent.
                    </p>
                  </div>

                  {providerCards}
                  {modelPicker}

                  <div className="rounded-3xl border border-border/60 bg-card/70 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Projects</p>
                        <p className="text-xs text-muted-foreground">Pick where the new session should start.</p>
                      </div>
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                        {localProjects.length}
                      </span>
                    </div>

                    {localProjects.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-5 text-center">
                        <p className="text-sm text-muted-foreground">
                          No local projects yet.
                        </p>
                        <Button className="mt-4" onClick={onOpenNewProjectWizard}>
                          <Plus className="mr-2 h-4 w-4" />
                          Create Local Project
                        </Button>
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {localProjects.map((project) => {
                          const active = selectedLocalProjectName === project.name;
                          return (
                            <button
                              key={project.name}
                              type="button"
                              data-testid="launcher-local-project"
                              data-project-name={project.name}
                              onClick={() => setSelectedLocalProjectName(project.name)}
                              className={`rounded-2xl border px-4 py-3 text-left transition-colors ${active ? 'border-primary/30 bg-primary/5' : 'border-border/60 hover:bg-accent/40'}`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">{project.displayName}</p>
                                  <p className="truncate text-xs text-muted-foreground">{project.fullPath}</p>
                                </div>
                                {active && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end">
                    <Button data-testid="launcher-start-local" onClick={handleStartLocalSession} disabled={!selectedLocalProject}>
                      Start Local Session
                    </Button>
                  </div>
                </div>
              )}

              {mode === 'cloud' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Cloud Project</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Create an E2B workspace from a GitHub repository, then keep multiple sessions under the same cloud project.
                    </p>
                  </div>

                  {!e2bConfigured && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                      E2B is not configured. Set `E2B_API_KEY` in `.env` first.
                    </div>
                  )}

                  {providerCards}
                  {modelPicker}
                  {cloudAuthPanel}

                  {!githubConnected ? (
                    <div className="rounded-3xl border border-border/60 bg-card/70 p-6 text-center">
                      <p className="text-base font-semibold text-foreground">Connect GitHub First</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Repository selection is powered by your GitHub connection.
                      </p>
                      <Button
                        className="mt-4"
                        onClick={() => {
                          window.location.href = '/api/github/oauth/authorize';
                        }}
                      >
                        Connect GitHub
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-3xl border border-border/60 bg-card/70 p-4">
                        <label className="mb-2 block text-sm font-semibold text-foreground">
                          Repository
                        </label>
                        <div className="relative">
                          <input
                            data-testid="launcher-repo-search"
                            value={repoSearch}
                            onChange={(event) => {
                              const nextSearch = event.target.value;
                              setRepoSearch(nextSearch);
                              setShowRepoDropdown(true);
                              if (selectedRepo && nextSearch.trim() !== selectedRepo.fullName) {
                                setSelectedRepo(null);
                                setBranches([]);
                                setSelectedBranch('');
                              }
                            }}
                            onFocus={() => setShowRepoDropdown(true)}
                            className="w-full rounded-2xl border border-border/60 bg-background px-4 py-3 text-sm text-foreground outline-none"
                            placeholder="Search repositories"
                          />
                          {showRepoDropdown && (
                            <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-20 max-h-72 overflow-y-auto rounded-2xl border border-border/60 bg-popover p-2 shadow-xl">
                              {isLoadingRepos ? (
                                <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Loading repositories...
                                </div>
                              ) : visibleRepos.length === 0 ? (
                                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                                  No repositories found.
                                </div>
                              ) : (
                                visibleRepos.map((repo) => (
                                  <button
                                    key={repo.fullName}
                                    type="button"
                                    data-testid="launcher-repo-option"
                                    data-repo-full-name={repo.fullName}
                                    onClick={() => handleRepoSelect(repo)}
                                    className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent"
                                  >
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium text-foreground">{repo.fullName}</p>
                                      <p className="truncate text-xs text-muted-foreground">
                                        Default branch: {repo.defaultBranch}
                                      </p>
                                    </div>
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                      {repo.private ? 'Private' : 'Public'}
                                    </span>
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-3xl border border-border/60 bg-card/70 p-4">
                        <label className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                          <GitBranch className="h-4 w-4" />
                          Branch
                        </label>
                        <div className="relative">
                          <select
                            data-testid="launcher-branch-select"
                            value={selectedBranch}
                            onChange={(event) => setSelectedBranch(event.target.value)}
                            className="w-full appearance-none rounded-2xl border border-border/60 bg-background px-4 py-3 pr-10 text-sm text-foreground outline-none"
                            disabled={!selectedRepo || isLoadingBranches}
                          >
                            {isLoadingBranches && <option value="">Loading branches...</option>}
                            {!isLoadingBranches && branches.length === 0 && (
                              <option value={selectedBranch || selectedRepo?.defaultBranch || ''}>
                                {selectedBranch || selectedRepo?.defaultBranch || 'Select a repository first'}
                              </option>
                            )}
                            {branches.map((branchItem) => (
                              <option key={branchItem.name} value={branchItem.name}>
                                {branchItem.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          data-testid="launcher-start-cloud"
                          onClick={handleCreateCloudProject}
                          disabled={
                            !e2bConfigured ||
                            !selectedRepo ||
                            isCreatingCloudProject ||
                            isLoadingAuthSources ||
                            !hasInitializedAuthSelections ||
                            !isAuthConfigValid
                          }
                        >
                          {isCreatingCloudProject ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Creating Cloud Project...
                            </>
                          ) : (
                            <>
                              <Cloud className="mr-2 h-4 w-4" />
                              Start Cloud Project
                            </>
                          )}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {mode === 'project' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">New Local Project</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Create or attach a workspace on this machine. This is the existing local-project flow.
                    </p>
                  </div>

                  <div className="rounded-3xl border border-border/60 bg-card/70 p-6">
                    <p className="text-sm leading-6 text-muted-foreground">
                      Use this when you want to add an existing folder, create a blank workspace, or clone a repository locally before starting sessions.
                    </p>
                    <Button className="mt-5" data-testid="launcher-open-project-wizard" onClick={onOpenNewProjectWizard}>
                      <FolderPlus className="mr-2 h-4 w-4" />
                      Open Project Wizard
                    </Button>
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

    </>
  );
}
