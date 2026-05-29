import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import net from 'net';
import fetch from 'node-fetch';
import { remoteHostsDb, remoteWorkspacesDb } from '../database/db.js';
import { RemoteAgentError, remoteAgentRequest } from '../providers/remote-host/agent-client.js';
import { syncSavedRemoteHostSnapshot } from '../providers/remote-host/full-sync.js';

const router = express.Router();
const SSH_CONNECTION_MODE = 'bootstrap_ssh';
const AGENT_CONNECTION_MODE = 'existing_agent';
const SSH_AUTH_METHODS = new Set(['password', 'ssh_key']);
const CONNECTION_MODES = new Set([SSH_CONNECTION_MODE, AGENT_CONNECTION_MODE]);
const SSH_TEST_TIMEOUT_MS = 15000;
const SSH_CONNECT_TIMEOUT_SECONDS = 8;
const REMOTE_AGENT_TEMPLATE_URL = new URL('../assets/remote-agent.py', import.meta.url);
const REMOTE_AGENT_DEFAULT_PORT = 47100;
const REMOTE_AGENT_MAX_PORT_SCAN = 10;
const REMOTE_AGENT_SERVICE_NAME = 'claude-code-ui-remote-agent';
const REMOTE_AGENT_INSTALL_DIR = '.claude-code-ui/remote-agent';
const REMOTE_AGENT_HEALTH_TIMEOUT_MS = 8000;
const MANAGED_SSH_KEY_TYPE = 'ed25519';
const MANAGED_SSH_KEY_TIMEOUT_MS = 10000;

class RemoteHostTestError extends Error {
  constructor(message, status = 'unreachable') {
    super(message);
    this.name = 'RemoteHostTestError';
    this.status = status;
  }
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOptionalSecret(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function normalizeBooleanFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parsePort(value, fallback = 22) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function ensureAbsoluteWorkspaceRoot(value) {
  const workspaceRoot = normalizeNonEmptyString(value);
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required');
  }

  if (!workspaceRoot.startsWith('/')) {
    throw new Error('workspaceRoot must be an absolute remote path');
  }

  return workspaceRoot;
}

function validateConnectionMode(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!CONNECTION_MODES.has(normalized)) {
    throw new Error('connectionMode must be "bootstrap_ssh" or "existing_agent"');
  }

  return normalized;
}

function resolveAgentEndpoint(agentUrl) {
  const normalizedUrl = normalizeNonEmptyString(agentUrl);
  if (!normalizedUrl) {
    throw new Error('agentUrl is required for existing_agent connections');
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error('agentUrl must be a valid URL');
  }

  const port = parsePort(parsed.port || (parsed.protocol === 'https:' ? 443 : 80), parsed.protocol === 'https:' ? 443 : 80);
  if (!port) {
    throw new Error('agentUrl must include a valid port');
  }

  return {
    agentUrl: parsed.toString(),
    host: parsed.hostname,
    port,
  };
}

function validateHostPayload(payload = {}, { requireLabel = true, requireAgentToken = false, requireWorkspaceRoot = true } = {}) {
  const connectionMode = validateConnectionMode(payload.connectionMode);
  const label = normalizeNonEmptyString(payload.label);
  const workspaceRoot = requireWorkspaceRoot
    ? ensureAbsoluteWorkspaceRoot(payload.workspaceRoot)
    : (normalizeNonEmptyString(payload.workspaceRoot)
      ? ensureAbsoluteWorkspaceRoot(payload.workspaceRoot)
      : null);

  if (requireLabel && !label) {
    throw new Error('label is required');
  }

  let host = '';
  let port = 22;
  let username = '';
  let authMethod = null;
  let agentUrl = null;
  let savePasswordFallback = false;

  if (connectionMode === SSH_CONNECTION_MODE) {
    host = normalizeNonEmptyString(payload.host);
    if (!host) {
      throw new Error('host is required');
    }

    port = parsePort(payload.port, 22);
    if (!port) {
      throw new Error('port must be a valid TCP port');
    }

    username = normalizeNonEmptyString(payload.username);
    if (!username) {
      throw new Error('username is required');
    }

    authMethod = normalizeNonEmptyString(payload.authMethod) || 'password';
    if (!SSH_AUTH_METHODS.has(authMethod)) {
      throw new Error('authMethod must be "password" or "ssh_key"');
    }

    savePasswordFallback = authMethod === 'password' && normalizeBooleanFlag(payload.savePasswordFallback);
  } else {
    const endpoint = resolveAgentEndpoint(payload.agentUrl);
    host = normalizeNonEmptyString(payload.host) || endpoint.host;
    port = endpoint.port;
    agentUrl = endpoint.agentUrl;

    if (requireAgentToken && !normalizeOptionalSecret(payload.agentToken)) {
      throw new Error('agentToken is required for existing_agent connections');
    }
  }

  const hasAgentToken = normalizeOptionalSecret(payload.agentToken).length > 0;

  return {
    connectionMode,
    label: label || null,
    host,
    port,
    username: username || null,
    authMethod,
    agentUrl,
    savePasswordFallback,
    workspaceRoot,
    metadata: {
      hasPassword: connectionMode === SSH_CONNECTION_MODE && normalizeNonEmptyString(payload.password).length > 0,
      hasPrivateKey: connectionMode === SSH_CONNECTION_MODE && normalizeNonEmptyString(payload.privateKey).length > 0,
      hasPassphrase: connectionMode === SSH_CONNECTION_MODE && normalizeNonEmptyString(payload.passphrase).length > 0,
      hasAgentToken: connectionMode === AGENT_CONNECTION_MODE && hasAgentToken,
      transport: connectionMode === SSH_CONNECTION_MODE ? 'ssh-bootstrap-agent' : 'agent',
      secretPersistence: hasAgentToken ? 'agent_token' : 'none',
      savePasswordFallbackRequested: savePasswordFallback,
    },
    displayName: normalizeNonEmptyString(payload.displayName) || null,
  };
}

function listPersistedRemoteHostSecrets(host) {
  const persistedSecrets = [];
  if (normalizeOptionalSecret(host?.agent_token)) {
    persistedSecrets.push('agent_token');
  }
  if (normalizeOptionalSecret(host?.managed_ssh_private_key)) {
    persistedSecrets.push('managed_ssh_key');
  }
  if (normalizeOptionalSecret(host?.saved_ssh_password)) {
    persistedSecrets.push('saved_ssh_password');
  }
  return persistedSecrets;
}

function listRemoteBrowseFallbackOrder(host) {
  const fallbackOrder = [];
  if (normalizeNonEmptyString(host?.agent_url) && normalizeOptionalSecret(host?.agent_token)) {
    fallbackOrder.push('agent');
  }
  if (normalizeOptionalSecret(host?.managed_ssh_private_key)) {
    fallbackOrder.push('managed_key');
  }
  if (normalizeOptionalSecret(host?.saved_ssh_password)) {
    fallbackOrder.push('saved_password');
  }
  return fallbackOrder;
}

function buildRemoteHostResponse(host, workspaces = []) {
  const storedMetadata = host?.metadata && typeof host.metadata === 'object' ? host.metadata : null;
  const persistedSecrets = listPersistedRemoteHostSecrets(host);
  const browseFallbackOrder = listRemoteBrowseFallbackOrder(host);
  const hasAgentToken = persistedSecrets.includes('agent_token');
  const hasManagedSshKey = persistedSecrets.includes('managed_ssh_key');
  const hasSavedSshPassword = persistedSecrets.includes('saved_ssh_password');
  const metadata = (storedMetadata || persistedSecrets.length > 0 || browseFallbackOrder.length > 0)
    ? {
      ...(storedMetadata || {}),
      hasAgentToken,
      hasManagedSshKey,
      hasSavedSshPassword,
      browseFallbackOrder,
      persistedSecrets,
      savePasswordFallbackEnabled: hasSavedSshPassword,
      secretPersistence: persistedSecrets.length > 0
        ? persistedSecrets.join('+')
        : (storedMetadata?.secretPersistence || 'none'),
      transport: storedMetadata?.transport || (host.connection_mode === SSH_CONNECTION_MODE ? 'ssh-bootstrap-agent' : 'agent'),
    }
    : null;

  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    connectionMode: host.connection_mode,
    authMethod: host.auth_method,
    agentUrl: host.agent_url,
    status: host.status,
    lastError: host.last_error,
    lastTestedAt: host.last_tested_at,
    metadata,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      remoteHostId: workspace.remote_host_id,
      displayName: workspace.display_name,
      workspaceRoot: workspace.workspace_root,
      status: workspace.status,
      metadata: workspace.metadata || null,
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    })),
  };
}

function connectTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finalize(resolve, {
        latencyMs: Date.now() - startedAt,
      });
    });
    socket.once('timeout', () => {
      finalize(reject, new Error(`Connection timed out after ${timeoutMs}ms`));
    });
    socket.once('error', (error) => {
      finalize(reject, error);
    });
  });
}

function quotePosixShellArg(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function createManagedSshKeyComment(normalized) {
  const hostLabel = normalizeNonEmptyString(normalized?.host) || 'remote-host';
  return `claude-code-ui-managed-${hostLabel}-${randomUUID()}`;
}

function runProcess(command, args, { env = {}, timeoutMs = SSH_TEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env,
      },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      fn(value);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      finalize(reject, new RemoteHostTestError(`SSH probe timed out after ${timeoutMs}ms`, 'unreachable'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        const message = command === 'sshpass'
          ? 'sshpass is required on the platform host to test password or passphrase-protected SSH credentials'
          : `${command} is required on the platform host to test SSH connectivity`;
        finalize(reject, new RemoteHostTestError(message, 'probe_failed'));
        return;
      }

      finalize(reject, error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finalize(resolve, { stdout, stderr });
        return;
      }

      const combinedMessage = [stderr.trim(), stdout.trim()]
        .filter(Boolean)
        .join('\n')
        .trim() || `Command failed with exit code ${code}`;
      finalize(reject, new Error(combinedMessage));
    });
  });
}

function parseTaggedOutput(stdout = '') {
  const output = {};
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^__([A-Z0-9_]+)__(?:\s(.*))?$/);
    if (!match) {
      continue;
    }

    output[match[1]] = match[2] || '';
  }

  return output;
}

async function generateManagedSshKeyPair(normalized) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-ssh-key-'));
  const keyPath = path.join(tempDirectory, `id_${MANAGED_SSH_KEY_TYPE}`);

  try {
    await runProcess(
      'ssh-keygen',
      [
        '-q',
        '-t', MANAGED_SSH_KEY_TYPE,
        '-N', '',
        '-C', createManagedSshKeyComment(normalized),
        '-f', keyPath,
      ],
      { timeoutMs: MANAGED_SSH_KEY_TIMEOUT_MS },
    );

    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(`${keyPath}.pub`, 'utf8'),
    ]);

    return {
      privateKey,
      publicKey: publicKey.trim(),
    };
  } catch (error) {
    if (error instanceof RemoteHostTestError) {
      throw error;
    }

    throw new RemoteHostTestError(error.message || 'Failed to generate a platform-managed SSH key', 'probe_failed');
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function buildManagedSshInstallCommand(publicKey) {
  const publicKeyArg = quotePosixShellArg(publicKey.trim());

  return `
set -e

ssh_dir="\${HOME:-$PWD}/.ssh"
auth_file="$ssh_dir/authorized_keys"
managed_key=${publicKeyArg}

umask 077
mkdir -p "$ssh_dir"
touch "$auth_file"
chmod 700 "$ssh_dir"
chmod 600 "$auth_file"

if ! grep -qxF "$managed_key" "$auth_file" 2>/dev/null; then
  printf '%s\\n' "$managed_key" >> "$auth_file"
fi

printf '__MANAGED_SSH_KEY__ installed\\n'
`.trim();
}

function buildStoredSshNormalization(host, authMethod) {
  const normalizedHost = normalizeNonEmptyString(host?.host);
  const username = normalizeNonEmptyString(host?.username);
  const port = parsePort(host?.port, 22);

  if (!normalizedHost || !username || !port) {
    throw new Error('Saved remote host is missing SSH connection metadata required for browse fallback');
  }

  return {
    connectionMode: SSH_CONNECTION_MODE,
    label: normalizeNonEmptyString(host?.label) || null,
    host: normalizedHost,
    port,
    username,
    authMethod,
    agentUrl: normalizeNonEmptyString(host?.agent_url) || null,
    savePasswordFallback: false,
    workspaceRoot: null,
    metadata: host?.metadata || null,
    displayName: null,
  };
}

async function verifyManagedSshAccess(normalized, managedKey) {
  try {
    await executeSshCommand(
      { privateKey: managedKey.privateKey },
      {
        ...normalized,
        authMethod: 'ssh_key',
      },
      'printf "__MANAGED_SSH_ACCESS__ ok\\n"',
    );
  } catch (error) {
    throw classifySshFailure(error);
  }
}

async function provisionManagedSshAccess(rawPayload, normalized) {
  const managedKey = await generateManagedSshKeyPair(normalized);

  try {
    await executeSshCommand(rawPayload, normalized, buildManagedSshInstallCommand(managedKey.publicKey));
  } catch (error) {
    throw classifySshFailure(error);
  }

  await verifyManagedSshAccess(normalized, managedKey);
  return managedKey;
}

function createCommandProbe(commandPath) {
  const normalizedPath = normalizeNonEmptyString(commandPath) || null;
  return {
    available: Boolean(normalizedPath),
    path: normalizedPath,
  };
}

function parseProbeBoolean(value) {
  return String(value).trim().toLowerCase() === 'yes';
}

function buildWorkspaceSummary(workspace) {
  if (workspace.exists && workspace.isDirectory && workspace.writable) {
    return `${workspace.path} exists and is writable.`;
  }

  if (workspace.exists && workspace.isDirectory) {
    return `${workspace.path} exists but is not writable by the remote user.`;
  }

  if (workspace.exists) {
    return `${workspace.path} exists but is not a directory.`;
  }

  if (workspace.parentExists && workspace.parentWritable) {
    return `${workspace.path} does not exist yet, but ${workspace.parentPath} is writable so it can be created there.`;
  }

  if (workspace.parentExists) {
    return `${workspace.path} does not exist, and ${workspace.parentPath} is not writable by the remote user.`;
  }

  return `${workspace.path} does not exist, and its parent directory ${workspace.parentPath} is not currently available.`;
}

function buildProbeWarnings(remote) {
  const warnings = [];

  if (!remote.commands.git.available) {
    warnings.push('git is not installed on the remote host');
  }

  if (!remote.commands.tmux.available) {
    warnings.push('tmux is not installed on the remote host');
  }

  if (!remote.commands.claude.available) {
    warnings.push('claude is not installed in the remote PATH');
  }

  if (!remote.commands.codex.available) {
    warnings.push('codex is not installed in the remote PATH');
  }

  if (remote.workspace.exists && !remote.workspace.isDirectory) {
    warnings.push(`workspaceRoot ${remote.workspace.path} exists but is not a directory`);
  } else if (remote.workspace.exists && !remote.workspace.writable) {
    warnings.push(`workspaceRoot ${remote.workspace.path} is not writable by ${remote.user}`);
  } else if (!remote.workspace.exists && !remote.workspace.parentWritable) {
    warnings.push(`workspaceRoot ${remote.workspace.path} cannot be created because parent ${remote.workspace.parentPath} is not writable`);
  }

  return warnings;
}

function buildProbeNote(remote) {
  const installedCli = ['git', 'tmux', 'claude', 'codex']
    .filter((name) => remote.commands[name]?.available)
    .join(', ') || 'none';

  return [
    `SSH authentication succeeded for ${remote.user}@${remote.host}:${remote.port}.`,
    `${remote.system} with shell ${remote.shell || 'unknown'}.`,
    `Remote PATH currently provides: ${installedCli}.`,
    buildWorkspaceSummary(remote.workspace),
    'CLI versions, shell semantics, and resume behavior will come from the remote host itself, not the platform host.',
  ].join(' ');
}

function buildRemoteProbe(workspaceRoot, normalized) {
  const workspaceRootArg = quotePosixShellArg(workspaceRoot);

  return `
workspace_root=${workspaceRootArg}
workspace_parent="\${workspace_root%/*}"
if [ -z "$workspace_parent" ] || [ "$workspace_parent" = "$workspace_root" ]; then
  workspace_parent="/"
fi

emit() {
  key="$1"
  shift
  printf '__%s__ %s\\n' "$key" "$*"
}

emit_cmd() {
  command_name="$1"
  key="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    emit "$key" "$(command -v "$command_name")"
  else
    emit "$key"
  fi
}

emit WHOAMI "$(whoami 2>/dev/null || true)"
emit HOST ${quotePosixShellArg(normalized.host)}
emit PORT ${quotePosixShellArg(String(normalized.port))}
emit UNAME "$(uname -a 2>/dev/null || true)"
emit HOME "\${HOME:-}"
emit SHELL "\${SHELL:-}"
emit PWD "$(pwd 2>/dev/null || true)"

emit_cmd git GIT
emit_cmd tmux TMUX
emit_cmd claude CLAUDE
emit_cmd codex CODEX
emit_cmd apt-get APT_GET

if [ -n "\${HOME:-}" ] && [ -d "\${HOME}/.claude" ]; then
  emit CLAUDE_DIR yes
else
  emit CLAUDE_DIR no
fi

if [ -n "\${HOME:-}" ] && [ -d "\${HOME}/.codex" ]; then
  emit CODEX_DIR yes
else
  emit CODEX_DIR no
fi

emit WORKSPACE_PATH "$workspace_root"
emit WORKSPACE_PARENT "$workspace_parent"

if [ -e "$workspace_root" ]; then
  emit WORKSPACE_EXISTS yes
else
  emit WORKSPACE_EXISTS no
fi

if [ -d "$workspace_root" ]; then
  emit WORKSPACE_IS_DIRECTORY yes
else
  emit WORKSPACE_IS_DIRECTORY no
fi

if [ -w "$workspace_root" ]; then
  emit WORKSPACE_WRITABLE yes
else
  emit WORKSPACE_WRITABLE no
fi

if [ -e "$workspace_parent" ]; then
  emit WORKSPACE_PARENT_EXISTS yes
else
  emit WORKSPACE_PARENT_EXISTS no
fi

if [ -w "$workspace_parent" ]; then
  emit WORKSPACE_PARENT_WRITABLE yes
else
  emit WORKSPACE_PARENT_WRITABLE no
fi
`.trim();
}

function parseRemoteProbe(stdout, normalized) {
  const parsed = parseTaggedOutput(stdout);
  const remote = {
    host: normalizeNonEmptyString(parsed.HOST) || normalized.host,
    port: Number.parseInt(parsed.PORT || String(normalized.port), 10) || normalized.port,
    user: normalizeNonEmptyString(parsed.WHOAMI) || normalized.username || 'unknown',
    home: normalizeNonEmptyString(parsed.HOME) || null,
    shell: normalizeNonEmptyString(parsed.SHELL) || null,
    cwd: normalizeNonEmptyString(parsed.PWD) || null,
    system: normalizeNonEmptyString(parsed.UNAME) || 'unknown',
    commands: {
      git: createCommandProbe(parsed.GIT),
      tmux: createCommandProbe(parsed.TMUX),
      claude: createCommandProbe(parsed.CLAUDE),
      codex: createCommandProbe(parsed.CODEX),
      aptGet: createCommandProbe(parsed.APT_GET),
    },
    configDirectories: {
      claude: parseProbeBoolean(parsed.CLAUDE_DIR),
      codex: parseProbeBoolean(parsed.CODEX_DIR),
    },
    workspace: {
      path: normalizeNonEmptyString(parsed.WORKSPACE_PATH) || normalized.workspaceRoot,
      parentPath: normalizeNonEmptyString(parsed.WORKSPACE_PARENT) || '/',
      exists: parseProbeBoolean(parsed.WORKSPACE_EXISTS),
      isDirectory: parseProbeBoolean(parsed.WORKSPACE_IS_DIRECTORY),
      writable: parseProbeBoolean(parsed.WORKSPACE_WRITABLE),
      parentExists: parseProbeBoolean(parsed.WORKSPACE_PARENT_EXISTS),
      parentWritable: parseProbeBoolean(parsed.WORKSPACE_PARENT_WRITABLE),
    },
  };

  return {
    remote,
    warnings: buildProbeWarnings(remote),
    note: buildProbeNote(remote),
  };
}

function classifySshFailure(error) {
  const message = String(error?.message || '').trim();

  if (!message) {
    return new RemoteHostTestError('SSH connectivity test failed', 'probe_failed');
  }

  if (/permission denied|authentication failed/i.test(message)) {
    return new RemoteHostTestError('SSH authentication failed. Check the username and SSH credentials.', 'auth_failed');
  }

  if (/connection refused|timed out|no route to host|could not resolve hostname|network is unreachable|connection closed by remote host/i.test(message)) {
    return new RemoteHostTestError(message, 'unreachable');
  }

  return new RemoteHostTestError(message, 'probe_failed');
}

function normalizeRemoteBrowsePath(value, fallback = '') {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return fallback;
  }

  if (normalized === '~' || normalized.startsWith('~/') || normalized.startsWith('/')) {
    return normalized;
  }

  throw new Error('path must be an absolute remote path or use ~ for the remote home directory');
}

function normalizeAgentBrowsePath(value, fallback = '/') {
  const normalized = normalizeRemoteBrowsePath(value, fallback);

  if (!normalized.startsWith('/')) {
    throw new Error('Agent directory browsing requires an absolute remote path');
  }

  return path.posix.normalize(normalized);
}

function buildRemoteDirectoryBrowseCommand(targetPath, { showHidden = false } = {}) {
  const browsePathArg = quotePosixShellArg(normalizeRemoteBrowsePath(targetPath, '~'));
  const showHiddenArg = quotePosixShellArg(showHidden ? 'yes' : 'no');

  return `
browse_path=${browsePathArg}
show_hidden=${showHiddenArg}

if [ -z "$browse_path" ]; then
  browse_path="\${HOME:-/}"
fi

case "$browse_path" in
  "~")
    browse_path="\${HOME:-/}"
    ;;
  "~/"*)
    browse_path="\${HOME:-/}/\${browse_path#~/}"
    ;;
esac

if [ ! -d "$browse_path" ]; then
  printf '__BROWSE_ERROR__ %s\\n' "Directory not found: $browse_path"
  exit 0
fi

cd "$browse_path" 2>/dev/null || {
  printf '__BROWSE_ERROR__ %s\\n' "Cannot open directory: $browse_path"
  exit 0
}

current_path="$(pwd -P 2>/dev/null || pwd)"
printf '__CURRENT_PATH__ %s\\n' "$current_path"

for entry in "$current_path"/* "$current_path"/.*; do
  [ -d "$entry" ] || continue
  name="$(basename "$entry")"
  if [ "$name" = "." ] || [ "$name" = ".." ]; then
    continue
  fi
  if [ "$show_hidden" != "yes" ] && [ "\${name#\\.}" != "$name" ]; then
    continue
  fi
  printf '__DIR__ %s\\t%s\\n' "$name" "$entry"
done
`.trim();
}

function parseRemoteDirectoryBrowse(stdout = '') {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let currentPath = '';
  let browseError = '';
  const suggestions = [];

  for (const line of lines) {
    const errorMatch = line.match(/^__BROWSE_ERROR__(?:\s(.*))?$/);
    if (errorMatch) {
      browseError = normalizeNonEmptyString(errorMatch[1]) || 'Failed to browse remote directory';
      continue;
    }

    const currentPathMatch = line.match(/^__CURRENT_PATH__(?:\s(.*))?$/);
    if (currentPathMatch) {
      currentPath = path.posix.normalize(normalizeNonEmptyString(currentPathMatch[1]) || '/');
      continue;
    }

    const dirMatch = line.match(/^__DIR__(?:\s(.*))?$/);
    if (!dirMatch) {
      continue;
    }

    const [name, entryPath] = String(dirMatch[1] || '').split('\t');
    if (!name || !entryPath) {
      continue;
    }

    suggestions.push({
      name,
      path: path.posix.normalize(entryPath),
      type: 'directory',
    });
  }

  if (browseError) {
    throw new RemoteHostTestError(browseError, 'probe_failed');
  }

  if (!currentPath) {
    throw new RemoteHostTestError('Failed to resolve the current remote directory', 'probe_failed');
  }

  suggestions.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
  return {
    path: currentPath,
    suggestions,
  };
}

function normalizeRemoteAgentBrowseResult(dirPath, response, { showHidden = false } = {}) {
  const suggestions = (Array.isArray(response?.entries) ? response.entries : [])
    .filter((entry) => entry?.entryType === 'directory')
    .filter((entry) => showHidden || !String(entry?.name || '').startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: 'directory',
    }))
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));

  return {
    path: dirPath,
    suggestions,
  };
}

async function browseSshRemoteDirectories(rawPayload, normalized, targetPath, { showHidden = false } = {}) {
  const browseCommand = buildRemoteDirectoryBrowseCommand(targetPath, { showHidden });

  try {
    const result = await executeSshCommand(rawPayload, normalized, browseCommand);
    return parseRemoteDirectoryBrowse(result.stdout || '');
  } catch (error) {
    throw classifySshFailure(error);
  }
}

async function browseAgentRemoteDirectories(host, targetPath, { showHidden = false } = {}) {
  const dirPath = normalizeAgentBrowsePath(targetPath, '/');
  const response = await remoteAgentRequest(host, '/fs/list', { path: dirPath });
  return normalizeRemoteAgentBrowseResult(dirPath, response, { showHidden });
}

async function browseSavedRemoteHostDirectories(host, targetPath, { showHidden = false } = {}) {
  const failures = [];
  const normalizedPath = normalizeRemoteBrowsePath(targetPath, '');
  const canUseAgentPath = !normalizedPath || normalizedPath.startsWith('/');

  if (normalizeNonEmptyString(host?.agent_url) && normalizeOptionalSecret(host?.agent_token) && canUseAgentPath) {
    try {
      return await browseAgentRemoteDirectories(
        {
          agent_url: host.agent_url,
          agent_token: host.agent_token,
        },
        normalizedPath || '/',
        { showHidden },
      );
    } catch (error) {
      failures.push(`agent: ${error.message || 'unknown error'}`);
    }
  }

  const managedPrivateKey = normalizeOptionalSecret(host?.managed_ssh_private_key);
  if (managedPrivateKey) {
    try {
      return await browseSshRemoteDirectories(
        { privateKey: managedPrivateKey },
        buildStoredSshNormalization(host, 'ssh_key'),
        normalizedPath || '~',
        { showHidden },
      );
    } catch (error) {
      failures.push(`managed SSH key: ${error.message || 'unknown error'}`);
    }
  }

  const savedPassword = normalizeOptionalSecret(host?.saved_ssh_password);
  if (savedPassword) {
    try {
      return await browseSshRemoteDirectories(
        { password: savedPassword },
        buildStoredSshNormalization(host, 'password'),
        normalizedPath || '~',
        { showHidden },
      );
    } catch (error) {
      failures.push(`saved password: ${error.message || 'unknown error'}`);
    }
  }

  if (failures.length === 0) {
    throw new Error(
      canUseAgentPath
        ? 'No saved browse credential is available for this remote host. Bootstrap it to install a platform-managed SSH key, or enable saved password fallback when saving the host.'
        : 'This saved host can only browse non-absolute paths such as ~ through its SSH fallback chain, but no SSH fallback credential is available.',
    );
  }

  throw new Error(`Saved host browse failed across the fallback chain: ${failures.join(' | ')}`);
}

async function withTemporaryPrivateKey(privateKey, callback) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-host-key-'));
  const keyPath = path.join(tempDirectory, 'id_remote');

  try {
    const normalizedKey = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
    await fs.writeFile(keyPath, normalizedKey, { mode: 0o600 });
    return await callback(keyPath);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeSshCommand(rawPayload, normalized, remoteCommand, { timeoutMs = SSH_TEST_TIMEOUT_MS } = {}) {
  const password = normalizeOptionalSecret(rawPayload?.password);
  const privateKey = normalizeOptionalSecret(rawPayload?.privateKey);
  const passphrase = normalizeOptionalSecret(rawPayload?.passphrase);
  const sshBaseArgs = [
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'ServerAliveInterval=5',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-p', String(normalized.port),
  ];

  if (normalized.authMethod === 'password') {
    if (!password) {
      throw new RemoteHostTestError('password is required to test SSH bootstrap connectivity', 'auth_failed');
    }

    return runProcess(
      'sshpass',
      [
        '-e',
        'ssh',
        ...sshBaseArgs,
        '-o', 'PreferredAuthentications=password',
        '-o', 'PubkeyAuthentication=no',
        `${normalized.username}@${normalized.host}`,
        remoteCommand,
      ],
      {
        env: {
          SSHPASS: password,
        },
        timeoutMs,
      },
    );
  }

  if (!privateKey) {
    throw new RemoteHostTestError('privateKey is required to test SSH key bootstrap connectivity', 'auth_failed');
  }

  return withTemporaryPrivateKey(privateKey, async (keyPath) => {
    const sshArgs = [
      ...sshBaseArgs,
      '-i', keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      `${normalized.username}@${normalized.host}`,
      remoteCommand,
    ];

    if (passphrase) {
      return runProcess(
        'sshpass',
        [
          '-P', 'Enter passphrase',
          '-e',
          'ssh',
          ...sshArgs,
        ],
        {
          env: {
            SSHPASS: passphrase,
          },
          timeoutMs,
        },
      );
    }

    return runProcess('ssh', sshArgs, { timeoutMs });
  });
}

function normalizeAgentHealthToRemote(agentHealth, agentUrl) {
  const system = agentHealth?.system || {};

  return {
    host: normalizeNonEmptyString(new URL(agentUrl).hostname) || null,
    port: parsePort(new URL(agentUrl).port || 80, 80),
    user: normalizeNonEmptyString(system.user) || 'unknown',
    home: normalizeNonEmptyString(system.home) || null,
    shell: normalizeNonEmptyString(system.shell) || null,
    cwd: normalizeNonEmptyString(system.cwd) || null,
    system: normalizeNonEmptyString(system.system) || null,
    commands: {
      git: createCommandProbe(system.commands?.git?.path),
      tmux: createCommandProbe(system.commands?.tmux?.path),
      claude: createCommandProbe(system.commands?.claude?.path),
      codex: createCommandProbe(system.commands?.codex?.path),
      aptGet: createCommandProbe(null),
    },
    configDirectories: {
      claude: false,
      codex: false,
    },
    workspace: null,
  };
}

async function fetchRemoteAgentJson(agentUrl, agentToken, pathname = '/health', timeoutMs = REMOTE_AGENT_HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(pathname, agentUrl), {
      headers: {
        Authorization: `Bearer ${agentToken}`,
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error || `Remote agent request failed with HTTP ${response.status}`;
      throw new RemoteHostTestError(message, response.status === 401 ? 'auth_failed' : 'probe_failed');
    }

    return payload;
  } catch (error) {
    if (error instanceof RemoteHostTestError) {
      throw error;
    }

    if (error?.name === 'AbortError') {
      throw new RemoteHostTestError(`Remote agent request timed out after ${timeoutMs}ms`, 'unreachable');
    }

    throw new RemoteHostTestError(error.message || 'Failed to connect to remote agent', 'unreachable');
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function testSshRemoteHost(rawPayload, normalized) {
  const startedAt = Date.now();
  const remoteProbeCommand = buildRemoteProbe(normalized.workspaceRoot, normalized);

  try {
    const result = await executeSshCommand(rawPayload, normalized, remoteProbeCommand);
    const parsed = parseRemoteProbe(result.stdout, normalized);

    return {
      success: true,
      status: 'reachable',
      connectionMode: SSH_CONNECTION_MODE,
      targetHost: normalized.host,
      targetPort: normalized.port,
      workspaceRoot: normalized.workspaceRoot,
      latencyMs: Date.now() - startedAt,
      authVerified: true,
      note: parsed.note,
      warnings: parsed.warnings,
      remote: parsed.remote,
    };
  } catch (error) {
    throw classifySshFailure(error);
  }
}

async function testExistingAgentRemoteHost(rawPayload, normalized) {
  const endpoint = resolveAgentEndpoint(normalized.agentUrl);
  const latencyProbe = await connectTcp(endpoint.host, endpoint.port);
  const agentToken = normalizeOptionalSecret(rawPayload?.agentToken);

  if (!agentToken) {
    return {
      success: true,
      status: 'reachable',
      connectionMode: AGENT_CONNECTION_MODE,
      targetHost: endpoint.host,
      targetPort: endpoint.port,
      workspaceRoot: normalized.workspaceRoot,
      latencyMs: latencyProbe.latencyMs,
      authVerified: false,
      note: 'Agent endpoint TCP reachability is confirmed. Enter an agent token to verify the remote-agent health endpoint.',
    };
  }

  const health = await fetchRemoteAgentJson(endpoint.agentUrl, agentToken, '/health');
  let providers = null;
  try {
    providers = await fetchRemoteAgentJson(endpoint.agentUrl, agentToken, '/probe/providers');
  } catch {
    providers = null;
  }

  const remote = normalizeAgentHealthToRemote(health, endpoint.agentUrl);
  const warnings = [];
  if (Array.isArray(providers?.providers)) {
    for (const provider of providers.providers) {
      if (Array.isArray(provider?.warnings)) {
        warnings.push(...provider.warnings);
      }
    }
    remote.configDirectories = {
      claude: Boolean(providers.providers.find((provider) => provider.provider === 'claude')?.authFiles?.length),
      codex: Boolean(providers.providers.find((provider) => provider.provider === 'codex')?.authFiles?.length),
    };
  }

  return {
    success: true,
    status: 'reachable',
    connectionMode: AGENT_CONNECTION_MODE,
    targetHost: endpoint.host,
    targetPort: endpoint.port,
    workspaceRoot: normalized.workspaceRoot,
    latencyMs: latencyProbe.latencyMs,
    authVerified: true,
    note: `Remote agent health check succeeded for ${endpoint.agentUrl}.`,
    warnings,
    remote,
    agent: {
      version: health?.version || null,
      capabilities: Array.isArray(health?.capabilities) ? health.capabilities : [],
      providers: providers?.providers || [],
    },
  };
}

function buildRemoteAgentBootstrapCommand(agentScriptContent, agentToken) {
  return `
set -e

emit() {
  key="$1"
  shift
  printf '__%s__ %s\\n' "$key" "$*"
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "__BOOTSTRAP_ERROR__ python3 is required on the remote host"
  exit 1
fi

agent_dir="\${HOME:-$PWD}/${REMOTE_AGENT_INSTALL_DIR}"
script_path="$agent_dir/remote-agent.py"
token_path="$agent_dir/agent.token"
port_path="$agent_dir/agent.port"
pid_path="$agent_dir/agent.pid"
log_path="$agent_dir/agent.log"
service_file="/etc/systemd/system/${REMOTE_AGENT_SERVICE_NAME}.service"
mkdir -p "$agent_dir"

cat > "$script_path" <<'__CCUI_REMOTE_AGENT_PY__'
${agentScriptContent}
__CCUI_REMOTE_AGENT_PY__
chmod 700 "$script_path"

cat > "$token_path" <<'__CCUI_REMOTE_AGENT_TOKEN__'
${agentToken}
__CCUI_REMOTE_AGENT_TOKEN__
chmod 600 "$token_path"

use_systemd="no"
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')" = "systemd" ]; then
  use_systemd="yes"
  systemctl stop ${REMOTE_AGENT_SERVICE_NAME}.service >/dev/null 2>&1 || true
fi

existing_port=""
if [ -f "$port_path" ]; then
  existing_port="$(cat "$port_path" 2>/dev/null | tr -dc '0-9')"
fi

if [ -f "$pid_path" ]; then
  existing_pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    kill "$existing_pid" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

agent_port="$(EXISTING_PORT="$existing_port" python3 - <<'__CCUI_SELECT_PORT__'
import os
import socket

preferred = ${REMOTE_AGENT_DEFAULT_PORT}
scan_count = ${REMOTE_AGENT_MAX_PORT_SCAN}
existing = os.environ.get('EXISTING_PORT', '').strip()
candidates = []

if existing:
    try:
        candidates.append(int(existing))
    except ValueError:
        pass

for port in range(preferred, preferred + scan_count + 1):
    candidates.append(port)

seen = set()
for port in candidates:
    if port in seen:
        continue
    seen.add(port)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(('0.0.0.0', port))
    except OSError:
        continue
    finally:
        sock.close()
    print(port)
    raise SystemExit(0)

raise SystemExit(1)
__CCUI_SELECT_PORT__
)"

if [ -z "$agent_port" ]; then
  echo "__BOOTSTRAP_ERROR__ unable to allocate remote-agent port"
  exit 1
fi

printf '%s' "$agent_port" > "$port_path"

if [ "$use_systemd" = "yes" ]; then
  cat > "$service_file" <<__CCUI_REMOTE_AGENT_SERVICE__
[Unit]
Description=Claude Code UI Remote Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$agent_dir
ExecStart=/usr/bin/python3 $script_path --host 0.0.0.0 --port $agent_port --token-file $token_path
Restart=always
RestartSec=2
Environment=HOME=$HOME
Environment=SHELL=$SHELL

[Install]
WantedBy=multi-user.target
__CCUI_REMOTE_AGENT_SERVICE__
  systemctl daemon-reload
  systemctl enable --now ${REMOTE_AGENT_SERVICE_NAME}.service
  install_mode="systemd"
else
  nohup python3 "$script_path" --host 0.0.0.0 --port "$agent_port" --token-file "$token_path" >> "$log_path" 2>&1 &
  echo $! > "$pid_path"
  install_mode="nohup"
fi

local_health="no"
for _ in $(seq 1 20); do
  if AGENT_TOKEN=${quotePosixShellArg(agentToken)} AGENT_PORT="$agent_port" python3 - <<'__CCUI_HEALTHCHECK__'
import json
import os
import sys
import urllib.request

token = os.environ.get('AGENT_TOKEN', '')
port = os.environ.get('AGENT_PORT', '')
request = urllib.request.Request(
    f'http://127.0.0.1:{port}/health',
    headers={'Authorization': f'Bearer {token}'},
)
with urllib.request.urlopen(request, timeout=2) as response:
    payload = json.loads(response.read().decode('utf-8'))
if not payload.get('ok'):
    raise SystemExit(1)
print('ok')
__CCUI_HEALTHCHECK__
  then
    local_health="yes"
    break
  fi
  sleep 1
done

emit AGENT_DIR "$agent_dir"
emit AGENT_PORT "$agent_port"
emit AGENT_URL "http://$(hostname -I 2>/dev/null | awk '{print $1}' || true):$agent_port"
emit INSTALL_MODE "$install_mode"
emit SERVICE_NAME "${REMOTE_AGENT_SERVICE_NAME}"
emit LOCAL_HEALTH "$local_health"
`.trim();
}

async function bootstrapSshRemoteHost(rawPayload, normalized) {
  const agentScriptContent = await fs.readFile(REMOTE_AGENT_TEMPLATE_URL, 'utf8');
  const agentToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
  let stdout = '';

  try {
    const result = await executeSshCommand(
      rawPayload,
      normalized,
      buildRemoteAgentBootstrapCommand(agentScriptContent, agentToken),
      { timeoutMs: 45000 },
    );
    stdout = result.stdout || '';
  } catch (error) {
    throw classifySshFailure(error);
  }

  const parsed = parseTaggedOutput(stdout);
  if (normalizeNonEmptyString(parsed.BOOTSTRAP_ERROR)) {
    throw new RemoteHostTestError(parsed.BOOTSTRAP_ERROR, 'probe_failed');
  }

  const agentPort = parsePort(parsed.AGENT_PORT, REMOTE_AGENT_DEFAULT_PORT);
  if (!agentPort) {
    throw new RemoteHostTestError('Remote bootstrap did not return a valid agent port', 'probe_failed');
  }

  if (!parseProbeBoolean(parsed.LOCAL_HEALTH)) {
    throw new RemoteHostTestError('Remote agent process did not pass its local health check', 'probe_failed');
  }

  const agentUrl = `http://${normalized.host}:${agentPort}`;
  let platformHealthVerified = false;
  let platformHealthError = null;
  let health = null;
  let providers = null;

  try {
    health = await fetchRemoteAgentJson(agentUrl, agentToken, '/health');
    platformHealthVerified = true;
    providers = await fetchRemoteAgentJson(agentUrl, agentToken, '/probe/providers').catch(() => null);
  } catch (error) {
    platformHealthError = error.message || 'Platform could not reach the remote-agent health endpoint';
  }

  const warnings = [];
  if (!platformHealthVerified && platformHealthError) {
    warnings.push(platformHealthError);
  }
  if (Array.isArray(providers?.providers)) {
    for (const provider of providers.providers) {
      if (Array.isArray(provider?.warnings)) {
        warnings.push(...provider.warnings);
      }
    }
  }

  return {
    status: platformHealthVerified ? 'online' : 'bootstrapped',
    bootstrap: {
      agentUrl,
      agentToken,
      port: agentPort,
      installMode: normalizeNonEmptyString(parsed.INSTALL_MODE) || 'nohup',
      serviceName: normalizeNonEmptyString(parsed.SERVICE_NAME) || REMOTE_AGENT_SERVICE_NAME,
      agentDir: normalizeNonEmptyString(parsed.AGENT_DIR) || null,
      localHealthVerified: true,
      platformHealthVerified,
      platformHealthError,
      health,
      providers: providers?.providers || [],
    },
    warnings,
    note: platformHealthVerified
      ? 'Remote agent bootstrapped successfully and is reachable from the platform.'
      : 'Remote agent bootstrapped successfully on the remote host, but the platform could not reach its HTTP endpoint yet.',
  };
}

router.get('/', async (req, res) => {
  try {
    const hosts = remoteHostsDb.getByUser(req.user.id);
    const workspaces = remoteWorkspacesDb.getByUser(req.user.id);
    const workspacesByHost = new Map();

    for (const workspace of workspaces) {
      const current = workspacesByHost.get(workspace.remote_host_id) || [];
      current.push(workspace);
      workspacesByHost.set(workspace.remote_host_id, current);
    }

    res.json({
      success: true,
      hosts: hosts.map((host) => buildRemoteHostResponse(host, workspacesByHost.get(host.id) || [])),
    });
  } catch (error) {
    console.error('[Remote Hosts] List failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to load remote hosts' });
  }
});

router.post('/browse', async (req, res) => {
  try {
    const showHidden = req.body?.showHidden === true;
    const requestedPath = normalizeRemoteBrowsePath(req.body?.path, '');
    const hostId = normalizeNonEmptyString(req.body?.hostId);

    if (hostId) {
      const host = remoteHostsDb.getById(req.user.id, hostId);
      if (!host) {
        return res.status(404).json({ success: false, error: 'Remote host not found' });
      }

      const result = await browseSavedRemoteHostDirectories(host, requestedPath, { showHidden });

      return res.json({
        success: true,
        ...result,
      });
    }

    const normalized = validateHostPayload(req.body || {}, {
      requireLabel: false,
      requireAgentToken: req.body?.connectionMode === AGENT_CONNECTION_MODE,
      requireWorkspaceRoot: false,
    });

    const result = normalized.connectionMode === SSH_CONNECTION_MODE
      ? await browseSshRemoteDirectories(req.body || {}, normalized, requestedPath || '~', { showHidden })
      : await browseAgentRemoteDirectories(
        {
          agent_url: resolveAgentEndpoint(req.body?.agentUrl).agentUrl,
          agent_token: normalizeOptionalSecret(req.body?.agentToken),
        },
        normalizeAgentBrowsePath(requestedPath || '/', '/'),
        { showHidden },
      );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[Remote Hosts] Browse failed:', error);
    const status = error instanceof RemoteAgentError
      ? error.status
      : (error instanceof RemoteHostTestError ? 400 : 400);
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to browse remote directories',
    });
  }
});

router.post('/test', async (req, res) => {
  try {
    const normalized = validateHostPayload(req.body || {}, { requireLabel: false });
    if (normalized.connectionMode === SSH_CONNECTION_MODE) {
      const result = await testSshRemoteHost(req.body || {}, normalized);
      return res.json(result);
    }

    const result = await testExistingAgentRemoteHost(req.body || {}, normalized);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      status: error instanceof RemoteHostTestError ? error.status : 'unreachable',
      error: error.message || 'Failed to test remote host connectivity',
    });
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    const normalized = validateHostPayload(req.body || {});
    if (normalized.connectionMode !== SSH_CONNECTION_MODE) {
      return res.status(400).json({
        success: false,
        error: 'Bootstrap is only supported for "bootstrap_ssh" remote hosts',
      });
    }

    const bootstrapResult = await bootstrapSshRemoteHost(req.body || {}, normalized);
    const managedKey = await provisionManagedSshAccess(req.body || {}, normalized);
    const lastTestedAt = new Date().toISOString();
    const savedSshPassword = normalized.savePasswordFallback
      ? (normalizeOptionalSecret(req.body?.password) || null)
      : null;
    const host = remoteHostsDb.create(req.user.id, {
      label: normalized.label,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      connectionMode: normalized.connectionMode,
      authMethod: normalized.authMethod,
      agentUrl: bootstrapResult.bootstrap.agentUrl,
      agentToken: bootstrapResult.bootstrap.agentToken,
      managedSshPrivateKey: managedKey.privateKey,
      managedSshPublicKey: managedKey.publicKey,
      savedSshPassword,
      status: bootstrapResult.status,
      lastError: bootstrapResult.bootstrap.platformHealthError || null,
      lastTestedAt,
      metadata: {
        ...normalized.metadata,
        hasAgentToken: true,
        hasManagedSshKey: true,
        hasSavedSshPassword: Boolean(savedSshPassword),
        secretPersistence: savedSshPassword
          ? 'agent_token+managed_ssh_key+saved_ssh_password'
          : 'agent_token+managed_ssh_key',
        bootstrap: {
          installMode: bootstrapResult.bootstrap.installMode,
          localHealthVerified: bootstrapResult.bootstrap.localHealthVerified,
          platformHealthVerified: bootstrapResult.bootstrap.platformHealthVerified,
          serviceName: bootstrapResult.bootstrap.serviceName,
          agentDir: bootstrapResult.bootstrap.agentDir,
          managedSshKeyInstalledAt: lastTestedAt,
          bootstrappedAt: lastTestedAt,
        },
      },
    });
    const workspace = remoteWorkspacesDb.create(req.user.id, {
      remoteHostId: host.id,
      displayName: normalized.displayName || normalized.label,
      workspaceRoot: normalized.workspaceRoot,
      metadata: {
        source: 'ssh_bootstrap_registration',
      },
    });

    res.status(201).json({
      success: true,
      host: buildRemoteHostResponse(host, [workspace]),
      bootstrap: bootstrapResult.bootstrap,
      warnings: bootstrapResult.warnings,
      note: `${bootstrapResult.note} The generated agent token and platform-managed SSH key have been stored for future remote runtime access and directory browsing.`,
    });
  } catch (error) {
    console.error('[Remote Hosts] Bootstrap failed:', error);
    const status = error instanceof RemoteHostTestError ? 400 : 500;
    res.status(status).json({
      success: false,
      status: error instanceof RemoteHostTestError ? error.status : 'probe_failed',
      error: error.message || 'Failed to bootstrap remote host',
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const normalized = validateHostPayload(req.body || {}, { requireAgentToken: true });
    const agentToken = normalizeOptionalSecret(req.body?.agentToken) || null;
    const lastTestedAt = new Date().toISOString();
    const isSshBootstrap = normalized.connectionMode === SSH_CONNECTION_MODE;
    const managedKey = isSshBootstrap
      ? await provisionManagedSshAccess(req.body || {}, normalized)
      : null;
    const savedSshPassword = isSshBootstrap && normalized.savePasswordFallback
      ? (normalizeOptionalSecret(req.body?.password) || null)
      : null;
    const host = remoteHostsDb.create(req.user.id, {
      label: normalized.label,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      connectionMode: normalized.connectionMode,
      authMethod: normalized.authMethod,
      agentUrl: normalized.agentUrl,
      agentToken,
      managedSshPrivateKey: managedKey?.privateKey || null,
      managedSshPublicKey: managedKey?.publicKey || null,
      savedSshPassword,
      status: isSshBootstrap ? 'reachable' : 'unknown',
      lastTestedAt: isSshBootstrap ? lastTestedAt : null,
      metadata: {
        ...normalized.metadata,
        hasManagedSshKey: Boolean(managedKey),
        hasSavedSshPassword: Boolean(savedSshPassword),
        secretPersistence: isSshBootstrap
          ? (savedSshPassword ? 'managed_ssh_key+saved_ssh_password' : 'managed_ssh_key')
          : (agentToken ? 'agent_token' : normalized.metadata.secretPersistence),
      },
    });
    const workspace = remoteWorkspacesDb.create(req.user.id, {
      remoteHostId: host.id,
      displayName: normalized.displayName || normalized.label,
      workspaceRoot: normalized.workspaceRoot,
      metadata: {
        source: 'initial_registration',
      },
    });

    res.status(201).json({
      success: true,
      host: buildRemoteHostResponse(host, [workspace]),
      note: isSshBootstrap
        ? 'Remote host metadata saved. A platform-managed SSH key is now available for future directory browsing and runtime access.'
        : 'Remote host metadata saved and its agent token is available for remote runtime access.',
    });
  } catch (error) {
    console.error('[Remote Hosts] Create failed:', error);
    const status = String(error?.message || '').toLowerCase().includes('unique') ? 409 : 400;
    res.status(status).json({ success: false, error: error.message || 'Failed to create remote host' });
  }
});

router.post('/:hostId/workspaces', async (req, res) => {
  try {
    const host = remoteHostsDb.getById(req.user.id, req.params.hostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Remote host not found' });
    }

    const workspaceRoot = ensureAbsoluteWorkspaceRoot(req.body?.workspaceRoot);
    const displayName = normalizeNonEmptyString(req.body?.displayName) || host.label;
    const workspace = remoteWorkspacesDb.create(req.user.id, {
      remoteHostId: host.id,
      displayName,
      workspaceRoot,
      metadata: {
        source: 'manual_registration',
      },
    });

    res.status(201).json({
      success: true,
      workspace: buildRemoteHostResponse(host, [workspace]).workspaces[0],
    });
  } catch (error) {
    console.error('[Remote Hosts] Add workspace failed:', error);
    const status = String(error?.message || '').toLowerCase().includes('unique') ? 409 : 400;
    res.status(status).json({ success: false, error: error.message || 'Failed to register remote workspace' });
  }
});

router.post('/:hostId/sync', async (req, res) => {
  try {
    const host = remoteHostsDb.getById(req.user.id, req.params.hostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Remote host not found' });
    }

    const workspaceRoots = Array.isArray(req.body?.workspaceRoots)
      ? req.body.workspaceRoots.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
      : [];
    const result = await syncSavedRemoteHostSnapshot(
      req.user.id,
      { hostId: host.id },
      {
        workspaceRoots,
        includePlatformSecrets: req.body?.includePlatformSecrets === true,
      },
    );

    res.json({
      success: true,
      ...result,
      note: 'Remote host state was exported to a local snapshot bundle. Treat the archive as sensitive because it may contain remote CLI credentials and session files.',
    });
  } catch (error) {
    console.error('[Remote Hosts] Sync failed:', error);
    const message = error?.message || 'Failed to sync remote host state';
    const loweredMessage = String(message).toLowerCase();
    let status = 500;
    if (loweredMessage.includes('not found')) {
      status = 404;
    } else if (loweredMessage.includes('ssh credential')) {
      status = 412;
    }

    res.status(status).json({
      success: false,
      error: message,
    });
  }
});

router.delete('/workspaces/:workspaceId', async (req, res) => {
  try {
    const success = remoteWorkspacesDb.delete(req.user.id, req.params.workspaceId);
    if (!success) {
      return res.status(404).json({ success: false, error: 'Remote workspace not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Remote Hosts] Delete workspace failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete remote workspace' });
  }
});

router.patch('/workspaces/:workspaceId', async (req, res) => {
  try {
    const workspace = remoteWorkspacesDb.getById(req.user.id, req.params.workspaceId);
    if (!workspace) {
      return res.status(404).json({ success: false, error: 'Remote workspace not found' });
    }

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'displayName')) {
      const raw = req.body.displayName;
      updates.displayName =
        raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')
          ? null
          : String(raw).trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No supported fields to update' });
    }

    const updated = remoteWorkspacesDb.update(req.user.id, req.params.workspaceId, updates);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Remote workspace not found' });
    }

    const host = remoteHostsDb.getById(req.user.id, updated.remote_host_id);
    const response = host ? buildRemoteHostResponse(host, [updated]).workspaces[0] : {
      id: updated.id,
      remoteHostId: updated.remote_host_id,
      displayName: updated.display_name,
      workspaceRoot: updated.workspace_root,
      status: updated.status,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };

    res.json({ success: true, workspace: response });
  } catch (error) {
    console.error('[Remote Hosts] Update workspace failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update remote workspace' });
  }
});

router.delete('/:hostId', async (req, res) => {
  try {
    const success = remoteHostsDb.delete(req.user.id, req.params.hostId);
    if (!success) {
      return res.status(404).json({ success: false, error: 'Remote host not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Remote Hosts] Delete failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete remote host' });
  }
});

export default router;
export {
  bootstrapSshRemoteHost,
  browseSavedRemoteHostDirectories,
  generateManagedSshKeyPair,
  provisionManagedSshAccess,
  testSshRemoteHost,
  validateHostPayload,
};
