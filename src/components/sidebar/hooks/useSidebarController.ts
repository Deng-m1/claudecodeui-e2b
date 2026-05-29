import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { api } from '../../../utils/api';
import type { Project, ProjectSession, RuntimeMode, SessionProvider } from '../../../types/app';
import type {
  AdditionalSessionsByProject,
  DeleteProjectConfirmation,
  LoadingSessionsByProject,
  ProjectSortOrder,
  SessionDeleteConfirmation,
  SidebarSessionProviderFilter,
  SessionWithProvider,
} from '../types/types';
import {
  filterProjects,
  getAllSessions,
  getProjectSessionMetaForProvider,
  loadStarredProjects,
  persistStarredProjects,
  readProjectSortOrder,
  resolveProjectLoadMoreProvider,
  sortProjects,
} from '../utils/utils';

type SnippetHighlight = {
  start: number;
  end: number;
};

type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

type ConversationProjectResult = {
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  totalMatches: number;
  query: string;
};

export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  onProjectDelete?: (projectName: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

const setsAreEqual = (left: Set<string>, right: Set<string>) => {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
};

const filterProjectRecord = <T,>(record: Record<string, T>, validProjectNames: Set<string>) => {
  const nextEntries = Object.entries(record).filter(([projectName]) => validProjectNames.has(projectName));
  if (nextEntries.length === Object.keys(record).length) {
    return record;
  }

  return Object.fromEntries(nextEntries) as Record<string, T>;
};

const readSessionProviderFilter = (): SidebarSessionProviderFilter => {
  try {
    const stored = localStorage.getItem('sidebar-session-provider-filter');
    if (stored === 'claude' || stored === 'cursor' || stored === 'codex' || stored === 'gemini') {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }

  return 'all';
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession,
  isLoading: _isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onProjectDelete,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [loadingSessions, setLoadingSessions] = useState<LoadingSessionsByProject>({});
  const [additionalSessions, setAdditionalSessions] = useState<AdditionalSessionsByProject>({});
  const [expandedRemoteHosts, setExpandedRemoteHosts] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = window.localStorage.getItem('sidebar-expanded-remote-hosts');
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed.filter((value) => typeof value === 'string')) : new Set();
    } catch {
      return new Set();
    }
  });
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectHasMoreOverrides, setProjectHasMoreOverrides] = useState<
    Record<string, Partial<Record<Exclude<SessionProvider, 'e2b'>, boolean>>>
  >({});
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [sessionProviderFilter, setSessionProviderFilter] = useState<SidebarSessionProviderFilter>(readSessionProviderFilter);
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteProjectConfirmation | null>(null);
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [starredProjects, setStarredProjects] = useState<Set<string>>(() => loadStarredProjects());
  const [searchMode, setSearchMode] = useState<'projects' | 'conversations'>('projects');
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('sidebar-session-provider-filter', sessionProviderFilter);
    } catch {
      // localStorage unavailable
    }
  }, [sessionProviderFilter]);

  useEffect(() => {
    const projectNames = new Set(projects.map((project) => project.name));

    setExpandedProjects((prev) => {
      const next = new Set([...prev].filter((projectName) => projectNames.has(projectName)));
      return setsAreEqual(prev, next) ? prev : next;
    });

    setAdditionalSessions((prev) => filterProjectRecord(prev, projectNames));
    setProjectHasMoreOverrides((prev) => filterProjectRecord(prev, projectNames));
    setLoadingSessions((prev) => filterProjectRecord(prev, projectNames));

    setInitialSessionsLoaded((prev) => {
      const next = new Set([...prev].filter((projectName) => projectNames.has(projectName)));

      for (const project of projects) {
        if (
          Array.isArray(project.sessions) ||
          Array.isArray(project.cursorSessions) ||
          Array.isArray(project.codexSessions) ||
          Array.isArray(project.geminiSessions) ||
          Array.isArray(project.e2bSessions)
        ) {
          next.add(project.name);
        }
      }

      return setsAreEqual(prev, next) ? prev : next;
    });
  }, [projects]);

  useEffect(() => {
    if (selectedProject) {
      setExpandedProjects((prev) => {
        if (prev.has(selectedProject.name)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(selectedProject.name);
        return next;
      });
    }
  }, [selectedSession, selectedProject]);

  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        loadSortOrder();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    const interval = setInterval(() => {
      if (document.hasFocus()) {
        loadSortOrder();
      }
    }, 1000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  // Debounced conversation search with SSE streaming
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const query = searchFilter.trim();
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const seq = ++searchSeqRef.current;

    searchTimeoutRef.current = setTimeout(() => {
      if (seq !== searchSeqRef.current) return;

      const url = api.searchConversationsUrl(query);
      const es = new EventSource(url);
      eventSourceRef.current = es;

      const accumulated: ConversationProjectResult[] = [];
      let totalMatches = 0;

      es.addEventListener('result', (evt) => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        try {
          const data = JSON.parse(evt.data) as {
            projectResult: ConversationProjectResult;
            totalMatches: number;
            scannedProjects: number;
            totalProjects: number;
          };
          accumulated.push(data.projectResult);
          totalMatches = data.totalMatches;
          setConversationResults({ results: [...accumulated], totalMatches, query });
          setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
        } catch {
          // Ignore malformed SSE data
        }
      });

      es.addEventListener('progress', (evt) => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        try {
          const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
          totalMatches = data.totalMatches;
          setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
        } catch {
          // Ignore malformed SSE data
        }
      });

      es.addEventListener('done', () => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        es.close();
        eventSourceRef.current = null;
        setIsSearching(false);
        setSearchProgress(null);
        if (accumulated.length === 0) {
          setConversationResults({ results: [], totalMatches: 0, query });
        }
      });

      es.addEventListener('error', () => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        es.close();
        eventSourceRef.current = null;
        setIsSearching(false);
        setSearchProgress(null);
        if (accumulated.length === 0) {
          setConversationResults({ results: [], totalMatches: 0, query });
        }
      });
    }, 400);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [searchFilter, searchMode]);

  const toggleProject = useCallback((projectName: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);

      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }

      return next;
    });
  }, []);

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectName: string) => {
      onSessionSelect({ ...session, __projectName: projectName });
    },
    [onSessionSelect],
  );

  const toggleStarProject = useCallback((projectName: string) => {
    setStarredProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }

      persistStarredProjects(next);
      return next;
    });
  }, []);

  const isProjectStarred = useCallback(
    (projectName: string) => starredProjects.has(projectName),
    [starredProjects],
  );

  const getProjectSessions = useCallback(
    (project: Project) => getAllSessions(project, additionalSessions),
    [additionalSessions],
  );

  const projectsWithSessionMeta = useMemo(
    () =>
      projects.map((project) => {
        const hasMoreOverride = projectHasMoreOverrides[project.name];
        if (hasMoreOverride === undefined) {
          return project;
        }

        const nextByProvider = {
          ...(project.sessionMeta?.byProvider || {}),
          ...Object.fromEntries(
            Object.entries(hasMoreOverride).map(([provider, hasMore]) => [
              provider,
              {
                ...(project.sessionMeta?.byProvider?.[provider as Exclude<SessionProvider, 'e2b'>] || {}),
                hasMore:
                  project.sessionMeta?.byProvider?.[provider as Exclude<SessionProvider, 'e2b'>]?.hasMore === true
                    ? true
                    : hasMore,
              },
            ]),
          ),
        };

        return {
          ...project,
          sessionMeta: {
            ...project.sessionMeta,
            hasMore:
              project.sessionMeta?.hasMore === true ||
              Object.values(nextByProvider).some((meta) => meta?.hasMore === true),
            byProvider: nextByProvider,
          },
        };
      }),
    [projectHasMoreOverrides, projects],
  );

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithSessionMeta, projectSortOrder, starredProjects, additionalSessions),
    [additionalSessions, projectSortOrder, projectsWithSessionMeta, starredProjects],
  );

  const filteredProjects = useMemo(
    () => filterProjects(sortedProjects, searchFilter),
    [searchFilter, sortedProjects],
  );

  const startEditing = useCallback((project: Project) => {
    setEditingProject(project.name);
    setEditingName(project.displayName);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProject(null);
    setEditingName('');
  }, []);

  const saveProjectName = useCallback(
    async (projectName: string) => {
      try {
        const response = await api.renameProject(projectName, editingName);
        if (response.ok) {
          if (window.refreshProjects) {
            await window.refreshProjects();
          } else {
            window.location.reload();
          }
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setEditingProject(null);
        setEditingName('');
      }
    },
    [editingName],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      projectName: string,
      sessionId: string,
      sessionTitle: string,
      provider: SessionDeleteConfirmation['provider'] = 'claude',
      runtime: RuntimeMode = 'local',
    ) => {
      setSessionDeleteConfirmation({ projectName, sessionId, sessionTitle, provider, runtime });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async () => {
    if (!sessionDeleteConfirmation) {
      return;
    }

    const { projectName, sessionId, provider } = sessionDeleteConfirmation;
    setSessionDeleteConfirmation(null);

    try {
      let response;
      if (sessionDeleteConfirmation.runtime === 'e2b') {
        response = await api.deleteE2BSession(sessionId);
      } else if (provider === 'codex') {
        response = await api.deleteCodexSession(sessionId);
      } else if (provider === 'gemini') {
        response = await api.deleteGeminiSession(sessionId);
      } else {
        response = await api.deleteSession(projectName, sessionId);
      }

      if (response.ok) {
        onSessionDelete?.(sessionId);
      } else {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [onSessionDelete, sessionDeleteConfirmation, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setDeleteConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteConfirmation) {
      return;
    }

    const { project, sessionCount } = deleteConfirmation;
    const isEmpty = sessionCount === 0;

    setDeleteConfirmation(null);
    setDeletingProjects((prev) => new Set([...prev, project.name]));

    try {
      const response = await api.deleteProject(project.name, !isEmpty);

      if (response.ok) {
        onProjectDelete?.(project.name);
      } else {
        const error = (await response.json()) as { error?: string };
        alert(error.error || t('messages.deleteProjectFailed'));
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.name);
        return next;
      });
    }
  }, [deleteConfirmation, onProjectDelete, t]);

  const loadMoreSessions = useCallback(
    async (project: Project) => {
      const providerOverrides = Object.fromEntries(
        Object.entries(projectHasMoreOverrides[project.name] || {}).map(([provider, hasMore]) => [
          provider,
          {
            ...(project.sessionMeta?.byProvider?.[provider as Exclude<SessionProvider, 'e2b'>] || {}),
            hasMore:
              project.sessionMeta?.byProvider?.[provider as Exclude<SessionProvider, 'e2b'>]?.hasMore === true
                ? true
                : hasMore,
          },
        ]),
      );

      const activeProvider = resolveProjectLoadMoreProvider(
        {
          ...project,
          sessionMeta: {
            ...project.sessionMeta,
            byProvider: {
              ...(project.sessionMeta?.byProvider || {}),
              ...providerOverrides,
            },
          },
        },
        sessionProviderFilter,
      );

      if (!activeProvider || loadingSessions[project.name]) {
        return;
      }

      const providerMeta = getProjectSessionMetaForProvider(project, activeProvider);
      const hasMoreOverride = projectHasMoreOverrides[project.name]?.[activeProvider];
      const canLoadMore = providerMeta.hasMore || hasMoreOverride === true;

      if (!canLoadMore) {
        return;
      }

      setLoadingSessions((prev) => ({ ...prev, [project.name]: true }));

      try {
        const currentSessionCount = getProjectSessions(project).filter(
          (session) => session.__provider === activeProvider,
        ).length;
        const response = await api.sessions(project.name, 5, currentSessionCount, {
          provider: activeProvider,
          projectPath: project.fullPath || project.path || project.cloud?.workspacePath || '',
        });

        if (!response.ok) {
          return;
        }

        const result = (await response.json()) as {
          sessions?: ProjectSession[];
          hasMore?: boolean;
        };

        setAdditionalSessions((prev) => ({
          ...prev,
          [project.name]: {
            ...(prev[project.name] || {}),
            [activeProvider]: [
              ...((prev[project.name] || {})[activeProvider] || []),
              ...(result.sessions || []),
            ],
          },
        }));

        if (result.hasMore === false) {
          setProjectHasMoreOverrides((prev) => ({
            ...prev,
            [project.name]: {
              ...(prev[project.name] || {}),
              [activeProvider]: false,
            },
          }));
        }
      } catch (error) {
        console.error('Error loading more sessions:', error);
      } finally {
        setLoadingSessions((prev) => ({ ...prev, [project.name]: false }));
      }
    },
    [getProjectSessions, loadingSessions, projectHasMoreOverrides, sessionProviderFilter],
  );

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
      try {
        const STORAGE_KEY = 'recent-projects';
        const MAX_ENTRIES = 8;
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed: Array<{ projectName: string; lastSelectedAt: number }> = (() => {
          if (!raw) return [];
          try {
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
          } catch {
            return [];
          }
        })();
        const next = [
          {
            projectName: project.name,
            displayName: project.displayName,
            runtime: project.runtime,
            fullPath: project.fullPath,
            lastSelectedAt: Date.now(),
          },
          ...parsed.filter((entry) => entry?.projectName && entry.projectName !== project.name),
        ].slice(0, MAX_ENTRIES);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        window.dispatchEvent(
          new CustomEvent('recent-projects:sync', { detail: { sourceId: 'sidebar-controller' } }),
        );
      } catch {
        // localStorage unavailable
      }
    },
    [onProjectSelect, setCurrentProject],
  );

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const updateSessionSummary = useCallback(
    async (
      _projectName: string,
      sessionId: string,
      summary: string,
      provider: SessionProvider,
      runtime: RuntimeMode = 'local',
    ) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed, runtime === 'e2b' ? 'e2b' : provider);
        if (response.ok) {
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setEditingSession(null);
        setEditingSessionName('');
      }
    },
    [onRefresh, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  const seenRemoteHostsRef = useRef<Set<string>>(new Set(
    (() => {
      if (typeof window === 'undefined') return [];
      try {
        const raw = window.localStorage.getItem('sidebar-seen-remote-hosts');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
      } catch {
        return [];
      }
    })(),
  ));

  useEffect(() => {
    const discoveredHostIds = new Set<string>();
    for (const project of projects) {
      const remoteMeta = (project as unknown as { remote?: { hostId?: string } }).remote;
      if (project.runtime === 'remote_host' && remoteMeta?.hostId) {
        discoveredHostIds.add(remoteMeta.hostId);
      }
    }

    if (discoveredHostIds.size === 0) {
      return;
    }

    const newlySeen: string[] = [];
    for (const hostId of discoveredHostIds) {
      if (!seenRemoteHostsRef.current.has(hostId)) {
        seenRemoteHostsRef.current.add(hostId);
        newlySeen.push(hostId);
      }
    }

    if (newlySeen.length === 0) {
      return;
    }

    try {
      window.localStorage.setItem(
        'sidebar-seen-remote-hosts',
        JSON.stringify(Array.from(seenRemoteHostsRef.current)),
      );
    } catch {
      // localStorage unavailable
    }

    setExpandedRemoteHosts((prev) => {
      const next = new Set(prev);
      for (const hostId of newlySeen) {
        next.add(hostId);
      }
      try {
        window.localStorage.setItem('sidebar-expanded-remote-hosts', JSON.stringify(Array.from(next)));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, [projects]);

  const toggleRemoteHost = useCallback((hostId: string) => {
    setExpandedRemoteHosts((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      try {
        window.localStorage.setItem('sidebar-expanded-remote-hosts', JSON.stringify(Array.from(next)));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  const refreshSingleProjectSessions = useCallback(async (project: Project) => {
    setLoadingSessions((prev) => ({ ...prev, [project.name]: true }));
    setAdditionalSessions((prev) => {
      if (!prev[project.name]) {
        return prev;
      }
      const next = { ...prev };
      delete next[project.name];
      return next;
    });
    setProjectHasMoreOverrides((prev) => {
      if (!prev[project.name]) {
        return prev;
      }
      const next = { ...prev };
      delete next[project.name];
      return next;
    });
    try {
      await onRefresh();
    } catch (error) {
      console.error('Failed to refresh sessions for project', project.name, error);
    } finally {
      setLoadingSessions((prev) => ({ ...prev, [project.name]: false }));
    }
  }, [onRefresh]);

  return {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    loadingSessions,
    additionalSessions,
    initialSessionsLoaded,
    currentTime,
    projectSortOrder,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    sessionProviderFilter,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    starredProjects,
    filteredProjects,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    loadMoreSessions,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    refreshSingleProjectSessions,
    expandedRemoteHosts,
    toggleRemoteHost,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    searchMode,
    setSearchMode,
    setSessionProviderFilter,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults: useCallback(() => {
      searchSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults(null);
    }, []),
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  };
}
