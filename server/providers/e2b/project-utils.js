const E2B_PROJECT_PREFIX = 'e2b__';

export function buildE2BProjectName(sandboxId) {
  return `${E2B_PROJECT_PREFIX}${sandboxId}`;
}

export function isE2BProjectName(projectName) {
  return typeof projectName === 'string' && projectName.startsWith(E2B_PROJECT_PREFIX);
}

export function extractSandboxIdFromProjectName(projectName) {
  if (!isE2BProjectName(projectName)) {
    return null;
  }

  const sandboxId = projectName.slice(E2B_PROJECT_PREFIX.length).trim();
  return sandboxId || null;
}

export function resolveE2BAgentProvider(agent) {
  const normalized = String(agent || '').toLowerCase();

  if (normalized.includes('cursor')) {
    return 'cursor';
  }

  if (normalized.includes('codex') || normalized.includes('openai')) {
    return 'codex';
  }

  if (normalized.includes('gemini')) {
    return 'gemini';
  }

  return 'claude';
}

export function getE2BProjectDisplayName(repoUrl, fallbackSandboxId) {
  const normalizedUrl = String(repoUrl || '').trim();
  if (!normalizedUrl) {
    return `Cloud ${String(fallbackSandboxId || '').slice(0, 8) || 'Project'}`;
  }

  const repoName = normalizedUrl
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .pop();

  return repoName || `Cloud ${String(fallbackSandboxId || '').slice(0, 8) || 'Project'}`;
}
