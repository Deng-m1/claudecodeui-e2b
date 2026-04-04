#!/usr/bin/env node

import '../server/load-env.js';
import { e2bSandboxDb } from '../server/database/db.js';
import {
  abortE2BSession,
  createE2BSession,
  respondE2BPermission,
  sendMessageToE2BSession,
} from '../server/providers/e2b/session-bridge.js';
import {
  extractE2BAuthSelectionsFromMetadata,
  resolveE2BAuthBundle,
  syncE2BAuthToSandbox,
} from '../server/providers/e2b/auth-sync.js';
import {
  disposeSandbox,
  ensureSandboxConnected,
  getSandboxClient,
} from '../server/providers/e2b/sandbox-manager.js';

const DEFAULT_SANDBOX_ID = 'e2b/i10kfhhkz8fjg5jikiwph';
const DEFAULT_EMAIL = 'brund768@gmail.com';
const DEFAULT_TIMEOUT_MS = 180000;
const SENTINEL = 'CLOUD_NATIVE_OK';

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    sandboxId: DEFAULT_SANDBOX_ID,
    expectedEmail: DEFAULT_EMAIL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--sandbox-id' || arg === '--expected-email' || arg === '--timeout-ms' || arg === '--model') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === '--sandbox-id') parsed.sandboxId = next;
      if (arg === '--expected-email') parsed.expectedEmail = next;
      if (arg === '--timeout-ms') parsed.timeoutMs = parseInteger(next, DEFAULT_TIMEOUT_MS);
      if (arg === '--model') parsed.model = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--sandbox-id=')) {
      parsed.sandboxId = arg.slice('--sandbox-id='.length);
      continue;
    }
    if (arg.startsWith('--expected-email=')) {
      parsed.expectedEmail = arg.slice('--expected-email='.length);
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = parseInteger(arg.slice('--timeout-ms='.length), DEFAULT_TIMEOUT_MS);
      continue;
    }
    if (arg.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function log(options, step, message) {
  if (options.json) {
    return;
  }
  process.stdout.write(`[claude-e2b-check:${step}] ${message}\n`);
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

async function runInSandbox(script) {
  const client = getSandboxClient();
  if (!client) {
    throw new Error('No active sandbox client');
  }

  const result = await client.runProcess({
    command: 'bash',
    args: ['-lc', script],
  });

  const exitCode = Number(result.exitCode ?? result.code ?? 0);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (exitCode !== 0) {
    throw new Error(`Sandbox command failed (${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { stdout, stderr };
}

function parseChecks(stdout) {
  const checks = {};
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) {
      continue;
    }
    const [key, ...rest] = trimmed.split('=');
    checks[key] = rest.join('=');
  }
  return checks;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionId = `claude_e2b_auth_check_${Date.now()}`;
  const messages = [];
  const seenPermissionIds = new Set();
  let sessionCreated = false;

  const onMessage = (msg) => {
    messages.push({
      kind: msg.kind,
      role: msg.role || '',
      content: msg.content || '',
      text: msg.text || '',
      summary: msg.summary || '',
      requestId: msg.requestId || '',
      toolName: msg.toolName || '',
    });

    if (msg.kind === 'permission_request' && msg.requestId && !seenPermissionIds.has(msg.requestId)) {
      seenPermissionIds.add(msg.requestId);
      void respondE2BPermission(sessionId, msg.requestId, 'always').catch(() => {});
    }
  };

  try {
    log(options, 'setup', `connecting to sandbox ${options.sandboxId}`);
    await withTimeout(
      ensureSandboxConnected(options.sandboxId),
      options.timeoutMs,
      'Connect sandbox',
    );

    const sandboxRecord = e2bSandboxDb.getBySandboxId(options.sandboxId);
    if (!sandboxRecord) {
      throw new Error(`Sandbox record not found in database: ${options.sandboxId}`);
    }

    log(options, 'sync', 'syncing stored E2B auth selections to sandbox');
    const authSelections = extractE2BAuthSelectionsFromMetadata(sandboxRecord.metadata_json);
    const authBundle = await withTimeout(
      resolveE2BAuthBundle(authSelections, {
        strict: false,
        userId: sandboxRecord.user_id || null,
        refreshClaudeProfiles: false,
      }),
      options.timeoutMs,
      'Resolve sandbox auth bundle',
    );

    await withTimeout(
      syncE2BAuthToSandbox(getSandboxClient(), authBundle),
      options.timeoutMs,
      'Sync sandbox auth bundle',
    );

    log(options, 'inspect', 'checking sandbox Claude auth files and env');
    const inspectResult = await withTimeout(
      runInSandbox(
        [
          'set -e',
          '[ -f /home/user/.claude/.credentials.json ] && echo FILE_EXISTS=yes || echo FILE_EXISTS=no',
          `grep -q '\"accessToken\": \"' /home/user/.claude/.credentials.json && echo ACCESS_TOKEN_PRESENT=yes || echo ACCESS_TOKEN_PRESENT=no`,
          `grep -q '\"refreshToken\": \"' /home/user/.claude/.credentials.json && echo REFRESH_TOKEN_PRESENT=yes || echo REFRESH_TOKEN_PRESENT=no`,
          `grep -q '\"claudeAiOauth\"' /home/user/.claude/.credentials.json && echo CLAUDE_OAUTH_PRESENT=yes || echo CLAUDE_OAUTH_PRESENT=no`,
          'grep -q \"\\\"scopes\\\"\" /home/user/.claude/.credentials.json && echo SCOPES_PRESENT=yes || echo SCOPES_PRESENT=no',
        ].join(' && '),
      ),
      options.timeoutMs,
      'Inspect sandbox auth',
    );

    const checks = parseChecks(inspectResult.stdout);
    const failedChecks = Object.entries(checks)
      .filter(([, value]) => value !== 'yes')
      .map(([key]) => key);

    if (failedChecks.length > 0) {
      throw new Error(`Sandbox auth sync check failed: ${failedChecks.join(', ')}`);
    }

    log(options, 'session', 'creating Claude E2B session');
    await withTimeout(
      createE2BSession(sessionId, {
        agent: 'claude',
        sandboxId: options.sandboxId,
        ...(options.model ? { model: options.model } : {}),
        onMessage,
      }),
      options.timeoutMs,
      'Create Claude E2B session',
    );
    sessionCreated = true;

    log(options, 'session', 'sending minimal Claude prompt');
    await withTimeout(
      sendMessageToE2BSession(
        sessionId,
        `Reply with exactly ${SENTINEL} and nothing else.`,
        {
          agent: 'claude',
          sandboxId: options.sandboxId,
          ...(options.model ? { model: options.model } : {}),
          onMessage,
        },
      ),
      options.timeoutMs,
      'Claude prompt',
    );

    const transcript = messages
      .flatMap((msg) => [msg.content, msg.text, msg.summary])
      .filter(Boolean)
      .join('\n');
    const assistantText = messages
      .filter((msg) => msg.kind === 'text' && msg.role === 'assistant')
      .map((msg) => msg.content || '')
      .join('\n')
      .trim();

    const success = assistantText === SENTINEL;
    if (!success) {
      throw new Error(
        `Claude E2B session did not return sentinel. Assistant text:\n${assistantText || '(empty)'}\n\nTranscript:\n${transcript || '(empty)'}`,
      );
    }

    const result = {
      success: true,
      sandboxId: options.sandboxId,
      expectedEmail: options.expectedEmail,
      checks,
      sentinel: SENTINEL,
      assistantText,
      transcriptPreview: transcript.slice(0, 1000),
      messageKinds: messages.map((msg) => msg.kind),
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      log(options, 'result', `Claude auth works in E2B for ${options.expectedEmail}`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } finally {
    if (sessionCreated) {
      try {
        await abortE2BSession(sessionId);
      } catch {
        // Ignore cleanup failures in a one-off verification script.
      }
    }

    try {
      await disposeSandbox();
    } catch {
      // Ignore cleanup failures in a one-off verification script.
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
