#!/usr/bin/env node

import '../server/load-env.js';
import { generateToken } from '../server/middleware/auth.js';
import { credentialsDb, e2bSessionDb, userDb } from '../server/database/db.js';
import {
  abortE2BSession,
  createE2BSession,
  respondE2BPermission,
  sendMessageToE2BSession,
} from '../server/providers/e2b/session-bridge.js';
import {
  ensureSandboxConnected,
  getSandboxClient,
  getSandboxId,
} from '../server/providers/e2b/sandbox-manager.js';

const SERVER_PORT = process.env.SERVER_PORT || '3001';
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const SANDBOX_CONNECT_HOST =
  process.env.E2B_SANDBOX_CONNECT_HOST ||
  process.env.E2B_PUBLIC_HOST ||
  '36.137.180.12';
const DEFAULT_REPO_URL = 'https://github.com/Deng-m1/claudecodeui-e2b.git';
const MAIN_BRANCH = 'main';
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

const user = userDb.getFirstUser();
if (!user) {
  throw new Error('No active user found in auth database');
}

const token = generateToken(user);
const githubToken = credentialsDb.getActiveCredential(user.id, 'github_oauth');
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const branchName = `e2e/e2b-flow-${runId}`;
const docFile = `docs/xxx-helloworld-${runId}.md`;
const repoUrl = process.argv[2] || DEFAULT_REPO_URL;

if (!githubToken) {
  throw new Error('No GitHub OAuth token is configured for the active user');
}

function parseGitHubRepo(input) {
  const normalized = String(input || '').trim().replace(/\.git$/, '');
  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const url = new URL(normalized);
  const [, owner, repo] = url.pathname.split('/');
  if (!owner || !repo) {
    throw new Error(`Could not parse GitHub repo from ${input}`);
  }
  return { owner, repo };
}

const { owner: repoOwner, repo: repoName } = parseGitHubRepo(repoUrl);

function log(step, message) {
  process.stdout.write(`[e2e:${step}] ${message}\n`);
}

function toJsonPreview(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Forwarded-Host': SANDBOX_CONNECT_HOST,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
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
    throw new Error(`HTTP ${response.status} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function githubApi(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
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
    throw new Error(`GitHub API ${response.status} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
    throw new Error(
      `${label} failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return { exitCode, stdout, stderr, result };
}

async function runJsonInSandbox(script, options = {}) {
  const { stdout } = await runInSandbox(script, options);
  try {
    return JSON.parse(stdout.trim() || 'null');
  } catch (error) {
    throw new Error(`Failed to parse JSON from sandbox output: ${stdout}\n${error.message}`);
  }
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

async function createSandboxWithRepo() {
  log('setup', `creating sandbox from ${repoUrl}#${MAIN_BRANCH}`);
  const data = await apiRequest('/api/e2b/sandbox/create-with-repo', {
    method: 'POST',
    body: JSON.stringify({
      repoUrl,
      branch: MAIN_BRANCH,
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
}

function createMessageCollector(sessionId, agent) {
  const seenPermissionIds = new Set();
  const messages = [];
  let lastError = null;

  const onMessage = (msg) => {
    messages.push(msg);

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
  };
}

async function runAgentStep({
  sessionId,
  agent,
  sandboxId,
  workspacePath,
  prompt,
  summary,
}) {
  const collector = createMessageCollector(sessionId, agent);

  e2bSessionDb.upsert(user.id, sessionId, {
    sandboxId,
    agent,
    model: null,
    summary,
    status: 'active',
    metadata: {
      branchName,
      docFile,
      repoUrl,
      workspacePath,
    },
  });

  await createE2BSession(sessionId, {
    agent,
    cwd: workspacePath,
    sandboxId,
    onMessage: collector.onMessage,
  });

  log(agent, `sending prompt for ${summary}`);
  await withTimeout(
    sendMessageToE2BSession(sessionId, prompt, {
      agent,
      cwd: workspacePath,
      sandboxId,
      onMessage: collector.onMessage,
    }),
    AGENT_TIMEOUT_MS,
    `${agent} prompt`,
  );

  const lastError = collector.getLastError();
  if (lastError) {
    throw lastError;
  }

  return collector.messages;
}

async function assertSandboxPrerequisites(workspacePath) {
  const command = [
    'set -euo pipefail',
    `cd ${shellEscape(workspacePath)}`,
    'echo "--- git branch ---"',
    'git branch --show-current',
    'echo "--- git remote ---"',
    'git remote -v',
    'echo "--- tools ---"',
    'command -v gh >/dev/null && gh --version | head -n 1 || echo "gh_missing"',
    'command -v claude >/dev/null && claude --version || echo "claude_shell_missing"',
    'command -v codex >/dev/null && codex --version || echo "codex_shell_missing"',
    'echo "--- auth files ---"',
    '[ -f /home/user/.claude/settings.json ] && echo CLAUDE_SETTINGS_PRESENT || (echo CLAUDE_SETTINGS_MISSING && exit 1)',
    '[ -f /home/user/.codex/auth.json ] && echo CODEX_AUTH_PRESENT || (echo CODEX_AUTH_MISSING && exit 1)',
    'echo "--- token env ---"',
    '[ -n "$GITHUB_TOKEN" ] && echo GITHUB_TOKEN_PRESENT || (echo GITHUB_TOKEN_MISSING && exit 1)',
  ].join(' && ');

  const { stdout } = await runInSandbox(command, {
    label: 'sandbox prerequisite check',
  });

  log('setup', stdout.trim());
}

async function getPullRequestForBranch(workspacePath) {
  const data = await githubApi(
    `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls?head=${encodeURIComponent(`${repoOwner}:${branchName}`)}&state=all&per_page=10`,
  );

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No pull request found for branch ${branchName}`);
  }

  const [pull] = data;
  return {
    number: pull.number,
    url: pull.html_url,
    state: pull.state,
    title: pull.title,
    headRefName: pull.head?.ref,
    baseRefName: pull.base?.ref,
    mergedAt: pull.merged_at,
  };
}

async function verifyBranchAndFile(workspacePath, { expectMerged = false } = {}) {
  const branchInfo = await runInSandbox(
    [
      'set -euo pipefail',
      'git fetch origin --prune',
      `git ls-remote --heads origin ${shellEscape(branchName)}`,
      `git show origin/${shellEscape(branchName).slice(1, -1)}:${shellEscape(docFile).slice(1, -1)}`,
    ].join(' && '),
    {
      cwd: workspacePath,
      label: 'verify remote branch and file',
    },
  );

  log('verify', `remote branch and feature file present\n${branchInfo.stdout.trim()}`);

  if (expectMerged) {
    const mainView = await runInSandbox(
      [
        'set -euo pipefail',
        'git fetch origin --prune',
        'git checkout main',
        'git pull --ff-only origin main',
        `git show origin/main:${shellEscape(docFile).slice(1, -1)}`,
      ].join(' && '),
      {
        cwd: workspacePath,
        label: 'verify merged file on main',
      },
    );

    log('verify', `main branch contains merged file\n${mainView.stdout.trim()}`);
  }
}

async function main() {
  const created = await createSandboxWithRepo();
  const { sandboxId, workspacePath } = created;

  await ensureSandboxClient(sandboxId);
  await assertSandboxPrerequisites(workspacePath);

  const claudeSessionId = `e2e_claude_${runId}`;
  const codexSessionId = `e2e_codex_${runId}`;

  const claudePrompt = [
    `Work only inside the current git repository at ${workspacePath}.`,
    `Use branch ${branchName}.`,
    `Create and switch to the branch if it does not exist.`,
    `Create the markdown file ${docFile}.`,
    'The file must contain:',
    '# xxx-helloworld',
    '- a short intro paragraph',
    '- a section titled "Created by Claude Code in E2B"',
    '- a bullet list that mentions the sandbox test, the current repository, and the feature branch',
    `Commit the file with message: test: create xxx-helloworld via claude`,
    'Push the branch to origin.',
    `Create a pull request into ${MAIN_BRANCH}. Use GitHub CLI if available; otherwise use the GitHub REST API with the GITHUB_TOKEN environment variable.`,
    'Do not merge the pull request yet.',
    'At the end, print a short summary with the branch name, commit SHA, and PR URL.',
  ].join('\n');

  log('claude', `starting on sandbox ${sandboxId}`);
  await runAgentStep({
    sessionId: claudeSessionId,
    agent: 'claude',
    sandboxId,
    workspacePath,
    prompt: claudePrompt,
    summary: 'Claude E2E branch and PR creation',
  });
  process.stdout.write('\n');

  let pr = await getPullRequestForBranch(workspacePath);
  await verifyBranchAndFile(workspacePath);
  log('claude', `PR created: #${pr.number} ${pr.url}`);

  const codexPrompt = [
    `Stay in the same repository at ${workspacePath}.`,
    `Use the existing branch ${branchName}. Do not create a new branch or PR.`,
    `Append a new markdown section titled "Updated by Codex in E2B" to ${docFile}.`,
    'Add a short paragraph explaining that Codex is using the same sandbox and same git branch as Claude Code.',
    `Commit with message: test: extend xxx-helloworld via codex`,
    'Push the same branch to origin.',
    'At the end, print a short summary with the branch name and commit SHA.',
  ].join('\n');

  log('codex', `starting on same sandbox ${sandboxId}`);
  await runAgentStep({
    sessionId: codexSessionId,
    agent: 'codex',
    sandboxId,
    workspacePath,
    prompt: codexPrompt,
    summary: 'Codex E2E update on shared branch',
  });
  process.stdout.write('\n');

  const sharedBranchState = await runInSandbox(
    [
      'set -euo pipefail',
      `git checkout ${shellEscape(branchName)}`,
      'git branch --show-current',
      `git log --oneline --decorate -n 4`,
      `tail -n +1 ${shellEscape(docFile)}`,
    ].join(' && '),
    {
      cwd: workspacePath,
      label: 'verify shared branch state',
    },
  );

  log('codex', `shared branch state\n${sharedBranchState.stdout.trim()}`);

  const mergePrompt = [
    `Merge the existing pull request for branch ${branchName} into ${MAIN_BRANCH}.`,
    'Use GitHub CLI if available; otherwise use the GitHub REST API with the GITHUB_TOKEN environment variable.',
    'Do not delete the branch after merge.',
    `After the merge, check out ${MAIN_BRANCH}, pull the latest origin/${MAIN_BRANCH}, and confirm that ${docFile} exists on ${MAIN_BRANCH}.`,
    'At the end, print a short summary with the PR number, merge status, and current branch.',
  ].join('\n');

  log('claude', 'sending follow-up merge prompt');
  await runAgentStep({
    sessionId: claudeSessionId,
    agent: 'claude',
    sandboxId,
    workspacePath,
    prompt: mergePrompt,
    summary: 'Claude E2E merge follow-up',
  });
  process.stdout.write('\n');

  pr = await getPullRequestForBranch(workspacePath);
  await verifyBranchAndFile(workspacePath, { expectMerged: true });

  const finalCheck = await githubApi(
    `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls/${pr.number}`,
  );

  const sessionRows = {
    claude: e2bSessionDb.getBySessionId(claudeSessionId),
    codex: e2bSessionDb.getBySessionId(codexSessionId),
  };

  log('result', JSON.stringify({
    sandboxId,
    workspacePath,
    branchName,
    docFile,
    pullRequest: {
      number: finalCheck.number,
      url: finalCheck.html_url,
      state: finalCheck.state,
      mergedAt: finalCheck.merged_at,
      title: finalCheck.title,
      headRefName: finalCheck.head?.ref,
      baseRefName: finalCheck.base?.ref,
    },
    sessionRows: Object.fromEntries(
      Object.entries(sessionRows).map(([key, value]) => [
        key,
        value
          ? {
              sandbox_id: value.sandbox_id,
              session_id: value.session_id,
              agent: value.agent,
              status: value.status,
            }
          : null,
      ]),
    ),
  }, null, 2));

  await abortE2BSession(claudeSessionId).catch(() => {});
  await abortE2BSession(codexSessionId).catch(() => {});
}

main().catch(async (error) => {
  log('fatal', error.stack || error.message);
  process.exitCode = 1;
});
