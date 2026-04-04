import type { TFunction } from 'i18next';
import type { Project, SessionProvider } from '../../../types/app';
import { isCloudProject as isResolvedCloudProject } from '../../../utils/sessionSelection';
import { parseDateString } from '../../../utils/dateUtils';
import type {
  AdditionalSessionsByProject,
  ProjectSortOrder,
  SettingsProject,
  SidebarSessionProviderFilter,
  SessionViewModel,
  SessionWithProvider,
} from '../types/types';

const SIDEBAR_SESSION_PROVIDERS: Array<Exclude<SessionProvider, 'e2b'>> = ['claude', 'cursor', 'codex', 'gemini'];

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

export const loadStarredProjects = (): Set<string> => {
  try {
    const saved = localStorage.getItem('starredProjects');
    return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
};

export const persistStarredProjects = (starredProjects: Set<string>) => {
  try {
    localStorage.setItem('starredProjects', JSON.stringify([...starredProjects]));
  } catch {
    // Keep UI responsive even if storage fails.
  }
};

export const isCloudProject = (project: Project): boolean =>
  isResolvedCloudProject(project);

export const getSessionDate = (session: SessionWithProvider): Date => {
  if (session.__provider === 'cursor') {
    return parseDateString(session.createdAt || '');
  }

  if (session.__provider === 'codex') {
    return parseDateString(session.createdAt || session.lastActivity || '');
  }

  return parseDateString(session.lastActivity || session.createdAt || '');
};

const resolveE2BSessionProvider = (session: Record<string, unknown>): SessionProvider => {
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

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  if (session.__provider === 'cursor') {
    return session.summary || session.name || t('projects.untitledSession');
  }

  if (session.__provider === 'codex') {
    return session.summary || session.name || t('projects.codexSession');
  }

  if (session.__provider === 'gemini') {
    return session.summary || session.name || t('projects.newSession');
  }

  return session.summary || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  if (session.__provider === 'cursor') {
    return String(session.createdAt || '');
  }

  if (session.__provider === 'codex') {
    return String(session.createdAt || session.lastActivity || '');
  }

  return String(session.lastActivity || session.createdAt || '');
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isCursorSession: session.__provider === 'cursor',
    isCodexSession: session.__provider === 'codex',
    isGeminiSession: session.__provider === 'gemini',
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (
  project: Project,
  additionalSessions: AdditionalSessionsByProject,
): SessionWithProvider[] => {
  // Map-based dedup: first entry for each ID wins.
  // Priority: local provider lists first, e2b last.
  // This ensures a session that exists in both project.sessions (local) AND
  // project.e2bSessions is treated as local — only sessions exclusively in
  // e2bSessions get the e2b tag. Prevents both duplicate-key warnings and
  // the "local session shows e2b label" bug.
  const deduped = new Map<string, SessionWithProvider>();

  const tryAdd = (session: SessionWithProvider) => {
    if (!deduped.has(session.id)) {
      deduped.set(session.id, session);
    }
  };

  const projectAdditionalSessions = additionalSessions[project.name] || {};
  const localAdditionalSessions = isCloudProject(project)
    ? {}
    : projectAdditionalSessions;

  for (const session of [...(project.sessions || []), ...(localAdditionalSessions.claude || [])]) {
    tryAdd({ ...session, __provider: 'claude' as const, __runtime: 'local' as const });
  }
  for (const session of [...(project.cursorSessions || []), ...(localAdditionalSessions.cursor || [])]) {
    tryAdd({ ...session, __provider: 'cursor' as const, __runtime: 'local' as const });
  }
  for (const session of [...(project.codexSessions || []), ...(localAdditionalSessions.codex || [])]) {
    tryAdd({ ...session, __provider: 'codex' as const, __runtime: 'local' as const });
  }
  for (const session of [...(project.geminiSessions || []), ...(localAdditionalSessions.gemini || [])]) {
    tryAdd({ ...session, __provider: 'gemini' as const, __runtime: 'local' as const });
  }
  for (const session of (project.e2bSessions || [])) {
    tryAdd({
      ...session,
      __provider: resolveE2BSessionProvider(session as Record<string, unknown>),
      __runtime: 'e2b' as const,
    });
  }

  if (isCloudProject(project)) {
    for (const provider of SIDEBAR_SESSION_PROVIDERS) {
      for (const session of projectAdditionalSessions[provider] || []) {
        tryAdd({
          ...session,
          __provider: provider,
          __runtime: 'e2b' as const,
        });
      }
    }
  }

  return [...deduped.values()].sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const filterSessionsByProvider = (
  sessions: SessionWithProvider[],
  providerFilter: SidebarSessionProviderFilter,
): SessionWithProvider[] => {
  if (providerFilter === 'all') {
    return sessions;
  }

  return sessions.filter((session) => session.__provider === providerFilter);
};

export const getProjectSessionMetaForProvider = (
  project: Project,
  providerFilter: SidebarSessionProviderFilter,
): { total: number; hasMore: boolean } => {
  const providerMeta = project.sessionMeta?.byProvider || {};

  if (providerFilter === 'all') {
    return {
      total: Number(project.sessionMeta?.total || 0),
      hasMore: Boolean(project.sessionMeta?.hasMore),
    };
  }

  const meta = providerMeta[providerFilter];
  return {
    total: Number(meta?.total || 0),
    hasMore: Boolean(meta?.hasMore),
  };
};

export const resolveProjectLoadMoreProvider = (
  project: Project,
  providerFilter: SidebarSessionProviderFilter,
): Exclude<SessionProvider, 'e2b'> | null => {
  if (providerFilter !== 'all') {
    return getProjectSessionMetaForProvider(project, providerFilter).hasMore
      ? providerFilter
      : null;
  }

  const providerMeta = project.sessionMeta?.byProvider || {};
  return SIDEBAR_SESSION_PROVIDERS.find((provider) => providerMeta[provider]?.hasMore) || null;
};

export const getProjectLastActivity = (
  project: Project,
  additionalSessions: AdditionalSessionsByProject,
): Date => {
  const sessions = getAllSessions(project, additionalSessions);
  const cloudFallbackDate = isCloudProject(project)
    ? parseDateString(project.cloud?.lastActivity || project.cloud?.createdAt || '')
    : new Date(0);
  const initialDate = Number.isNaN(cloudFallbackDate.getTime()) ? new Date(0) : cloudFallbackDate;

  if (sessions.length === 0) {
    return initialDate;
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, initialDate);
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  starredProjects: Set<string>,
  additionalSessions: AdditionalSessionsByProject,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    const aStarred = starredProjects.has(projectA.name);
    const bStarred = starredProjects.has(projectB.name);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    const bothCloudProjects = isCloudProject(projectA) && isCloudProject(projectB);
    if (bothCloudProjects) {
      const activityDelta =
        getProjectLastActivity(projectB, additionalSessions).getTime() -
        getProjectLastActivity(projectA, additionalSessions).getTime();

      if (activityDelta !== 0) {
        return activityDelta;
      }
    }

    if (projectSortOrder === 'date') {
      const activityDelta = (
        getProjectLastActivity(projectB, additionalSessions).getTime() -
        getProjectLastActivity(projectA, additionalSessions).getTime()
      );

      if (activityDelta !== 0) {
        return activityDelta;
      }
    }

    return (projectA.displayName || projectA.name).localeCompare(projectB.displayName || projectB.name);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const searchableFields = [
      project.displayName || '',
      project.name || '',
      project.fullPath || '',
      project.path || '',
      project.cloud?.repoUrl || '',
      project.cloud?.branch || '',
      project.cloud?.sandboxId || '',
      project.cloud?.workspacePath || '',
    ];

    return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  return {
    name: project.name,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.name,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
