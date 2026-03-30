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
 * Create and start a new E2B sandbox with sandbox-agent running inside.
 * @param {object} [options]
 * @param {string} [options.template] - E2B template ID
 * @param {Record<string, string>} [options.envs] - Environment variables to pass into the sandbox
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
export async function createSandbox(options = {}) {
  const { SandboxAgent, e2b } = await loadSDK();

  if (activeSandboxClient) {
    console.log('[E2B] Sandbox already active, returning existing client');
    return activeSandboxClient;
  }

  const envs = { ...options.envs };
  if (process.env.ANTHROPIC_API_KEY && !envs.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY && !envs.OPENAI_API_KEY) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  // Always inject GITHUB_TOKEN if available (for git push/PR from inside sandbox)
  if (process.env.GITHUB_TOKEN && !envs.GITHUB_TOKEN) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  const template = options.template || process.env.E2B_TEMPLATE || undefined;

  console.log('[E2B] Creating sandbox...', template ? `template=${template}` : '(default template)');

  const e2bProvider = e2b({
    template,
    create: { envs },
    autoPause: true,
  });

  const client = await SandboxAgent.start({
    sandbox: e2bProvider,
  });

  activeSandboxClient = client;
  activeSandboxId = client.sandboxId || null;

  console.log(`[E2B] Sandbox created: ${activeSandboxId}`);

  // Auto-configure git credentials if GITHUB_TOKEN was injected
  if (envs.GITHUB_TOKEN) {
    await setupGitCredentials(client);
  }

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
  const { SandboxAgent, e2b } = await loadSDK();

  if (activeSandboxClient) {
    await disposeSandbox();
  }

  if (!envs.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (!envs.OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (process.env.GITHUB_TOKEN && !envs.GITHUB_TOKEN) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  const template = process.env.E2B_TEMPLATE || undefined;

  console.log(`[E2B] Resuming sandbox: ${sandboxId}`);

  const e2bProvider = e2b({
    template,
    create: { envs },
    autoPause: true,
  });

  const client = await SandboxAgent.connect({
    sandboxId,
    sandbox: e2bProvider,
  });

  activeSandboxClient = client;
  activeSandboxId = sandboxId;

  console.log(`[E2B] Sandbox resumed: ${sandboxId}`);

  // Re-setup git credentials (env vars may have been refreshed)
  if (envs.GITHUB_TOKEN) {
    await setupGitCredentials(client);
  }

  return client;
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
    await client.runProcess({ cmd: ['bash', '-c', script] });
    console.log('[E2B] Git credentials configured');
  } catch (err) {
    // Non-fatal: git credentials might not be needed for all use cases
    console.warn('[E2B] Failed to configure git credentials:', err.message);
  }
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
  };
}
