#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../server/load-env.js';
import { generateToken } from '../server/middleware/auth.js';
import { userDb } from '../server/database/db.js';
import { getE2BAuthOverview } from '../server/providers/e2b/auth-sync.js';
import {
  abortE2BSession,
  createE2BSession,
  respondE2BPermission,
  sendMessageToE2BSession,
} from '../server/providers/e2b/session-bridge.js';
import {
  destroySandbox,
  disposeSandbox,
  ensureSandboxConnected,
  getSandboxClient,
  getSandboxId,
  getNativeCliRuntimeStatus,
} from '../server/providers/e2b/sandbox-manager.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const FALLBACK_REPO_URL = 'https://github.com/Deng-m1/claudecodeui-e2b.git';
const DEFAULT_REPO_URL = detectDefaultRepoUrl() || FALLBACK_REPO_URL;
const DEFAULT_BRANCH = process.env.E2B_RUNTIME_SMOKE_BRANCH || 'main';
const DEFAULT_TIMEOUT_MS = parseInteger(
  process.env.E2B_RUNTIME_SMOKE_TIMEOUT_MS,
  15 * 60 * 1000,
);
const DEFAULT_SERVER_PORT = process.env.SERVER_PORT || '3001';
const DEFAULT_CLAUDE_MODEL = process.env.E2B_RUNTIME_SMOKE_CLAUDE_MODEL || 'haiku';
const DEFAULT_CODEX_MODEL = process.env.E2B_RUNTIME_SMOKE_CODEX_MODEL || 'o4-mini';
const SANDBOX_CONNECT_HOST =
  process.env.E2B_SANDBOX_CONNECT_HOST ||
  process.env.E2B_PUBLIC_HOST ||
  '36.137.180.12';

const options = parseArgs(process.argv.slice(2));
const baseUrl = `http://127.0.0.1:${options.serverPort}`;

if (options.help) {
  printHelp();
  process.exit(0);
}

const user = userDb.getFirstUser();
if (!user) {
  throw new Error('No active user found in auth database');
}

const token = generateToken(user);
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const claudeSessionId = `e2b_runtime_smoke_claude_${runId}`;
const codexSessionId = `e2b_runtime_smoke_codex_${runId}`;
const smokeFile = `.tmp/e2b-runtime-smoke-${runId}.txt`;
const claudeSentinel = `SMOKE_CLAUDE_OK:${runId}`;
const codexSentinel = `SMOKE_CODEX_OK:${runId}`;

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/e2b-runtime-smoke.js [repo-url] [options]',
      '',
      'Creates a real E2B sandbox, runs Claude and Codex in the same repo clone,',
      'verifies they can both touch the same workspace file, then cleans up.',
      '',
      'Options:',
      '  --repo <url>            Git repo to clone inside E2B',
      `  --branch <name>         Git branch to clone (default: ${DEFAULT_BRANCH})`,
      `  --server-port <port>    Backend port for /api/e2b (default: ${DEFAULT_SERVER_PORT})`,
      `  --timeout-ms <ms>       Per-agent timeout (default: ${DEFAULT_TIMEOUT_MS})`,
      `  --claude-model <name>   Claude model (default: ${DEFAULT_CLAUDE_MODEL})`,
      `  --codex-model <name>    Codex model (default: ${DEFAULT_CODEX_MODEL})`,
      '  --keep-sandbox          Keep the sandbox alive after the run',
      '  --keep-sessions         Do not abort agent sessions during cleanup',
      '  --json                  Print the final summary as JSON only',
      '  --help                  Show this message',
      '',
      `Default repo: ${DEFAULT_REPO_URL}`,
    ].join('\n'),
  );
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    repoUrl: '',
    branch: DEFAULT_BRANCH,
    serverPort: DEFAULT_SERVER_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    codexModel: DEFAULT_CODEX_MODEL,
    keepSandbox: false,
    keepSessions: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--keep-sandbox') {
      parsed.keepSandbox = true;
      continue;
    }

    if (arg === '--keep-sessions') {
      parsed.keepSessions = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--repo' || arg === '--branch' || arg === '--server-port' || arg === '--timeout-ms' || arg === '--claude-model' || arg === '--codex-model') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === '--repo') parsed.repoUrl = next;
      if (arg === '--branch') parsed.branch = next;
      if (arg === '--server-port') parsed.serverPort = next;
      if (arg === '--timeout-ms') parsed.timeoutMs = parseInteger(next, DEFAULT_TIMEOUT_MS);
      if (arg === '--claude-model') parsed.claudeModel = next;
      if (arg === '--codex-model') parsed.codexModel = next;
      index += 1;
      continue;
    }

    if (arg.startsWith('--repo=')) {
      parsed.repoUrl = arg.slice('--repo='.length);
      continue;
    }

    if (arg.startsWith('--branch=')) {
      parsed.branch = arg.slice('--branch='.length);
      continue;
    }

    if (arg.startsWith('--server-port=')) {
      parsed.serverPort = arg.slice('--server-port='.length);
      continue;
    }

    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = parseInteger(arg.slice('--timeout-ms='.length), DEFAULT_TIMEOUT_MS);
      continue;
    }

    if (arg.startsWith('--claude-model=')) {
      parsed.claudeModel = arg.slice('--claude-model='.length);
      continue;
    }

    if (arg.startsWith('--codex-model=')) {
      parsed.codexModel = arg.slice('--codex-model='.length);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!parsed.repoUrl) {
      parsed.repoUrl = arg;
      continue;
    }

    throw new Error(`Unexpected positional argument: ${arg}`);
  }

  parsed.repoUrl = parsed.repoUrl || DEFAULT_REPO_URL;
  return parsed;
}

function detectDefaultRepoUrl() {
  try {
    const output = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || '';
  } catch {
    return '';
  }
}

function log(step, message) {
  if (options.json) {
    return;
  }

  process.stdout.write(`[runtime-smoke:${step}] ${message}\n`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toJsonPreview(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function apiRequest(pathname, requestOptions = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...requestOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Forwarded-Host': SANDBOX_CONNECT_HOST,
      ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(requestOptions.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${pathname}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    );
  }

  return data;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function summarizeAuthOverview(overview) {
  return {
    claude: {
      authenticated: Boolean(overview?.claude?.authenticated),
      autoAvailable: Boolean(overview?.claude?.auto?.available),
      warnings: overview?.claude?.auto?.warnings || [],
    },
    codex: {
      authenticated: Boolean(overview?.codex?.authenticated),
      autoAvailable: Boolean(overview?.codex?.auto?.available),
      warnings: overview?.codex?.auto?.warnings || [],
    },
  };
}

async function logPreflight() {
  const overview = await getE2BAuthOverview();
  const summary = summarizeAuthOverview(overview);

  for (const provider of ['claude', 'codex']) {
    const state = summary[provider];
    log(
      'preflight',
      `${provider} auto=${state.autoAvailable ? 'yes' : 'no'} auth=${state.authenticated ? 'yes' : 'no'}`,
    );
  }

  if (!summary.claude.autoAvailable) {
    log('preflight', 'warning: Claude auth is not auto-detectable on the host; the runtime smoke may fail.');
  }

  if (!summary.codex.autoAvailable) {
    log('preflight', 'warning: Codex auth is not auto-detectable on the host; the runtime smoke may fail.');
  }

  return summary;
}

async function ensureServerReady() {
  const data = await apiRequest('/api/e2b/status');
  if (!data?.success) {
    throw new Error(`Unexpected /api/e2b/status response: ${toJsonPreview(data)}`);
  }
  return data;
}

async function createSandboxWithRepo() {
  log('setup', `creating sandbox from ${options.repoUrl}#${options.branch}`);
  const data = await apiRequest('/api/e2b/sandbox/create-with-repo', {
    method: 'POST',
    body: JSON.stringify({
      repoUrl: options.repoUrl,
      branch: options.branch,
    }),
  });

  if (!data?.success || !data?.sandboxId || !data?.workspacePath) {
    throw new Error(`Unexpected sandbox create response: ${toJsonPreview(data)}`);
  }

  log('setup', `sandbox created: ${data.sandboxId} workspace=${data.workspacePath}`);
  return data;
}

async function ensureSandboxClient(sandboxId) {
  await ensureSandboxConnected(sandboxId);
  const client = getSandboxClient();

  if (!client || getSandboxId() !== sandboxId) {
    throw new Error(`Failed to connect to sandbox ${sandboxId}`);
  }

  const nativeCli = await getNativeCliRuntimeStatus(client);
  log(
    'native-cli',
    `claude=${nativeCli.providers?.claude?.installed ? nativeCli.providers.claude.version : nativeCli.providers?.claude?.error || 'missing'} codex=${nativeCli.providers?.codex?.installed ? nativeCli.providers.codex.version : nativeCli.providers?.codex?.error || 'missing'}`,
  );

  if (!nativeCli.available) {
    throw new Error(`Sandbox ${sandboxId} is missing native Claude/Codex CLIs: ${toJsonPreview(nativeCli)}`);
  }

  return nativeCli;
}

async function runInSandbox(script, { cwd = null, label = 'cmd', allowFailure = false } = {}) {
  const client = getSandboxClient();
  if (!client) {
    throw new Error('No active sandbox client');
  }

  const fullScript = cwd
    ? `cd ${shellEscape(cwd)} && ${script}`
    : script;

  const result = await client.runProcess({
    command: 'bash',
    args: ['-lc', fullScript],
  });

  const exitCode = Number(result.exitCode ?? result.code ?? 0);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`${label} failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { exitCode, stdout, stderr, result };
}

function createMessageCollector(sessionId, agent) {
  const seenPermissionIds = new Set();
  const messages = [];
  let lastError = null;
  let transcript = '';

  const append = (...parts) => {
    for (const part of parts) {
      if (typeof part === 'string' && part) {
        transcript += `${part}\n`;
      }
    }
  };

  const onMessage = (msg) => {
    messages.push(msg);
    append(msg.content, msg.text, msg.summary);

    if (msg.kind === 'permission_request' && msg.requestId && !seenPermissionIds.has(msg.requestId)) {
      seenPermissionIds.add(msg.requestId);
      log(agent, `approving permission ${msg.requestId} for ${msg.toolName || 'unknown-tool'}`);
      void respondE2BPermission(sessionId, msg.requestId, 'always').catch((error) => {
        lastError = error;
        log(agent, `permission approval failed: ${error.message}`);
      });
      return;
    }

    if (msg.kind === 'stream_delta' && msg.content) {
      process.stdout.write(msg.content);
      return;
    }

    if (msg.kind === 'tool_use') {
      log(agent, `tool ${msg.toolName || 'unknown'} ${toJsonPreview(msg.toolInput || {})}`);
      return;
    }

    if (msg.kind === 'tool_result') {
      const content = String(msg.content || '').trim();
      if (content) {
        log(agent, `tool_result ${toJsonPreview(content)}`);
      }
      return;
    }

    if (msg.kind === 'thinking' && msg.content) {
      log(agent, `thinking ${toJsonPreview(msg.content)}`);
      return;
    }

    if (msg.kind === 'status' && msg.text) {
      log(agent, `status ${toJsonPreview(msg.text)}`);
      return;
    }

    if (msg.kind === 'error') {
      lastError = new Error(msg.content || 'Unknown session error');
      log(agent, `error ${msg.content || 'Unknown session error'}`);
      return;
    }

    if (msg.kind === 'complete') {
      log(agent, 'complete');
    }
  };

  return {
    messages,
    onMessage,
    getLastError: () => lastError,
    getTranscript: () => transcript,
  };
}

async function runAgentStep({
  sessionId,
  agent,
  sandboxId,
  workspacePath,
  prompt,
  summary,
  sentinel,
  model,
}) {
  const collector = createMessageCollector(sessionId, agent);


  await createE2BSession(sessionId, {
    agent,
    cwd: workspacePath,
    model,
    sandboxId,
    onMessage: collector.onMessage,
  });

  log(agent, `sending prompt for ${summary}`);
  await withTimeout(
    sendMessageToE2BSession(sessionId, prompt, {
      agent,
      cwd: workspacePath,
      model,
      sandboxId,
      onMessage: collector.onMessage,
    }),
    options.timeoutMs,
    `${agent} prompt`,
  );

  const lastError = collector.getLastError();
  if (lastError) {
    throw lastError;
  }

  const transcript = collector.getTranscript();
  if (!transcript.includes(sentinel)) {
    throw new Error(`${agent} did not emit sentinel ${sentinel}`);
  }

  return {
    messages: collector.messages,
    transcript,
  };
}

async function readSmokeFile(workspacePath) {
  const { stdout } = await runInSandbox(
    [
      'set -euo pipefail',
      `test -f ${shellEscape(smokeFile)}`,
      `cat ${shellEscape(smokeFile)}`,
    ].join(' && '),
    {
      cwd: workspacePath,
      label: 'read smoke file',
    },
  );

  return stdout.trim();
}

async function cleanupSession(sessionId, sandboxId) {
  if (!sessionId || !sandboxId) {
    return;
  }

  try {
    if (getSandboxId() !== sandboxId) {
      await ensureSandboxConnected(sandboxId);
    }

    const client = getSandboxClient();
    if (!client) {
      return;
    }

    await client.destroySession(sessionId);
    log('cleanup', `destroyed session ${sessionId}`);
  } catch (error) {
    log('cleanup', `failed to destroy ${sessionId}: ${error.message}`);
  }
}

async function cleanupSandbox(sandboxId) {
  if (!sandboxId) {
    return;
  }

  if (options.keepSandbox) {
    log('cleanup', `keeping sandbox ${sandboxId}`);
    try {
      await disposeSandbox();
    } catch {
      return;
    }
    return;
  }

  try {
    await apiRequest('/api/e2b/sandbox/destroy', { method: 'POST' });
    log('cleanup', `destroyed sandbox ${sandboxId} via API`);
  } catch (error) {
    log('cleanup', `API destroy failed, trying direct client fallback: ${error.message}`);

    try {
      if (getSandboxId() !== sandboxId) {
        await ensureSandboxConnected(sandboxId);
      }
      await destroySandbox();
      log('cleanup', `destroyed sandbox ${sandboxId} via direct client`);
    } catch (fallbackError) {
      log('cleanup', `direct sandbox destroy failed: ${fallbackError.message}`);
    }
  }

  try {
    await disposeSandbox();
  } catch {
    return;
  }
}

function buildClaudePrompt(workspacePath, sandboxId) {
  return [
    `Work only inside the git repository at ${workspacePath}.`,
    `Do not commit, push, open a pull request, install packages, or modify tracked files other than ${smokeFile}.`,
    `Create the directory ${path.posix.dirname(smokeFile)} if it does not exist.`,
    `Overwrite ${smokeFile} with exactly these lines:`,
    `run_id=${runId}`,
    'created_by=claude',
    `workspace=${workspacePath}`,
    `sandbox_id=${sandboxId}`,
    `Then print the file contents and finish with the exact line ${claudeSentinel}.`,
  ].join('\n');
}

function buildCodexPrompt(workspacePath) {
  return [
    `Work only inside the same repository at ${workspacePath}.`,
    `Do not commit, push, open a pull request, install packages, or modify tracked files other than ${smokeFile}.`,
    `Append the exact line verified_by=codex to ${smokeFile}.`,
    `Then print the file contents and finish with the exact line ${codexSentinel}.`,
  ].join('\n');
}

let activeSandboxId = null;

async function main() {
  const authSummary = await logPreflight();
  const status = await ensureServerReady();
  log('setup', `backend ready on port ${options.serverPort}; e2b configured=${status.configured ? 'yes' : 'no'}`);

  const created = await createSandboxWithRepo();
  activeSandboxId = created.sandboxId;

  const { sandboxId, workspacePath, authSummary: sandboxAuthSummary } = created;

  const nativeCli = await ensureSandboxClient(sandboxId);
  await runInSandbox('mkdir -p .tmp && git rev-parse --show-toplevel', {
    cwd: workspacePath,
    label: 'workspace preflight',
  });

  log('claude', `starting on sandbox ${sandboxId}`);
  await runAgentStep({
    sessionId: claudeSessionId,
    agent: 'claude',
    sandboxId,
    workspacePath,
    prompt: buildClaudePrompt(workspacePath, sandboxId),
    summary: 'Claude runtime smoke write',
    sentinel: claudeSentinel,
    model: options.claudeModel,
  });
  process.stdout.write('\n');

  const afterClaude = await readSmokeFile(workspacePath);
  if (!afterClaude.includes('created_by=claude')) {
    throw new Error(`Claude did not create the expected smoke file contents:\n${afterClaude}`);
  }

  log('codex', `starting on same sandbox ${sandboxId}`);
  await runAgentStep({
    sessionId: codexSessionId,
    agent: 'codex',
    sandboxId,
    workspacePath,
    prompt: buildCodexPrompt(workspacePath),
    summary: 'Codex runtime smoke append',
    sentinel: codexSentinel,
    model: options.codexModel,
  });
  process.stdout.write('\n');

  const finalSmokeFile = await readSmokeFile(workspacePath);
  if (!finalSmokeFile.includes('created_by=claude') || !finalSmokeFile.includes('verified_by=codex')) {
    throw new Error(`Final smoke file did not include both agent markers:\n${finalSmokeFile}`);
  }

  const result = {
    success: true,
    sandboxId,
    workspacePath,
    repoUrl: options.repoUrl,
    branch: options.branch,
    smokeFile,
    models: {
      claude: options.claudeModel,
      codex: options.codexModel,
    },
    authSummary: sandboxAuthSummary || authSummary,
    nativeCli,
    finalSmokeFile,
    sessions: {
      claudeSessionId,
      codexSessionId,
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    log('result', JSON.stringify(result, null, 2));
  }
}

main()
  .catch((error) => {
    log('fatal', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!options.keepSessions) {
      await cleanupSession(claudeSessionId, activeSandboxId);
      await cleanupSession(codexSessionId, activeSandboxId);
    }

    await cleanupSandbox(activeSandboxId);
  });
