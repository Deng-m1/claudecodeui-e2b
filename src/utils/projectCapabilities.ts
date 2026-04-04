import type { AppTab, Project, ProjectCapabilities } from '../types/app';

const LOCAL_PROJECT_CAPABILITIES: ProjectCapabilities = {
  files: true,
  git: true,
  shell: true,
};

const CLOUD_PROJECT_CAPABILITIES: ProjectCapabilities = {
  files: true,
  git: true,
  shell: true,
};

export const getProjectCapabilities = (
  project: Project | null | undefined,
): ProjectCapabilities => {
  const fallback = project?.runtime === 'e2b' || project?.kind === 'cloud'
    ? CLOUD_PROJECT_CAPABILITIES
    : LOCAL_PROJECT_CAPABILITIES;

  return {
    files: typeof project?.capabilities?.files === 'boolean' ? project.capabilities.files : fallback.files,
    git: typeof project?.capabilities?.git === 'boolean' ? project.capabilities.git : fallback.git,
    shell: typeof project?.capabilities?.shell === 'boolean' ? project.capabilities.shell : fallback.shell,
  };
};

export const isProjectTabSupported = (
  project: Project | null | undefined,
  tab: AppTab,
  shouldShowTasksTab = false,
): boolean => {
  const capabilities = getProjectCapabilities(project);

  if (tab === 'chat') {
    return true;
  }

  if (tab === 'files') {
    return capabilities.files;
  }

  if (tab === 'git') {
    return capabilities.git;
  }

  if (tab === 'shell') {
    return capabilities.shell;
  }

  if (tab === 'tasks') {
    return shouldShowTasksTab;
  }

  if (tab === 'preview') {
    return capabilities.shell;
  }

  if (tab.startsWith('plugin:')) {
    return true;
  }

  return false;
};
