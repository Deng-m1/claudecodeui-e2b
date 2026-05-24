const VALID_CODEX_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);

export function normalizeCodexPermissionMode(permissionMode, fallback = 'default') {
  const normalized = typeof permissionMode === 'string' ? permissionMode.trim() : '';

  if (normalized === 'plan') {
    return 'default';
  }

  if (VALID_CODEX_PERMISSION_MODES.has(normalized)) {
    return normalized;
  }

  return fallback;
}

export function mapPermissionModeToCodexOptions(permissionMode) {
  switch (normalizeCodexPermissionMode(permissionMode, 'default')) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted',
      };
  }
}
