const REMOTE_HOST_PROJECT_PREFIX = 'remote__';

export function buildRemoteHostProjectName(workspaceId) {
  return `${REMOTE_HOST_PROJECT_PREFIX}${workspaceId}`;
}

export function isRemoteHostProjectName(projectName = '') {
  return typeof projectName === 'string' && projectName.startsWith(REMOTE_HOST_PROJECT_PREFIX);
}

export function extractRemoteWorkspaceIdFromProjectName(projectName = '') {
  if (!isRemoteHostProjectName(projectName)) {
    return null;
  }

  const workspaceId = projectName.slice(REMOTE_HOST_PROJECT_PREFIX.length).trim();
  return workspaceId || null;
}
