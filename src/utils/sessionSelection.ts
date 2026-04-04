import type { Project, ProjectSession, RuntimeMode, SessionProvider } from '../types/app';

const hasSession = (session: ProjectSession | null | undefined): session is ProjectSession =>
  Boolean(session?.id);

function hasLocalProviderSessions(project: Project | null | undefined): boolean {
  if (!project) {
    return false;
  }

  return Boolean(
    project.sessions?.length ||
    project.cursorSessions?.length ||
    project.codexSessions?.length ||
    project.geminiSessions?.length,
  );
}

function hasCloudProjectIdentity(project: Project | null | undefined): boolean {
  if (!project) {
    return false;
  }

  const sandboxId = typeof project.cloud?.sandboxId === 'string' ? project.cloud.sandboxId.trim() : '';
  if (sandboxId) {
    return true;
  }

  if (typeof project.name === 'string' && project.name.startsWith('e2b__')) {
    return true;
  }

  if ((project.e2bSessions?.length || 0) > 0) {
    return true;
  }

  return false;
}

export const isCloudProject = (project: Project | null | undefined): boolean => {
  if (!project) {
    return false;
  }

  if (hasCloudProjectIdentity(project)) {
    return true;
  }

  if (hasLocalProviderSessions(project)) {
    return false;
  }

  return project.runtime === 'e2b' || project.kind === 'cloud';
};

export const resolveSessionRuntime = (
  session: ProjectSession | null | undefined,
): RuntimeMode =>
  session?.__runtime === 'e2b' ? 'e2b' : 'local';

export const resolveSelectionRuntime = (
  project: Project | null | undefined,
  session: ProjectSession | null | undefined,
): RuntimeMode => {
  if (hasSession(session)) {
    return resolveSessionRuntime(session);
  }

  return isCloudProject(project) ? 'e2b' : 'local';
};

export const isCloudSelection = (
  project: Project | null | undefined,
  session: ProjectSession | null | undefined,
): boolean => resolveSelectionRuntime(project, session) === 'e2b';

export const resolveEffectiveRuntimeMode = (
  project: Project | null | undefined,
  session: ProjectSession | null | undefined,
  draftRuntime: RuntimeMode = 'local',
): RuntimeMode => {
  if (hasSession(session)) {
    return resolveSessionRuntime(session);
  }

  if (isCloudProject(project)) {
    return 'e2b';
  }

  return draftRuntime;
};

export const resolveSelectionProvider = (
  project: Project | null | undefined,
  session: ProjectSession | null | undefined,
  fallbackProvider: SessionProvider = 'claude',
): SessionProvider => {
  if (hasSession(session)) {
    if (session.__runtime === 'e2b') {
      return 'e2b';
    }

    return (session.__provider || fallbackProvider) as SessionProvider;
  }

  return isCloudProject(project) ? 'e2b' : fallbackProvider;
};

export const isSameSelectedSession = (
  selectedSession: ProjectSession | null | undefined,
  candidateSession: ProjectSession | null | undefined,
  candidateProjectName?: string | null,
): boolean => {
  if (!hasSession(selectedSession) || !hasSession(candidateSession)) {
    return false;
  }

  if (selectedSession.id !== candidateSession.id) {
    return false;
  }

  const selectedProjectName = selectedSession.__projectName || null;
  if (selectedProjectName && candidateProjectName && selectedProjectName !== candidateProjectName) {
    return false;
  }

  if (
    selectedSession.__runtime !== undefined &&
    resolveSessionRuntime(selectedSession) !== resolveSessionRuntime(candidateSession)
  ) {
    return false;
  }

  if (
    selectedSession.__provider &&
    candidateSession.__provider &&
    selectedSession.__provider !== candidateSession.__provider
  ) {
    return false;
  }

  return true;
};
