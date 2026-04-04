import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import type { WebSocketFeedMessage } from '../contexts/WebSocketContext';
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  SessionBootstrapResponse,
  ProjectsUpdatedMessage,
  SessionProvider,
} from '../types/app';
import { isCloudProject } from '../utils/sessionSelection';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  messageFeed: WebSocketFeedMessage[];
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
  preserveSession?: ProjectSession | null;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);
const LOCAL_SESSION_PROVIDERS: Array<Exclude<SessionProvider, 'e2b'>> = ['claude', 'cursor', 'codex', 'gemini'];

const resolveCloudSessionProvider = (session: ProjectSession): SessionProvider => {
  const rawProvider = typeof session.provider === 'string' ? session.provider.toLowerCase() : '';
  const rawAgent = typeof session.agent === 'string' ? session.agent.toLowerCase() : '';
  const candidate = rawProvider || rawAgent;

  if (candidate.includes('cursor')) {
    return 'cursor';
  }

  if (candidate.includes('codex') || candidate.includes('openai')) {
    return 'codex';
  }

  if (candidate.includes('gemini')) {
    return 'gemini';
  }

  return 'claude';
};

/**
 * Resolve __provider, __runtime, __projectName, __projectPath for a session
 * by checking which list it belongs to in the given project.
 *
 * All code paths that write to setSelectedSession (except null) must call this
 * so that downstream consumers (effectiveRuntimeMode, getTransportProvider,
 * handleSubmit) never have to re-derive these fields.
 */
const normalizeSessionSelection = (
  rawSession: ProjectSession,
  project: Project,
): ProjectSession => {
  const projectPath = project.cloud?.workspacePath || project.fullPath || project.path || '';

  // Check local provider lists first (same priority as sidebar's getAllSessions).
  if (project.sessions?.some((s) => s.id === rawSession.id)) {
    return { ...rawSession, __provider: rawSession.__provider || 'claude', __runtime: rawSession.__runtime || 'local', __projectName: rawSession.__projectName || project.name, __projectPath: rawSession.__projectPath || projectPath };
  }
  if (project.cursorSessions?.some((s) => s.id === rawSession.id)) {
    return { ...rawSession, __provider: rawSession.__provider || 'cursor', __runtime: rawSession.__runtime || 'local', __projectName: rawSession.__projectName || project.name, __projectPath: rawSession.__projectPath || projectPath };
  }
  if (project.codexSessions?.some((s) => s.id === rawSession.id)) {
    return { ...rawSession, __provider: rawSession.__provider || 'codex', __runtime: rawSession.__runtime || 'local', __projectName: rawSession.__projectName || project.name, __projectPath: rawSession.__projectPath || projectPath };
  }
  if (project.geminiSessions?.some((s) => s.id === rawSession.id)) {
    return { ...rawSession, __provider: rawSession.__provider || 'gemini', __runtime: rawSession.__runtime || 'local', __projectName: rawSession.__projectName || project.name, __projectPath: rawSession.__projectPath || projectPath };
  }
  if (project.e2bSessions?.some((s) => s.id === rawSession.id)) {
    return { ...rawSession, __provider: rawSession.__provider || resolveCloudSessionProvider(rawSession), __runtime: rawSession.__runtime || 'e2b', __projectName: rawSession.__projectName || project.name, __projectPath: rawSession.__projectPath || projectPath };
  }

  // Session not found in any list — preserve whatever metadata it already has,
  // but at least tag the project context.
  return {
    ...rawSession,
    __provider: rawSession.__provider || 'claude',
    __runtime: rawSession.__runtime,
    __projectName: project.name,
    __projectPath: projectPath,
  };
};

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      nextProject.kind !== prevProject.kind ||
      nextProject.runtime !== prevProject.runtime ||
      serialize(nextProject.capabilities) !== serialize(prevProject.capabilities) ||
      serialize(nextProject.cloud) !== serialize(prevProject.cloud) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions) ||
      serialize(nextProject.e2bSessions) !== serialize(prevProject.e2bSessions)
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
    ...(project.e2bSessions ?? []),
  ];
};

const findMatchingSessionInProject = (
  project: Project,
  targetSession: ProjectSession | null,
): ProjectSession | null => {
  if (!targetSession?.id) {
    return null;
  }

  if (targetSession.__projectName && targetSession.__projectName !== project.name) {
    return null;
  }

  const sessionLists: ProjectSession[][] =
    targetSession.__runtime === 'e2b'
      ? [project.e2bSessions ?? []]
      : targetSession.__provider === 'cursor'
        ? [project.cursorSessions ?? []]
        : targetSession.__provider === 'codex'
          ? [project.codexSessions ?? []]
          : targetSession.__provider === 'gemini'
            ? [project.geminiSessions ?? []]
            : [
              project.sessions ?? [],
              project.cursorSessions ?? [],
              project.codexSessions ?? [],
              project.geminiSessions ?? [],
            ];

  for (const sessions of sessionLists) {
    const matchedSession = sessions.find((session) => session.id === targetSession.id);
    if (matchedSession) {
      return matchedSession;
    }
  }

  return null;
};

const projectListContainsSession = (projects: Project[], targetSessionId?: string): boolean => {
  if (!targetSessionId) {
    return false;
  }

  return projects.some((project) =>
    getProjectSessions(project).some((session) => session.id === targetSessionId),
  );
};

const projectListContainsResolvedSession = (
  projects: Project[],
  targetSession: ProjectSession | null,
): boolean => {
  if (!targetSession?.id) {
    return false;
  }

  return projects.some((project) => Boolean(findMatchingSessionInProject(project, targetSession)));
};

const mergeProjectSessionLists = (
  currentSessions?: ProjectSession[],
  incomingSessions?: ProjectSession[],
): ProjectSession[] | undefined => {
  if (!currentSessions?.length) {
    return incomingSessions;
  }

  if (!incomingSessions?.length) {
    return currentSessions;
  }

  const currentById = new Map(currentSessions.map((session) => [session.id, session]));
  const mergedSessionIds = new Set<string>();
  const mergedSessions = incomingSessions.map((session) => {
    mergedSessionIds.add(session.id);
    return {
      ...(currentById.get(session.id) ?? {}),
      ...session,
    };
  });

  for (const session of currentSessions) {
    if (!mergedSessionIds.has(session.id)) {
      mergedSessions.push(session);
    }
  }

  return mergedSessions;
};

const mergeProjectSessionMeta = (
  currentMeta: Project['sessionMeta'],
  incomingMeta: Project['sessionMeta'],
): Project['sessionMeta'] => {
  if (!currentMeta) {
    return incomingMeta;
  }

  if (!incomingMeta) {
    return currentMeta;
  }

  if (!incomingMeta.byProvider && currentMeta.byProvider) {
    return currentMeta;
  }

  return {
    ...currentMeta,
    ...incomingMeta,
    byProvider: incomingMeta.byProvider || currentMeta.byProvider,
  };
};

const mergeProjectState = (currentProject: Project, incomingProject: Project): Project => ({
  ...currentProject,
  ...incomingProject,
  sessionMeta: mergeProjectSessionMeta(currentProject.sessionMeta, incomingProject.sessionMeta),
  sessions: mergeProjectSessionLists(currentProject.sessions, incomingProject.sessions),
  cursorSessions: mergeProjectSessionLists(currentProject.cursorSessions, incomingProject.cursorSessions),
  codexSessions: mergeProjectSessionLists(currentProject.codexSessions, incomingProject.codexSessions),
  geminiSessions: mergeProjectSessionLists(currentProject.geminiSessions, incomingProject.geminiSessions),
  e2bSessions: mergeProjectSessionLists(currentProject.e2bSessions, incomingProject.e2bSessions),
  taskmaster: currentProject.taskmaster || incomingProject.taskmaster,
});

const isProviderListPartial = (
  project: Project,
  provider: Exclude<SessionProvider, 'e2b'>,
): boolean => {
  const providerMeta = project.sessionMeta?.byProvider?.[provider];
  if (providerMeta) {
    return providerMeta.hasMore === true;
  }

  return provider === 'claude' && project.sessionMeta?.hasMore === true;
};

const hasPartialCloudSessionList = (project: Project): boolean => {
  if (!isCloudProject(project)) {
    return false;
  }

  if (project.sessionMeta?.hasMore === true) {
    return true;
  }

  return Object.values(project.sessionMeta?.byProvider || {}).some((meta) => meta?.hasMore === true);
};

const mergeProjectStatePreservingKnownSessions = (
  currentProject: Project,
  incomingProject: Project,
): Project => ({
  ...currentProject,
  ...incomingProject,
  sessionMeta: mergeProjectSessionMeta(currentProject.sessionMeta, incomingProject.sessionMeta),
  sessions: isProviderListPartial(incomingProject, 'claude')
    ? mergeProjectSessionLists(currentProject.sessions, incomingProject.sessions)
    : incomingProject.sessions,
  cursorSessions: isProviderListPartial(incomingProject, 'cursor')
    ? mergeProjectSessionLists(currentProject.cursorSessions, incomingProject.cursorSessions)
    : incomingProject.cursorSessions,
  codexSessions: isProviderListPartial(incomingProject, 'codex')
    ? mergeProjectSessionLists(currentProject.codexSessions, incomingProject.codexSessions)
    : incomingProject.codexSessions,
  geminiSessions: isProviderListPartial(incomingProject, 'gemini')
    ? mergeProjectSessionLists(currentProject.geminiSessions, incomingProject.geminiSessions)
    : incomingProject.geminiSessions,
  e2bSessions: hasPartialCloudSessionList(incomingProject)
    ? mergeProjectSessionLists(currentProject.e2bSessions, incomingProject.e2bSessions)
    : incomingProject.e2bSessions,
  taskmaster: currentProject.taskmaster || incomingProject.taskmaster,
});

const mergeKnownProjectsWithIncoming = (
  currentProjects: Project[],
  incomingProjects: Project[],
): Project[] => {
  if (currentProjects.length === 0) {
    return incomingProjects;
  }

  return incomingProjects.map((incomingProject) => {
    const currentProject = currentProjects.find((project) => project.name === incomingProject.name);
    return currentProject
      ? mergeProjectStatePreservingKnownSessions(currentProject, incomingProject)
      : incomingProject;
  });
};

const injectSelectedSessionIntoProject = (
  project: Project,
  selectedSession: ProjectSession,
): Project => {
  const normalized = normalizeSessionSelection(selectedSession, project);

  if (normalized.__runtime === 'e2b') {
    return {
      ...project,
      e2bSessions: mergeProjectSessionLists(project.e2bSessions, [normalized]),
    };
  }

  if (normalized.__provider === 'cursor') {
    return {
      ...project,
      cursorSessions: mergeProjectSessionLists(project.cursorSessions, [normalized]),
    };
  }

  if (normalized.__provider === 'codex') {
    return {
      ...project,
      codexSessions: mergeProjectSessionLists(project.codexSessions, [normalized]),
    };
  }

  if (normalized.__provider === 'gemini') {
    return {
      ...project,
      geminiSessions: mergeProjectSessionLists(project.geminiSessions, [normalized]),
    };
  }

  return {
    ...project,
    sessions: mergeProjectSessionLists(project.sessions, [normalized]),
  };
};

const preserveSelectedSessionInProjects = (
  projects: Project[],
  selectedSession: ProjectSession | null,
): Project[] => {
  if (!selectedSession?.id) {
    return projects;
  }

  let didChange = false;
  const nextProjects = projects.map((project) => {
    const sameProject =
      (selectedSession.__projectName && project.name === selectedSession.__projectName) ||
      (!selectedSession.__projectName && Boolean(findMatchingSessionInProject(project, selectedSession)));

    if (!sameProject || findMatchingSessionInProject(project, selectedSession)) {
      return project;
    }

    didChange = true;
    return injectSelectedSessionIntoProject(project, selectedSession);
  });

  return didChange ? nextProjects : projects;
};

const mergeProviderSessionsIntoProject = (
  project: Project,
  provider: Exclude<SessionProvider, 'e2b'>,
  sessions: ProjectSession[],
  meta: { total?: number; hasMore?: boolean } = {},
): Project => {
  const nextByProvider = {
    ...(project.sessionMeta?.byProvider || {}),
    [provider]: {
      ...(project.sessionMeta?.byProvider?.[provider] || {}),
      total: Number.isFinite(meta.total) ? Number(meta.total) : Number(meta.total || sessions.length),
      hasMore: meta.hasMore === true,
    },
  };

  const nextTotal = LOCAL_SESSION_PROVIDERS.reduce(
    (sum, candidateProvider) => sum + Number(nextByProvider[candidateProvider]?.total || 0),
    0,
  );

  const nextSessionMeta = {
    ...project.sessionMeta,
    total: nextTotal,
    hasMore: Object.values(nextByProvider).some((candidateMeta) => candidateMeta?.hasMore === true),
    byProvider: nextByProvider,
  };

  if (provider === 'cursor') {
    return {
      ...project,
      cursorSessions: mergeProjectSessionLists(project.cursorSessions, sessions),
      sessionMeta: nextSessionMeta,
    };
  }

  if (provider === 'codex') {
    return {
      ...project,
      codexSessions: mergeProjectSessionLists(project.codexSessions, sessions),
      sessionMeta: nextSessionMeta,
    };
  }

  if (provider === 'gemini') {
    return {
      ...project,
      geminiSessions: mergeProjectSessionLists(project.geminiSessions, sessions),
      sessionMeta: nextSessionMeta,
    };
  }

  return {
    ...project,
    sessions: mergeProjectSessionLists(project.sessions, sessions),
    sessionMeta: nextSessionMeta,
  };
};

const mergeRealtimeProjectsUpdate = (
  currentProjects: Project[],
  incomingProjects: Project[],
  message: ProjectsUpdatedMessage,
): Project[] => {
  const watchProvider = typeof message.watchProvider === 'string' ? message.watchProvider : '';

  if (!watchProvider || currentProjects.length === 0) {
    return incomingProjects;
  }

  const incomingNames = new Set(incomingProjects.map((project) => project.name));
  const preservedCloudProjects = currentProjects.filter(
    (project) => isCloudProject(project) && !incomingNames.has(project.name),
  );

  if (preservedCloudProjects.length === 0) {
    return incomingProjects;
  }

  return [...incomingProjects, ...preservedCloudProjects];
};

const preserveMissingCloudProjects = (
  currentProjects: Project[],
  incomingProjects: Project[],
): Project[] => {
  if (currentProjects.length === 0 || incomingProjects.some((project) => isCloudProject(project))) {
    return incomingProjects;
  }

  const incomingNames = new Set(incomingProjects.map((project) => project.name));
  const preservedCloudProjects = currentProjects.filter(
    (project) => isCloudProject(project) && !incomingNames.has(project.name),
  );

  if (preservedCloudProjects.length === 0) {
    return incomingProjects;
  }

  return [...incomingProjects, ...preservedCloudProjects];
};

const shouldPreserveCurrentView = (
  updatedProjects: Project[],
  {
    selectedProject,
    selectedSession,
    sessionId,
    activeSessions,
  }: {
    selectedProject: Project | null;
    selectedSession: ProjectSession | null;
    sessionId?: string;
    activeSessions: Set<string>;
  },
): boolean => {
  const hasProtectedView =
    activeSessions.size > 0 ||
    Boolean(sessionId) ||
    Boolean(selectedSession?.id) ||
    (Boolean(selectedProject?.name) && !selectedSession?.id);

  if (!hasProtectedView) {
    return false;
  }

  if (selectedProject && !updatedProjects.some((project) => project.name === selectedProject.name)) {
    return true;
  }

  if (selectedSession?.id) {
    if (!projectListContainsResolvedSession(updatedProjects, selectedSession)) {
      return true;
    }
  }

  if (sessionId && !projectListContainsSession(updatedProjects, sessionId)) {
    return true;
  }

  return false;
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((project) => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = findMatchingSessionInProject(currentSelectedProject, selectedSession);
  const updatedSelectedSession = findMatchingSessionInProject(updatedSelectedProject, selectedSession);

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

const VALID_TABS: Set<string> = new Set(['chat', 'files', 'shell', 'git', 'tasks', 'preview']);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage: _latestMessage,
  messageFeed,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);
  const projectsRef = useRef(projects);
  const selectedProjectRef = useRef<Project | null>(selectedProject);
  const selectedSessionRef = useRef<ProjectSession | null>(selectedSession);
  const activeSessionsRef = useRef(activeSessions);
  const routeSessionIdRef = useRef<string | undefined>(sessionId);

  projectsRef.current = projects;
  selectedProjectRef.current = selectedProject;
  selectedSessionRef.current = selectedSession;
  activeSessionsRef.current = activeSessions;
  routeSessionIdRef.current = sessionId;

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundHydrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProcessedMessageSequenceRef = useRef(0);

  const fetchProjects = useCallback(async ({ showLoadingState = true, preserveSession = null }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const fetchedProjects = (await response.json()) as Project[];
      const currentSelectedProject = selectedProjectRef.current;
      const currentSelectedSession = preserveSession ?? selectedSessionRef.current;
      const currentRouteSessionId = routeSessionIdRef.current;
      const currentActiveSessions = activeSessionsRef.current;
      let nextProjectsState: Project[] | null = null;

      setProjects((prevProjects) => {
        const projectData = preserveSelectedSessionInProjects(
          mergeKnownProjectsWithIncoming(
            prevProjects,
            preserveMissingCloudProjects(prevProjects, fetchedProjects),
          ),
          currentSelectedSession,
        );

        if (prevProjects.length === 0) {
          nextProjectsState = projectData;
          return projectData;
        }

        if (
          shouldPreserveCurrentView(projectData, {
            selectedProject: currentSelectedProject,
            selectedSession: currentSelectedSession,
            sessionId: currentRouteSessionId,
            activeSessions: currentActiveSessions,
          })
        ) {
          return prevProjects;
        }

        if (projectsHaveChanges(prevProjects, projectData, true)) {
          nextProjectsState = projectData;
          return projectData;
        }

        return prevProjects;
      });

      const appliedProjects = (nextProjectsState ?? []) as Project[];
      if (appliedProjects.length > 0 && currentSelectedProject) {
        const nextSelectedProject =
          appliedProjects.find((project) => project.name === currentSelectedProject.name) || null;
        if (nextSelectedProject) {
          setSelectedProject((current) =>
            serialize(current) === serialize(nextSelectedProject) ? current : nextSelectedProject,
          );
        }

        if (nextSelectedProject && currentSelectedSession) {
          const matchedSession = findMatchingSessionInProject(nextSelectedProject, currentSelectedSession);
          if (matchedSession) {
            const normalized = normalizeSessionSelection(matchedSession, nextSelectedProject);
            setSelectedSession((current) =>
              serialize(current) === serialize(normalized) ? current : normalized,
            );
          }
        }
      }
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const hydrateProjectProviderSessions = useCallback(
    async (project: Project, session: ProjectSession) => {
      if (!project?.name || session.__runtime === 'e2b') {
        return;
      }

      const provider = session.__provider;
      if (!provider || provider === 'e2b') {
        return;
      }

      try {
        const response = await api.sessions(project.name, 5, 0, {
          provider,
          projectPath: project.fullPath || project.path || '',
        });

        if (!response.ok) {
          return;
        }

        const result = (await response.json()) as {
          sessions?: ProjectSession[];
          total?: number;
          hasMore?: boolean;
        };

        const pageSessions = result.sessions || [];
        const mergePage = (candidateProject: Project) =>
          mergeProviderSessionsIntoProject(candidateProject, provider, pageSessions, {
            total: typeof result.total === 'number' ? result.total : undefined,
            hasMore: result.hasMore === true,
          });

        setProjects((prevProjects) =>
          prevProjects.map((candidateProject) =>
            candidateProject.name === project.name ? mergePage(candidateProject) : candidateProject,
          ),
        );

        setSelectedProject((currentProject) => {
          if (!currentProject || currentProject.name !== project.name) {
            return currentProject;
          }

          return mergePage(currentProject);
        });
      } catch (error) {
        console.error('Error hydrating project provider sessions:', error);
      }
    },
    [],
  );

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const scheduleProjectsHydration = useCallback((preserveSession: ProjectSession | null = null) => {
    if (backgroundHydrationTimeoutRef.current) {
      return;
    }

    backgroundHydrationTimeoutRef.current = setTimeout(() => {
      backgroundHydrationTimeoutRef.current = null;
      void fetchProjects({ showLoadingState: false, preserveSession });
    }, 1500);
  }, [fetchProjects]);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrapSessionRoute = async () => {
      if (!sessionId) {
        const hasHydratedProjects = projectsRef.current.length > 0;
        await fetchProjects({ showLoadingState: !hasHydratedProjects });
        return;
      }

      const shouldShowBlockingLoading =
        !selectedProjectRef.current &&
        !selectedSessionRef.current &&
        activeSessionsRef.current.size === 0;

      if (shouldShowBlockingLoading) {
        setIsLoadingProjects(true);
      }

      try {
        const response = await api.sessionBootstrap(sessionId);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as SessionBootstrapResponse;
        if (cancelled) {
          return;
        }

        setProjects((prevProjects) => {
          const existingIndex = prevProjects.findIndex((project) => project.name === payload.project.name);
          if (existingIndex === -1) {
            return [payload.project, ...prevProjects];
          }

          const nextProjects = [...prevProjects];
          nextProjects[existingIndex] = mergeProjectState(prevProjects[existingIndex], payload.project);
          return nextProjects;
        });
        setSelectedProject((currentProject) => {
          if (!currentProject || currentProject.name !== payload.project.name) {
            return payload.project;
          }

          return mergeProjectState(currentProject, payload.project);
        });
        const normalizedBootstrapSession = normalizeSessionSelection(payload.session, payload.project);
        setSelectedSession(normalizedBootstrapSession);
        setIsLoadingProjects(false);
        void hydrateProjectProviderSessions(payload.project, normalizedBootstrapSession);
        scheduleProjectsHydration(normalizedBootstrapSession);
      } catch (error) {
        console.error('Error bootstrapping session route:', error);
        if (!cancelled) {
          await fetchProjects();
        }
      }
    };

    void bootstrapSessionRoute();

    return () => {
      cancelled = true;
    };
  }, [fetchProjects, hydrateProjectProviderSessions, scheduleProjectsHydration, sessionId]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    const pendingMessages = messageFeed.filter(
      (entry) => entry.sequence > lastProcessedMessageSequenceRef.current,
    );

    if (pendingMessages.length === 0) {
      return;
    }

    let nextProjectsState = projectsRef.current;
    let nextSelectedProjectState = selectedProjectRef.current;
    let nextSelectedSessionState = selectedSessionRef.current;
    let projectsChanged = false;
    let selectedProjectChanged = false;
    let selectedSessionChanged = false;

    for (const entry of pendingMessages) {
      lastProcessedMessageSequenceRef.current = entry.sequence;
      const nextMessage = entry.message as AppSocketMessage | null;
      if (!nextMessage) {
        continue;
      }

      if (nextMessage.type === 'loading_progress') {
        if (loadingProgressTimeoutRef.current) {
          clearTimeout(loadingProgressTimeoutRef.current);
          loadingProgressTimeoutRef.current = null;
        }

        setLoadingProgress(nextMessage as LoadingProgress);

        if (nextMessage.phase === 'complete') {
          loadingProgressTimeoutRef.current = setTimeout(() => {
            setLoadingProgress(null);
            loadingProgressTimeoutRef.current = null;
          }, 500);
        }

        continue;
      }

      if (nextMessage.type !== 'projects_updated') {
        continue;
      }

      const projectsMessage = nextMessage as ProjectsUpdatedMessage;

      if (projectsMessage.changedFile && nextSelectedSessionState && nextSelectedProjectState) {
        const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
        const changedFileParts = normalized.split('/');

        if (changedFileParts.length >= 2) {
          const filename = changedFileParts[changedFileParts.length - 1];
          const changedSessionId = filename.replace(/\.(jsonl|md)$/i, '');

          if (changedSessionId === nextSelectedSessionState.id) {
            const isSessionActive = activeSessionsRef.current.has(nextSelectedSessionState.id);

            if (!isSessionActive) {
              setExternalMessageUpdate((prev) => prev + 1);
            }
          }
        }
      }

      const currentRouteSessionId = routeSessionIdRef.current;
      const currentActiveSessions = activeSessionsRef.current;
      const hasActiveSession =
        currentActiveSessions.size > 0 ||
        Boolean(currentRouteSessionId) ||
        Boolean(nextSelectedSessionState?.id);
      const updatedProjects = preserveSelectedSessionInProjects(
        mergeRealtimeProjectsUpdate(
          nextProjectsState,
          mergeKnownProjectsWithIncoming(nextProjectsState, projectsMessage.projects),
          projectsMessage,
        ),
        nextSelectedSessionState,
      );

      if (
        shouldPreserveCurrentView(updatedProjects, {
          selectedProject: nextSelectedProjectState,
          selectedSession: nextSelectedSessionState,
          sessionId: currentRouteSessionId,
          activeSessions: currentActiveSessions,
        })
      ) {
        continue;
      }

      if (
        hasActiveSession &&
        !isUpdateAdditive(
          nextProjectsState,
          updatedProjects,
          nextSelectedProjectState,
          nextSelectedSessionState,
        )
      ) {
        continue;
      }

      if (!projectsHaveChanges(nextProjectsState, updatedProjects, true)) {
        continue;
      }

      nextProjectsState = updatedProjects;
      projectsChanged = true;

      if (!nextSelectedProjectState) {
        continue;
      }

      const updatedSelectedProject = updatedProjects.find(
        (project) => project.name === nextSelectedProjectState?.name,
      ) || null;

      if (!updatedSelectedProject) {
        nextSelectedProjectState = null;
        nextSelectedSessionState = null;
        selectedProjectChanged = true;
        selectedSessionChanged = true;
        continue;
      }

      if (serialize(updatedSelectedProject) !== serialize(nextSelectedProjectState)) {
        nextSelectedProjectState = updatedSelectedProject;
        selectedProjectChanged = true;
      }

      if (!nextSelectedSessionState) {
        continue;
      }

      const updatedSelectedSession = findMatchingSessionInProject(
        updatedSelectedProject,
        nextSelectedSessionState,
      );

      if (!updatedSelectedSession) {
        nextSelectedSessionState = null;
        selectedSessionChanged = true;
      } else {
        const reNormalized = normalizeSessionSelection(updatedSelectedSession, updatedSelectedProject);
        if (serialize(reNormalized) !== serialize(nextSelectedSessionState)) {
          nextSelectedSessionState = reNormalized;
          selectedSessionChanged = true;
        }
      }
    }

    if (projectsChanged) {
      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, nextProjectsState, true) ? nextProjectsState : prevProjects,
      );
    }

    if (selectedProjectChanged) {
      setSelectedProject((current) =>
        serialize(current) === serialize(nextSelectedProjectState) ? current : nextSelectedProjectState,
      );
    }

    if (selectedSessionChanged) {
      setSelectedSession((current) =>
        serialize(current) === serialize(nextSelectedSessionState) ? current : nextSelectedSessionState,
      );
    }
  }, [messageFeed]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      if (backgroundHydrationTimeoutRef.current) {
        clearTimeout(backgroundHydrationTimeoutRef.current);
        backgroundHydrationTimeoutRef.current = null;
      }
    };
  }, []);

  // Resolve route sessionId → (project, session) pair.
  // Prioritize the currently selected project to avoid overriding an atomic
  // project+session switch from handleSessionSelect with a stale cross-project match.
  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    const findSessionInProject = (project: Project): boolean => {
      const rawSession = getProjectSessions(project).find((s) => s.id === sessionId);
      if (!rawSession) return false;

      const normalized = normalizeSessionSelection(rawSession, project);
      const shouldUpdateProject = selectedProject?.name !== project.name;
      const shouldUpdateSession =
        selectedSession?.id !== sessionId ||
        selectedSession.__provider !== normalized.__provider ||
        selectedSession.__runtime !== normalized.__runtime;

      if (shouldUpdateProject) setSelectedProject(project);
      if (shouldUpdateSession) setSelectedSession(normalized);
      return true;
    };

    // Search the currently selected project first so that handleSessionSelect's
    // atomic project switch isn't overridden by a cross-project match.
    if (selectedProject) {
      if (findSessionInProject(selectedProject)) return;
    }

    for (const project of projects) {
      if (project === selectedProject) continue;
      if (findSessionInProject(project)) return;
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider, selectedSession?.__runtime]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setProjects((prevProjects) => {
        const existingIndex = prevProjects.findIndex((candidate) => candidate.name === project.name);
        if (existingIndex === -1) {
          return [project, ...prevProjects];
        }

        const nextProjects = [...prevProjects];
        nextProjects[existingIndex] = mergeProjectState(prevProjects[existingIndex], project);
        return nextProjects;
      });
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      const sessionProjectName = session.__projectName;
      const currentProjectName = selectedProjectRef.current?.name;
      const targetProject = sessionProjectName
        ? projectsRef.current.find((project) => project.name === sessionProjectName) ?? selectedProjectRef.current
        : selectedProjectRef.current;

      if (targetProject && targetProject.name !== currentProjectName) {
        setSelectedProject(targetProject);
      }

      const normalized = targetProject
        ? normalizeSessionSelection(session, targetProject)
        : session;
      setSelectedSession(normalized);

      if (activeTab === 'tasks' || activeTab === 'preview') {
        setActiveTab('chat');
      }

      if (isMobile && sessionProjectName !== currentProjectName) {
        setSidebarOpen(false);
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, isMobile, navigate],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setProjects((prevProjects) => {
        const existingIndex = prevProjects.findIndex((candidate) => candidate.name === project.name);
        if (existingIndex === -1) {
          return [project, ...prevProjects];
        }

        const nextProjects = [...prevProjects];
        nextProjects[existingIndex] = mergeProjectState(prevProjects[existingIndex], project);
        return nextProjects;
      });
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          const deletedCloudSession = project.e2bSessions?.find((session) => session.id === sessionIdToDelete) || null;
          const deletedProvider: Exclude<SessionProvider, 'e2b'> | null =
            project.sessions?.some((session) => session.id === sessionIdToDelete)
              ? 'claude'
              : project.cursorSessions?.some((session) => session.id === sessionIdToDelete)
                ? 'cursor'
                : project.codexSessions?.some((session) => session.id === sessionIdToDelete)
                  ? 'codex'
                  : project.geminiSessions?.some((session) => session.id === sessionIdToDelete)
                    ? 'gemini'
                    : deletedCloudSession
                      ? resolveCloudSessionProvider(deletedCloudSession) as Exclude<SessionProvider, 'e2b'>
                      : null;

          return {
            ...project,
            sessions: project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
            cursorSessions: project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
            codexSessions: project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
            geminiSessions: project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
            e2bSessions: project.e2bSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
            sessionMeta: {
              ...project.sessionMeta,
              total: Math.max(0, (project.sessionMeta?.total as number | undefined ?? 0) - (deletedProvider ? 1 : 0)),
              byProvider: deletedProvider
                ? {
                  ...(project.sessionMeta?.byProvider || {}),
                  [deletedProvider]: {
                    ...(project.sessionMeta?.byProvider?.[deletedProvider] || {}),
                    total: Math.max(
                      0,
                      ((project.sessionMeta?.byProvider?.[deletedProvider]?.total as number | undefined) ?? 0) - 1,
                    ),
                  },
                }
                : project.sessionMeta?.byProvider,
            },
          };
        }),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const fetchedProjects = (await response.json()) as Project[];
      const freshProjects = mergeKnownProjectsWithIncoming(
        projectsRef.current,
        preserveMissingCloudProjects(projectsRef.current, fetchedProjects),
      );

      if (
        shouldPreserveCurrentView(freshProjects, {
          selectedProject,
          selectedSession,
          sessionId,
          activeSessions,
        })
      ) {
        return;
      }

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, freshProjects, true) ? freshProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find((project) => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = findMatchingSessionInProject(refreshedProject, selectedSession);

      if (refreshedSession) {
        const normalizedRefreshedSession = normalizeSessionSelection(refreshedSession, refreshedProject);
        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [activeSessions, selectedProject, selectedSession, sessionId]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, selectedProject?.name],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
