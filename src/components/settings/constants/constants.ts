import type {
  AgentCategory,
  AgentProvider,
  AuthStatus,
  ClaudeMcpFormState,
  CodexFeatureToggles,
  CodexMcpFormState,
  CodexPermissionMode,
  CodeEditorSettingsState,
  CursorPermissionsState,
  McpToolsResult,
  McpTestResult,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

export const SETTINGS_MAIN_TABS: SettingsMainTab[] = [
  'agents',
  'appearance',
  'git',
  'api',
  'tasks',
  'notifications',
  'remoteHosts',
];

export const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex'];
export const AGENT_CATEGORIES: AgentCategory[] = ['account', 'permissions', 'mcp'];

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
export const DEFAULT_SAVE_STATUS = null;
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  theme: 'dark',
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};

export const DEFAULT_AUTH_STATUS: AuthStatus = {
  authenticated: false,
  email: null,
  loading: true,
  error: null,
};

export const DEFAULT_MCP_TEST_RESULT: McpTestResult = {
  success: false,
  message: '',
  details: [],
  loading: false,
};

export const DEFAULT_MCP_TOOLS_RESULT: McpToolsResult = {
  success: false,
  tools: [],
  resources: [],
  prompts: [],
};

export const DEFAULT_CLAUDE_MCP_FORM: ClaudeMcpFormState = {
  name: '',
  type: 'stdio',
  scope: 'user',
  projectPath: '',
  config: {
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {},
    timeout: 30000,
  },
  importMode: 'form',
  jsonInput: '',
};

export const DEFAULT_CODEX_MCP_FORM: CodexMcpFormState = {
  name: '',
  type: 'stdio',
  config: {
    command: '',
    args: [],
    env: {},
  },
};

export const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'bypassPermissions';

export const DEFAULT_CODEX_FEATURE_TOGGLES: CodexFeatureToggles = {
  multiAgent: true,
  parallelFanOut: true,
  reasoningSummaries: true,
  shellTool: true,
  webSearch: true,
  networkAccess: true,
};

export const normalizeCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return DEFAULT_CODEX_PERMISSION_MODE;
};

export const normalizeCodexFeatureToggles = (
  value: Partial<CodexFeatureToggles> | null | undefined,
): CodexFeatureToggles => ({
  multiAgent: value?.multiAgent !== false,
  parallelFanOut: value?.parallelFanOut !== false,
  reasoningSummaries: value?.reasoningSummaries !== false,
  shellTool: value?.shellTool !== false,
  webSearch: value?.webSearch !== false,
  networkAccess: value?.networkAccess !== false,
});

export const AUTH_STATUS_ENDPOINTS: Record<AgentProvider, string> = {
  claude: '/api/cli/claude/status',
  cursor: '/api/cli/cursor/status',
  codex: '/api/cli/codex/status',
  gemini: '/api/cli/gemini/status',
};
