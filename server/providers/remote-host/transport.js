import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { remoteHostsDb } from '../../database/db.js';
import { RemoteAgentError, remoteAgentRequest } from './agent-client.js';

const SSH_CONNECT_TIMEOUT_SECONDS = 8;
const SSH_TIMEOUT_MS = 60_000;
const REMOTE_AGENT_RECOVERY_TIMEOUT_MS = 20_000;
const DEFAULT_REMOTE_AGENT_SERVICE_NAME = 'claude-code-ui-remote-agent';
const DEFAULT_REMOTE_AGENT_INSTALL_DIR = '.claude-code-ui/remote-agent';
const REMOTE_PROCESS_FALLBACK_PY = String.raw`
import json, os, shlex, subprocess, sys

payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
command = str(payload.get("command") or "").strip()
args = payload.get("args") or []
cwd = str(payload.get("cwd") or "").strip() or None
timeout_ms = int(payload.get("timeoutMs") or 0) if payload.get("timeoutMs") else 0
max_output_bytes = int(payload.get("maxOutputBytes") or 8388608)
raw_env = payload.get("env") or {}
login_shell = bool(payload.get("loginShell"))
use_shell = bool(payload.get("useShell")) or login_shell
shell = str(payload.get("shell") or os.environ.get("SHELL") or "/bin/bash").strip() or "/bin/bash"

result = {
    "stdout": "",
    "stderr": "",
    "exitCode": 127,
    "timedOut": False,
}

if not command:
    result["stderr"] = "Remote process payload is missing command"
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0)

env = os.environ.copy()
for key, value in raw_env.items():
    if value is None:
        continue
    env[str(key)] = str(value)

run_args = [command] + [str(item) for item in args]
if use_shell:
    shell_command = shlex.join(run_args)
    shell_flag = "-lc" if login_shell else "-c"
    run_args = [shell, shell_flag, shell_command]

try:
    completed = subprocess.run(
        run_args,
        cwd=cwd,
        env=env,
        capture_output=True,
        timeout=(timeout_ms / 1000.0) if timeout_ms else None,
        text=False,
    )
    stdout = completed.stdout or b""
    stderr = completed.stderr or b""
    result["stdout"] = stdout[:max_output_bytes].decode("utf-8", "replace")
    result["stderr"] = stderr[:max_output_bytes].decode("utf-8", "replace")
    result["exitCode"] = int(completed.returncode)
except subprocess.TimeoutExpired as exc:
    stdout = exc.stdout or b""
    stderr = exc.stderr or b""
    result["stdout"] = stdout[:max_output_bytes].decode("utf-8", "replace")
    result["stderr"] = stderr[:max_output_bytes].decode("utf-8", "replace")
    result["exitCode"] = 124
    result["timedOut"] = True
except FileNotFoundError:
    result["stderr"] = f"Command not found: {command}"
except Exception as exc:
    result["stderr"] = str(exc)

print(json.dumps(result, ensure_ascii=False))
`;
const REMOTE_AGENT_CONNECTION_DISCOVERY_PY = String.raw`
import json, os

host = os.environ.get("REMOTE_HOST_VALUE", "").strip()
port = os.environ.get("AGENT_PORT_VALUE", "").strip()
token = os.environ.get("AGENT_TOKEN_VALUE", "").strip()

try:
    numeric_port = int(port)
except Exception:
    numeric_port = 0

result = {
    "agentPort": numeric_port if numeric_port > 0 else None,
    "agentToken": token or None,
    "agentUrl": f"http://{host}:{numeric_port}" if host and numeric_port > 0 else None,
}

print(json.dumps(result, ensure_ascii=False))
`;

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOptionalSecret(value) {
  return typeof value === 'string' && value ? value : null;
}

function parsePort(value, fallback = 22) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 65535) {
    return numeric;
  }

  return fallback;
}

function quotePosixShellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function buildRemoteAgentDirShellExpression(host) {
  const configuredAgentDir = normalizeNonEmptyString(host?.metadata?.bootstrap?.agentDir);
  if (configuredAgentDir) {
    return quotePosixShellArg(configuredAgentDir);
  }

  return '"${HOME:-$PWD}/' + DEFAULT_REMOTE_AGENT_INSTALL_DIR + '"';
}

function resolveRemoteAgentHost(host) {
  const normalizedHost = normalizeNonEmptyString(host?.host);
  if (normalizedHost) {
    return normalizedHost;
  }

  try {
    return new URL(normalizeNonEmptyString(host?.agent_url)).hostname;
  } catch {
    return '';
  }
}

function appendLimitedOutput(current, chunk, maxBytes) {
  const next = current + chunk.toString();
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return next;
  }

  if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
    return next;
  }

  return Buffer.from(next, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function buildRecoveredHostSnapshot(host, recoveryResult = null) {
  const recoveredAgentUrl = normalizeNonEmptyString(recoveryResult?.agentUrl);
  const recoveredAgentToken = normalizeOptionalSecret(recoveryResult?.agentToken);

  return {
    ...(host && typeof host === 'object' ? host : {}),
    agent_url: recoveredAgentUrl || normalizeNonEmptyString(host?.agent_url) || null,
    agent_token: recoveredAgentToken || normalizeOptionalSecret(host?.agent_token),
  };
}

function applyRecoveredHostSnapshot(targetHost, recoveredHost) {
  if (!targetHost || typeof targetHost !== 'object' || !recoveredHost || typeof recoveredHost !== 'object') {
    return;
  }

  targetHost.agent_url = recoveredHost.agent_url || null;
  targetHost.agent_token = recoveredHost.agent_token || null;
  targetHost.status = 'online';
  targetHost.last_error = null;
}

async function persistRecoveredHostSnapshot(originalHost, recoveredHost, options = {}) {
  const persistRecoveredHost = typeof options.persistRecoveredHost === 'function'
    ? options.persistRecoveredHost
    : null;

  if (persistRecoveredHost) {
    return persistRecoveredHost(originalHost, recoveredHost);
  }

  const hostId = normalizeNonEmptyString(originalHost?.id);
  const userId = Number.parseInt(String(originalHost?.user_id ?? ''), 10);
  if (!hostId || !Number.isFinite(userId) || userId <= 0) {
    return null;
  }

  return remoteHostsDb.updateConnection(userId, hostId, {
    agentUrl: normalizeNonEmptyString(recoveredHost?.agent_url) || null,
    agentToken: normalizeOptionalSecret(recoveredHost?.agent_token),
    status: 'online',
    lastError: null,
    lastTestedAt: new Date().toISOString(),
  });
}

function runProcess(command, args, { env = {}, timeoutMs = SSH_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
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
    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        resolve({
          stdout,
          stderr: stderr || `Command timed out after ${timeoutMs}ms`,
          exitCode: 124,
          timedOut: true,
        });
      }
    }, timeoutMs);

    const finish = (error, result = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout = appendLimitedOutput(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimitedOutput(stderr, chunk, maxOutputBytes);
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      finish(null, {
        stdout,
        stderr,
        exitCode: Number.isFinite(code) ? code : 1,
        timedOut: false,
      });
    });
  });
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

export function buildStoredSshNormalization(host, authMethod) {
  const normalizedHost = normalizeNonEmptyString(host?.host);
  const username = normalizeNonEmptyString(host?.username);
  const port = parsePort(host?.port, 22);

  if (!normalizedHost || !username || !port) {
    throw new Error('Saved remote host is missing SSH connection metadata required for SSH fallback');
  }

  return {
    host: normalizedHost,
    port,
    username,
    authMethod,
  };
}

export function getSshCredentialPlans(host) {
  const plans = [];
  const managedPrivateKey = normalizeOptionalSecret(host?.managed_ssh_private_key);
  const savedPassword = normalizeOptionalSecret(host?.saved_ssh_password);

  if (managedPrivateKey) {
    plans.push({
      label: 'managed SSH key',
      rawPayload: { privateKey: managedPrivateKey },
      normalized: buildStoredSshNormalization(host, 'ssh_key'),
    });
  }

  if (savedPassword) {
    plans.push({
      label: 'saved password',
      rawPayload: { password: savedPassword },
      normalized: buildStoredSshNormalization(host, 'password'),
    });
  }

  return plans;
}

function buildRemoteAgentConnectionDiscoveryCommand(host) {
  const remoteHost = resolveRemoteAgentHost(host);

  return `
set -e
agent_dir=${buildRemoteAgentDirShellExpression(host)}
port_path="$agent_dir/agent.port"
token_path="$agent_dir/agent.token"
agent_port=""
agent_token=""

if [ -f "$port_path" ]; then
  agent_port="$(tr -d '\\r\\n' < "$port_path" 2>/dev/null || true)"
fi

if [ -f "$token_path" ]; then
  agent_token="$(tr -d '\\r\\n' < "$token_path" 2>/dev/null || true)"
fi

REMOTE_HOST_VALUE=${quotePosixShellArg(remoteHost)}
AGENT_PORT_VALUE="$agent_port" AGENT_TOKEN_VALUE="$agent_token" REMOTE_HOST_VALUE="$REMOTE_HOST_VALUE" python3 -c ${quotePosixShellArg(REMOTE_AGENT_CONNECTION_DISCOVERY_PY)}
`.trim();
}

export async function executeSshCommand(rawPayload, normalized, remoteCommand, { timeoutMs = SSH_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  const password = normalizeOptionalSecret(rawPayload?.password);
  const privateKey = normalizeOptionalSecret(rawPayload?.privateKey);
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
      throw new Error('Saved password is not available for SSH fallback');
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
        env: { SSHPASS: password },
        timeoutMs,
        maxOutputBytes,
      },
    );
  }

  if (!privateKey) {
    throw new Error('Saved managed SSH key is not available for SSH fallback');
  }

  return withTemporaryPrivateKey(privateKey, async (keyPath) => runProcess(
    'ssh',
    [
      ...sshBaseArgs,
      '-i', keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      `${normalized.username}@${normalized.host}`,
      remoteCommand,
    ],
    {
      timeoutMs,
      maxOutputBytes,
    },
  ));
}

function extractJsonFromStdout(stdout = '') {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON lines.
    }
  }

  throw new Error('Remote command did not return valid JSON');
}

function shouldAttemptAgentRecovery(error, host) {
  if (!host) {
    return false;
  }

  const hasBootstrapMetadata = Boolean(
    normalizeNonEmptyString(host?.metadata?.bootstrap?.serviceName)
    || normalizeNonEmptyString(host?.metadata?.bootstrap?.installMode),
  );

  if (!hasBootstrapMetadata) {
    return false;
  }

  if (getSshCredentialPlans(host).length === 0) {
    return false;
  }

  const message = normalizeNonEmptyString(error?.message).toLowerCase();
  const code = normalizeNonEmptyString(error?.code).toUpperCase();
  const status = Number(error?.status || 0);

  return (
    code === 'REMOTE_AGENT_UNREACHABLE'
    || code === 'REMOTE_AGENT_TIMEOUT'
    || message.includes('econnrefused')
    || message.includes('timed out')
    || message.includes('timeout')
    || status === 502
    || status === 504
  );
}

async function discoverRemoteAgentConnectionViaPlan(plan, host, {
  timeoutMs = REMOTE_AGENT_RECOVERY_TIMEOUT_MS,
} = {}) {
  const result = await executeSshCommand(
    plan.rawPayload,
    plan.normalized,
    buildRemoteAgentConnectionDiscoveryCommand(host),
    { timeoutMs },
  );

  if (result.exitCode !== 0) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n') || 'Remote agent discovery command failed');
  }

  const parsed = extractJsonFromStdout(result.stdout || '');
  const agentPort = parsePort(parsed?.agentPort, 0);
  const agentUrl = normalizeNonEmptyString(parsed?.agentUrl);

  if (!agentPort || !agentUrl) {
    throw new Error('Remote agent discovery did not return a valid port');
  }

  return {
    agentPort,
    agentUrl,
    agentToken: normalizeOptionalSecret(parsed?.agentToken) || normalizeOptionalSecret(host?.agent_token),
  };
}

export async function discoverRemoteAgentConnectionViaSsh(host, {
  timeoutMs = REMOTE_AGENT_RECOVERY_TIMEOUT_MS,
} = {}) {
  const failures = [];

  for (const plan of getSshCredentialPlans(host)) {
    try {
      return {
        recovered: true,
        via: plan.label,
        ...(await discoverRemoteAgentConnectionViaPlan(plan, host, { timeoutMs })),
      };
    } catch (error) {
      failures.push(`${plan.label}: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(failures.length > 0 ? failures.join(' | ') : 'No SSH recovery transport is available');
}

export async function restartRemoteAgentViaSsh(host, {
  timeoutMs = REMOTE_AGENT_RECOVERY_TIMEOUT_MS,
} = {}) {
  const installMode = normalizeNonEmptyString(host?.metadata?.bootstrap?.installMode) || 'systemd';
  const serviceName = normalizeNonEmptyString(host?.metadata?.bootstrap?.serviceName) || DEFAULT_REMOTE_AGENT_SERVICE_NAME;
  const agentPort = (() => {
    try {
      const agentUrl = normalizeNonEmptyString(host?.agent_url);
      return agentUrl ? parsePort(new URL(agentUrl).port, 0) : 0;
    } catch {
      return 0;
    }
  })();

  const restartCommand = installMode === 'nohup'
    ? `
set -e
agent_dir=${buildRemoteAgentDirShellExpression(host)}
script_path="$agent_dir/remote-agent.py"
token_path="$agent_dir/agent.token"
pid_path="$agent_dir/agent.pid"
log_path="$agent_dir/agent.log"
port=${Number.isFinite(agentPort) && agentPort > 0 ? agentPort : 47100}

if [ -f "$pid_path" ]; then
  existing_pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    kill "$existing_pid" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

nohup python3 "$script_path" --host 0.0.0.0 --port "$port" --token-file "$token_path" >> "$log_path" 2>&1 &
echo $! > "$pid_path"
sleep 2
printf '__REMOTE_AGENT_RESTART__ ok\\n'
`.trim()
    : `
set -e
systemctl restart ${quotePosixShellArg(`${serviceName}.service`)}
systemctl is-active ${quotePosixShellArg(`${serviceName}.service`)} >/dev/null
printf '__REMOTE_AGENT_RESTART__ ok\\n'
`.trim();

  const failures = [];
  for (const plan of getSshCredentialPlans(host)) {
    try {
      const result = await executeSshCommand(plan.rawPayload, plan.normalized, restartCommand, { timeoutMs });
      if (result.exitCode !== 0 || !String(result.stdout || '').includes('__REMOTE_AGENT_RESTART__ ok')) {
        throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n') || 'Remote agent restart command failed');
      }

      try {
        return {
          recovered: true,
          via: plan.label,
          ...(await discoverRemoteAgentConnectionViaPlan(plan, host, { timeoutMs })),
        };
      } catch (error) {
        return {
          recovered: true,
          via: plan.label,
          warning: error.message || 'Remote agent restart succeeded but connection discovery failed',
        };
      }
    } catch (error) {
      failures.push(`${plan.label}: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(failures.length > 0 ? failures.join(' | ') : 'No SSH recovery transport is available');
}

export async function remoteAgentRequestWithRecovery(host, pathname, payload = null, options = {}) {
  const agentRequest = typeof options.agentRequest === 'function' ? options.agentRequest : remoteAgentRequest;
  const restartAgent = typeof options.restartAgent === 'function' ? options.restartAgent : restartRemoteAgentViaSsh;
  try {
    return await agentRequest(host, pathname, payload, options);
  } catch (error) {
    if (!shouldAttemptAgentRecovery(error, host) || options.skipRecovery === true) {
      throw error;
    }

    const recoveryResult = await restartAgent(host, {
      timeoutMs: Number.isFinite(options.recoveryTimeoutMs) ? options.recoveryTimeoutMs : REMOTE_AGENT_RECOVERY_TIMEOUT_MS,
    });

    const recoveredHost = buildRecoveredHostSnapshot(host, recoveryResult);
    const response = await agentRequest(recoveredHost, pathname, payload, {
      ...options,
      skipRecovery: true,
    });

    applyRecoveredHostSnapshot(host, recoveredHost);
    try {
      await persistRecoveredHostSnapshot(host, recoveredHost, options);
    } catch (persistError) {
      console.warn('[Remote Host] Failed to persist recovered agent connection:', persistError?.message || persistError);
    }

    return response;
  }
}

export async function executeRemoteProcessOverSsh(host, processPayload = {}, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : (Number.isFinite(processPayload.timeoutMs) ? processPayload.timeoutMs : SSH_TIMEOUT_MS);
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes)
    ? options.maxOutputBytes
    : (Number.isFinite(processPayload.maxOutputBytes) ? processPayload.maxOutputBytes : 8 * 1024 * 1024);
  const credentialPlans = typeof options.getCredentialPlans === 'function'
    ? options.getCredentialPlans(host)
    : getSshCredentialPlans(host);
  const sshExecutor = typeof options.executeSshCommand === 'function'
    ? options.executeSshCommand
    : executeSshCommand;
  const failures = [];

  for (const plan of credentialPlans) {
    try {
      const result = await sshExecutor(
        plan.rawPayload,
        plan.normalized,
        `python3 -c ${quotePosixShellArg(REMOTE_PROCESS_FALLBACK_PY)} ${quotePosixShellArg(JSON.stringify(processPayload || {}))}`,
        { timeoutMs, maxOutputBytes },
      );
      return extractJsonFromStdout(result.stdout || '');
    } catch (error) {
      failures.push(`${plan.label}: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(failures.length > 0 ? failures.join(' | ') : 'No SSH fallback transport is available');
}

export async function executeRemoteProcessWithFallback(host, processPayload = {}, options = {}) {
  const failures = [];

  try {
    return await remoteAgentRequestWithRecovery(
      host,
      '/process/run',
      processPayload,
      {
        timeoutMs: Number.isFinite(options.agentTimeoutMs)
          ? options.agentTimeoutMs
          : (Number.isFinite(processPayload.timeoutMs) ? processPayload.timeoutMs : SSH_TIMEOUT_MS) + 5000,
        recoveryTimeoutMs: options.recoveryTimeoutMs,
        agentRequest: options.agentRequest,
        restartAgent: options.restartAgent,
      },
    );
  } catch (error) {
    failures.push(`agent: ${error.message || 'unknown error'}`);
  }

  try {
    return await executeRemoteProcessOverSsh(host, processPayload, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      executeSshCommand: options.executeSshCommand,
      getCredentialPlans: options.getCredentialPlans,
    });
  } catch (error) {
    failures.push(`ssh: ${error.message || 'unknown error'}`);
  }

  const combined = failures.join(' | ') || 'Remote process failed';
  throw new RemoteAgentError(
    `Remote process execution failed across the fallback chain: ${combined}`,
    'REMOTE_AGENT_UNREACHABLE',
    502,
  );
}
