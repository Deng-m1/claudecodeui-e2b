/**
 * E2B Sandbox Manager
 *
 * Manages E2B sandbox lifecycle: create, connect, pause, resume, destroy.
 * Uses the sandbox-agent TypeScript SDK with E2B provider for remote
 * coding agent execution.
 *
 * @module providers/e2b/sandbox-manager
 */

let SandboxAgentModule = null;
let e2bModule = null;
const DEFAULT_E2B_TEMPLATE_NAME = 'claudecodeui-cloud-agent';
const NATIVE_E2B_CLI_COMMANDS = {
  claude: {
    command: 'claude',
    versionArgs: ['--version'],
  },
  codex: {
    command: 'codex',
    versionArgs: ['--version'],
  },
};
const NATIVE_E2B_CLI_INSTALL_PACKAGES = {
  claude: process.env.E2B_NATIVE_CLAUDE_PACKAGE || '@anthropic-ai/claude-code@latest',
  codex: process.env.E2B_NATIVE_CODEX_PACKAGE || '@openai/codex@latest',
};
const NATIVE_E2B_CLI_BOOTSTRAP_ORDER = ['claude', 'codex'];
const MANAGED_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CLIPROXY_API_KEY',
  'CURSOR_API_KEY',
  'GEMINI_API_KEY',
];
const LEGACY_TEMPLATE_ALIASES = new Map([
  ['cloudagent', `${DEFAULT_E2B_TEMPLATE_NAME}:latest`],
  ['cloudagent:latest', `${DEFAULT_E2B_TEMPLATE_NAME}:latest`],
]);
const warnedLegacyTemplates = new Set();

async function loadSDK() {
  if (!SandboxAgentModule) {
    const mod = await import('sandbox-agent');
    SandboxAgentModule = mod.SandboxAgent;
  }
  if (!e2bModule) {
    const mod = await import('sandbox-agent/e2b');
    e2bModule = mod.e2b;
  }
  return { SandboxAgent: SandboxAgentModule, e2b: e2bModule };
}

/** @type {import('sandbox-agent').SandboxAgent | null} */
let activeSandboxClient = null;

/** @type {string | null} */
let activeSandboxId = null;

function hasOwnEnv(envs, key) {
  return Object.prototype.hasOwnProperty.call(envs, key);
}

function shouldInjectHostAnthropicApiKey(envs) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return false;
  }

  if (hasOwnEnv(envs, 'ANTHROPIC_API_KEY')) {
    return false;
  }

  if (hasOwnEnv(envs, 'ANTHROPIC_AUTH_TOKEN')) {
    return false;
  }

  return true;
}

function hasManagedAuthEnv(envs = {}) {
  return MANAGED_AUTH_ENV_KEYS.some((key) => hasOwnEnv(envs, key));
}

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function hydrateSandboxManagedAuthEnvs(sandboxId, envs = {}) {
  if (!sandboxId || hasManagedAuthEnv(envs)) {
    return envs;
  }

  try {
    const [dbModule, authSyncModule, connectHostModule] = await Promise.all([
      import('../../database/db.js'),
      import('./auth-sync.js'),
      import('./connect-host.js'),
    ]);

    const sandboxRecord = dbModule.e2bSandboxDb.getBySandboxId(sandboxId);
    if (!sandboxRecord) {
      return envs;
    }

    const metadata = parseMetadataJson(sandboxRecord.metadata_json);
    const sandboxConnectHost = connectHostModule.resolveSandboxConnectHostFromRequest(null, sandboxRecord);
    const authSelections = authSyncModule.extractE2BAuthSelectionsFromMetadata(sandboxRecord.metadata_json);
    const authBundle = await authSyncModule.resolveE2BAuthBundle(authSelections, {
      strict: false,
      userId: sandboxRecord.user_id || null,
      sandboxConnectHost:
        sandboxConnectHost ||
        (typeof metadata?.sandboxConnectHost === 'string' ? metadata.sandboxConnectHost : ''),
      refreshClaudeProfiles: false,
    });

    return {
      ...authBundle.envs,
      ...envs,
    };
  } catch (error) {
    console.warn(`[E2B] Could not hydrate stored auth envs for ${sandboxId}:`, error?.message || error);
    return envs;
  }
}

function sanitizeEnvs(envs) {
  return Object.fromEntries(
    Object.entries(envs).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

function getSandboxErrorStatus(error) {
  return error?.status || error?.response?.status || null;
}

function getSandboxErrorMessage(error) {
  const problemMessage =
    error?.problem && typeof error.problem.message === 'string'
      ? error.problem.message.trim()
      : '';
  const baseMessage = error instanceof Error ? error.message : String(error || '');
  return problemMessage || baseMessage.trim();
}

function isSandboxUnavailableError(error) {
  const status = getSandboxErrorStatus(error);
  const message = getSandboxErrorMessage(error).toLowerCase();

  if (status !== 404 && status !== 502) {
    return false;
  }

  return (
    message.includes('sandbox was not found') ||
    message.includes('sandbox not found') ||
    message.includes('paused sandbox') ||
    message.includes('no longer exists')
  );
}

async function validateSandboxClient(client, sandboxId = null) {
  if (!client || typeof client.statFs !== 'function') {
    return client;
  }

  try {
    await client.statFs({ path: '/' });
    return client;
  } catch (error) {
    if (isSandboxUnavailableError(error)) {
      const resolvedSandboxId = sandboxId || client.sandboxId || 'unknown';
      const readableError = new Error(
        `E2B sandbox ${resolvedSandboxId} is unavailable: ${getSandboxErrorMessage(error)}`,
      );
      readableError.cause = error;
      throw readableError;
    }

    throw error;
  }
}

async function disposeClientQuietly(client, sandboxId = null) {
  if (!client || typeof client.dispose !== 'function') {
    return;
  }

  try {
    await client.dispose();
  } catch (error) {
    console.warn(
      `[E2B] Failed to dispose sandbox client ${sandboxId || client.sandboxId || 'unknown'}:`,
      error?.message || error,
    );
  }
}

function normalizeProcessOutput(result) {
  return typeof result?.stdout === 'string' ? result.stdout.trim() : '';
}

async function runSandboxCommand(client, command, args = []) {
  return client.runProcess({
    command,
    args,
    cwd: '/home/user',
    timeoutMs: 20_000,
    maxOutputBytes: 128_000,
  });
}

async function inspectNativeE2BCli(client, cliId, spec) {
  const missing = {
    installed: false,
    path: '',
    version: '',
    exitCode: null,
    error: '',
  };

  try {
    const whichResult = await runSandboxCommand(client, 'bash', ['-lc', `command -v ${spec.command}`]);
    if (whichResult.exitCode !== 0) {
      return {
        ...missing,
        exitCode: whichResult.exitCode,
        error: normalizeProcessOutput(whichResult) || String(whichResult?.stderr || '').trim() || `${cliId} is not installed`,
      };
    }

    const versionResult = await runSandboxCommand(client, spec.command, spec.versionArgs);
    return {
      installed: versionResult.exitCode === 0,
      path: normalizeProcessOutput(whichResult),
      version: normalizeProcessOutput(versionResult) || String(versionResult?.stderr || '').trim(),
      exitCode: versionResult.exitCode ?? 0,
      error: versionResult.exitCode === 0 ? '' : String(versionResult?.stderr || '').trim(),
    };
  } catch (error) {
    return {
      ...missing,
      error: error instanceof Error ? error.message : String(error || `${cliId} inspection failed`),
    };
  }
}

function buildNativeCliInstallCommand(commandName, packageName, options = {}) {
  const { forceReinstall = false } = options;

  return [
    'set -e',
    'export npm_config_update_notifier=false',
    'export npm_config_fund=false',
    'export npm_config_audit=false',
    forceReinstall
      ? `npm install -g ${packageName}`
      : `if ! command -v ${commandName} >/dev/null 2>&1; then npm install -g ${packageName}; fi`,
  ].join('\n');
}

export async function ensureNativeCliInstalled(client = activeSandboxClient, cliId, options = {}) {
  if (!client) {
    throw new Error('No active E2B sandbox');
  }

  const normalizedCliId = typeof cliId === 'string' ? cliId.trim().toLowerCase() : '';
  const { forceReinstall = false } = options;
  const spec = NATIVE_E2B_CLI_COMMANDS[normalizedCliId];
  const packageName = NATIVE_E2B_CLI_INSTALL_PACKAGES[normalizedCliId];

  if (!spec || !packageName) {
    throw new Error(`Unsupported native CLI install target: ${cliId}`);
  }

  const status = await inspectNativeE2BCli(client, normalizedCliId, spec);
  if (status.installed && !forceReinstall) {
    return status;
  }

  console.log(`[E2B] ${forceReinstall ? 'Refreshing' : 'Installing'} native ${normalizedCliId} CLI inside sandbox ${client.sandboxId || activeSandboxId || 'unknown'}...`);
  await client.runProcess({
    command: 'bash',
    args: ['-lc', buildNativeCliInstallCommand(spec.command, packageName, { forceReinstall })],
    cwd: '/home/user',
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 4 * 1024 * 1024,
  });

  const refreshedStatus = await inspectNativeE2BCli(client, normalizedCliId, spec);
  if (!refreshedStatus.installed) {
    throw new Error(refreshedStatus.error || `Failed to install ${normalizedCliId} CLI inside E2B`);
  }

  return refreshedStatus;
}

export async function bootstrapNativeCliRuntime(client = activeSandboxClient, options = {}) {
  if (!client) {
    throw new Error('No active E2B sandbox');
  }

  const { forceReinstall = false, cliIds = NATIVE_E2B_CLI_BOOTSTRAP_ORDER } = options;

  for (const cliId of cliIds) {
    await ensureNativeCliInstalled(client, cliId, { forceReinstall });
  }

  return getNativeCliRuntimeStatus(client);
}

function isMissingTemplateError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('template') && message.includes('not found');
}

function normalizeTemplateValue(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const legacyAlias = LEGACY_TEMPLATE_ALIASES.get(trimmed.toLowerCase());
  if (!legacyAlias) {
    return trimmed;
  }

  if (!warnedLegacyTemplates.has(trimmed.toLowerCase())) {
    console.warn(`[E2B] Template "${trimmed}" is deprecated. Using "${legacyAlias}" instead.`);
    warnedLegacyTemplates.add(trimmed.toLowerCase());
  }

  return legacyAlias;
}

export function resolveE2BTemplate(explicitTemplate) {
  const directTemplate = normalizeTemplateValue(explicitTemplate) || normalizeTemplateValue(process.env.E2B_TEMPLATE);
  if (directTemplate) {
    return directTemplate;
  }

  const templateName = normalizeTemplateValue(process.env.E2B_TEMPLATE_NAME) || DEFAULT_E2B_TEMPLATE_NAME;
  return templateName.includes(':') ? templateName : `${templateName}:latest`;
}

async function startSandboxAgentWithTemplateFallback(SandboxAgent, e2b, { template, envs }) {
  const providerOptions = {
    create: { envs },
    autoPause: true,
  };

  if (template) {
    providerOptions.template = template;
  }

  try {
    return await SandboxAgent.start({
      sandbox: e2b(providerOptions),
    });
  } catch (error) {
    if (!template || !isMissingTemplateError(error)) {
      throw error;
    }

    console.warn(`[E2B] Template "${template}" not found. Retrying with default template.`);
    return SandboxAgent.start({
      sandbox: e2b({
        create: { envs },
        autoPause: true,
      }),
    });
  }
}

async function resumeSandboxAgentWithTemplateFallback(SandboxAgent, e2b, { sandboxId, template, envs }) {
  const providerOptions = {
    create: { envs },
    autoPause: true,
  };

  if (template) {
    providerOptions.template = template;
  }

  try {
    return await SandboxAgent.start({
      sandboxId,
      sandbox: e2b(providerOptions),
    });
  } catch (error) {
    if (!template || !isMissingTemplateError(error)) {
      throw error;
    }

    console.warn(`[E2B] Template "${template}" not found during resume. Retrying with default template.`);
    return SandboxAgent.start({
      sandboxId,
      sandbox: e2b({
        create: { envs },
        autoPause: true,
      }),
    });
  }
}

/**
 * Get the current sandbox-agent client, or null if not connected.
 * @returns {import('sandbox-agent').SandboxAgent | null}
 */
export function getSandboxClient() {
  return activeSandboxClient;
}

/**
 * Get the current sandbox ID.
 * @returns {string | null}
 */
export function getSandboxId() {
  return activeSandboxId;
}

/**
 * Check if E2B runtime mode is enabled.
 * @returns {boolean}
 */
export function isE2BEnabled() {
  return process.env.RUNTIME_MODE === 'e2b';
}

/**
 * Check if E2B credentials are configured.
 * @returns {boolean}
 */
export function isE2BConfigured() {
  return typeof process.env.E2B_API_KEY === 'string' && process.env.E2B_API_KEY.trim().length > 0;
}

/**
 * Create and start a new E2B sandbox with sandbox-agent running inside.
 * @param {object} [options]
 * @param {string} [options.template] - E2B template ID
 * @param {Record<string, string>} [options.envs] - Environment variables to pass into the sandbox
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
export async function createSandbox(options = {}) {
  if (!isE2BConfigured()) {
    throw new Error('E2B_API_KEY is not configured');
  }

  const { SandboxAgent, e2b } = await loadSDK();
  const { forceNew = false } = options;

  if (activeSandboxClient) {
    if (forceNew) {
      await disposeSandbox();
    } else {
      console.log('[E2B] Sandbox already active, returning existing client');
      return activeSandboxClient;
    }
  }

  const envs = { ...options.envs };
  if (shouldInjectHostAnthropicApiKey(envs)) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY && !hasOwnEnv(envs, 'OPENAI_API_KEY')) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  // Always inject GITHUB_TOKEN if available (for git push/PR from inside sandbox)
  if (process.env.GITHUB_TOKEN && !hasOwnEnv(envs, 'GITHUB_TOKEN')) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  const sanitizedEnvs = sanitizeEnvs(envs);

  const template = resolveE2BTemplate(options.template);

  console.log('[E2B] Creating sandbox...', template ? `template=${template}` : '(default template)');
  const client = await startSandboxAgentWithTemplateFallback(SandboxAgent, e2b, {
    template,
    envs: sanitizedEnvs,
  });

  try {
    await validateSandboxClient(client, client.sandboxId || null);
  } catch (error) {
    await disposeClientQuietly(client, client.sandboxId || null);
    throw error;
  }

  activeSandboxClient = client;
  activeSandboxId = client.sandboxId || null;

  console.log(`[E2B] Sandbox created: ${activeSandboxId}`);

  // Auto-configure git credentials if GITHUB_TOKEN was injected
  if (sanitizedEnvs.GITHUB_TOKEN) {
    await setupGitCredentials(client);
  }

  await bootstrapNativeCliRuntime(client, { forceReinstall: true });

  return client;
}

/**
 * Connect to an existing sandbox-agent server (e.g. after resume or manual deploy).
 * @param {object} options
 * @param {string} options.baseUrl - Sandbox-agent server URL
 * @param {string} [options.token] - Auth token
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
export async function connectToSandbox({ baseUrl, token }) {
  const { SandboxAgent } = await loadSDK();

  if (activeSandboxClient) {
    await disposeSandbox();
  }

  console.log(`[E2B] Connecting to sandbox at ${baseUrl}`);

  const client = await SandboxAgent.connect({ baseUrl, token });

  try {
    await validateSandboxClient(client, client.sandboxId || baseUrl);
  } catch (error) {
    await disposeClientQuietly(client, client.sandboxId || baseUrl);
    throw error;
  }

  activeSandboxClient = client;
  activeSandboxId = client.sandboxId || baseUrl;

  console.log(`[E2B] Connected to sandbox: ${activeSandboxId}`);
  return client;
}

/**
 * Pause the active sandbox (preserves state, stops billing).
 * Returns the sandboxId for later resume.
 */
export async function pauseSandbox() {
  if (!activeSandboxClient) {
    throw new Error('No active E2B sandbox to pause');
  }
  const id = activeSandboxId;
  console.log(`[E2B] Pausing sandbox: ${id}`);
  await activeSandboxClient.pauseSandbox();
  activeSandboxClient = null;
  activeSandboxId = null;
  console.log(`[E2B] Sandbox paused: ${id}`);
  return id;
}

/**
 * Resume a previously paused sandbox by its ID.
 * @param {string} sandboxId - The E2B sandbox ID to resume
 * @param {Record<string, string>} [envs] - Environment variables
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
export async function resumeSandbox(sandboxId, envs = {}) {
  if (!isE2BConfigured()) {
    throw new Error('E2B_API_KEY is not configured');
  }

  const { SandboxAgent, e2b } = await loadSDK();

  if (activeSandboxClient) {
    await disposeSandbox();
  }

  if (shouldInjectHostAnthropicApiKey(envs)) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (!hasOwnEnv(envs, 'OPENAI_API_KEY') && process.env.OPENAI_API_KEY) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (process.env.GITHUB_TOKEN && !hasOwnEnv(envs, 'GITHUB_TOKEN')) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  const sanitizedEnvs = sanitizeEnvs(envs);

  const template = resolveE2BTemplate();

  console.log(`[E2B] Resuming sandbox: ${sandboxId}`);
  const client = await resumeSandboxAgentWithTemplateFallback(SandboxAgent, e2b, {
    sandboxId,
    template,
    envs: sanitizedEnvs,
  });

  try {
    await validateSandboxClient(client, sandboxId);
  } catch (error) {
    await disposeClientQuietly(client, sandboxId);
    throw error;
  }

  activeSandboxClient = client;
  activeSandboxId = sandboxId;

  console.log(`[E2B] Sandbox resumed: ${sandboxId}`);

  // Re-setup git credentials (env vars may have been refreshed)
  if (sanitizedEnvs.GITHUB_TOKEN) {
    await setupGitCredentials(client);
  }

  await bootstrapNativeCliRuntime(client, { forceReinstall: false });

  return client;
}

/**
 * Ensure the requested sandbox is the active connection.
 * If a different sandbox is active, the current client is disposed first.
 *
 * @param {string | null | undefined} sandboxId
 * @param {Record<string, string>} [envs]
 * @returns {Promise<import('sandbox-agent').SandboxAgent | null>}
 */
export async function ensureSandboxConnected(sandboxId, envs = {}) {
  if (!sandboxId) {
    return activeSandboxClient;
  }

  const resolvedEnvs = await hydrateSandboxManagedAuthEnvs(sandboxId, envs);

  if (activeSandboxClient && activeSandboxId === sandboxId) {
    try {
      await validateSandboxClient(activeSandboxClient, sandboxId);
      return activeSandboxClient;
    } catch (error) {
      console.warn(
        `[E2B] Active sandbox client for ${sandboxId} failed validation, reconnecting:`,
        error?.message || error,
      );
      await disposeClientQuietly(activeSandboxClient, sandboxId);
      activeSandboxClient = null;
      activeSandboxId = null;
    }
  }

  return resumeSandbox(sandboxId, resolvedEnvs);
}

/**
 * Destroy the active sandbox permanently.
 */
export async function destroySandbox() {
  if (!activeSandboxClient) {
    throw new Error('No active E2B sandbox to destroy');
  }
  console.log(`[E2B] Destroying sandbox: ${activeSandboxId}`);
  await activeSandboxClient.destroySandbox();
  activeSandboxClient = null;
  activeSandboxId = null;
  console.log('[E2B] Sandbox destroyed');
}

/**
 * Dispose the client connection without destroying the sandbox.
 */
export async function disposeSandbox() {
  if (!activeSandboxClient) return;
  console.log(`[E2B] Disposing sandbox client: ${activeSandboxId}`);
  await activeSandboxClient.dispose();
  activeSandboxClient = null;
  activeSandboxId = null;
}

export async function invalidateSandboxConnection(sandboxId = null, reason = null) {
  if (!activeSandboxClient) {
    return false;
  }

  if (sandboxId && activeSandboxId && sandboxId !== activeSandboxId) {
    return false;
  }

  const targetSandboxId = sandboxId || activeSandboxId || activeSandboxClient.sandboxId || 'unknown';
  const reasonText = reason instanceof Error ? reason.message : String(reason || '');
  console.warn(
    `[E2B] Invalidating sandbox client: ${targetSandboxId}${reasonText ? ' (' + reasonText + ')' : ''}`,
  );
  await disposeClientQuietly(activeSandboxClient, targetSandboxId);
  activeSandboxClient = null;
  activeSandboxId = null;
  return true;
}

/**
 * List available agents in the sandbox.
 * @returns {Promise<Array<{id: string, installed: boolean, version?: string}>>}
 */
export async function listSandboxAgents() {
  if (!activeSandboxClient) {
    throw new Error('No active E2B sandbox');
  }
  const response = await activeSandboxClient.listAgents();
  return response.agents;
}

/**
 * Configure git credentials inside the sandbox so that git push / PR creation works.
 * Sets up a credential helper that uses GITHUB_TOKEN env var, plus user identity.
 * @param {import('sandbox-agent').SandboxAgent} client
 * @param {object} [options]
 * @param {string} [options.gitName] - git user.name (defaults to 'Claude Code UI')
 * @param {string} [options.gitEmail] - git user.email (defaults to 'claudecodeui@users.noreply.github.com')
 */
export async function setupGitCredentials(client, options = {}) {
  const gitName = options.gitName || 'Claude Code UI';
  const gitEmail = options.gitEmail || 'claudecodeui@users.noreply.github.com';

  const script = [
    // Set git identity
    `git config --global user.name '${gitName.replace(/'/g, "'\\''")}'`,
    `git config --global user.email '${gitEmail.replace(/'/g, "'\\''")}'`,
    // Configure credential helper: uses GITHUB_TOKEN env var for github.com HTTPS auth
    `git config --global credential.helper '!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'`,
    // Also set the gh CLI token if available
    `[ -n "$GITHUB_TOKEN" ] && echo "$GITHUB_TOKEN" > /tmp/.gh_token && gh auth login --with-token < /tmp/.gh_token 2>/dev/null; rm -f /tmp/.gh_token`,
  ].join(' && ');

  try {
    console.log('[E2B] Setting up git credentials inside sandbox...');
    await client.runProcess({
      command: 'bash',
      args: ['-c', script],
    });
    console.log('[E2B] Git credentials configured');
  } catch (err) {
    // Non-fatal: git credentials might not be needed for all use cases
    console.warn('[E2B] Failed to configure git credentials:', err.message);
  }
}

export async function getNativeCliRuntimeStatus(client = activeSandboxClient) {
  if (!client) {
    return {
      sandboxId: activeSandboxId,
      available: false,
      providers: Object.fromEntries(
        Object.keys(NATIVE_E2B_CLI_COMMANDS).map((cliId) => [cliId, {
          installed: false,
          path: '',
          version: '',
          exitCode: null,
          error: 'No active E2B sandbox',
        }]),
      ),
    };
  }

  const entries = await Promise.all(
    Object.entries(NATIVE_E2B_CLI_COMMANDS).map(async ([cliId, spec]) => [
      cliId,
      await inspectNativeE2BCli(client, cliId, spec),
    ]),
  );

  const providers = Object.fromEntries(entries);
  const available = Object.values(providers).every((provider) => provider.installed);

  return {
    sandboxId: client.sandboxId || activeSandboxId,
    available,
    providers,
  };
}

/**
 * Get sandbox status info.
 * @returns {object}
 */
export function getSandboxStatus() {
  return {
    active: !!activeSandboxClient,
    sandboxId: activeSandboxId,
    inspectorUrl: activeSandboxClient?.inspectorUrl || null,
    template: resolveE2BTemplate(),
  };
}
