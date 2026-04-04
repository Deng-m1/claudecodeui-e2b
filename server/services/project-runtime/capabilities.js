export const LOCAL_PROJECT_CAPABILITIES = Object.freeze({
  files: true,
  git: true,
  shell: true,
});

export const E2B_PROJECT_CAPABILITIES = Object.freeze({
  files: true,
  git: true,
  shell: true,
});

export function getProjectCapabilities(runtime = 'local') {
  return runtime === 'e2b'
    ? { ...E2B_PROJECT_CAPABILITIES }
    : { ...LOCAL_PROJECT_CAPABILITIES };
}

export function normalizeProjectCapabilities(capabilities, runtime = 'local') {
  const fallback = getProjectCapabilities(runtime);

  if (!capabilities || typeof capabilities !== 'object') {
    return fallback;
  }

  return {
    files: typeof capabilities.files === 'boolean' ? capabilities.files : fallback.files,
    git: typeof capabilities.git === 'boolean' ? capabilities.git : fallback.git,
    shell: typeof capabilities.shell === 'boolean' ? capabilities.shell : fallback.shell,
  };
}
