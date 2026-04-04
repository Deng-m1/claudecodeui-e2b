/**
 * E2B Session Bridge
 *
 * Bridges sandbox-agent sessions with claudecodeui's WebSocket streaming.
 * Manages creating sessions inside E2B sandboxes, streaming events to
 * connected WebSocket clients, and handling tool approval/permission flows.
 *
 * @module providers/e2b/session-bridge
 */

import {
  getSandboxClient,
  createSandbox,
  ensureSandboxConnected,
  getSandboxId,
  setupGitCredentials,
  invalidateSandboxConnection,
} from './sandbox-manager.js';
import { buildE2BPermissionContext, normalizeE2BToolCall, normalizeEvent } from './adapter.js';
import { NativeClaudeE2BRunner } from './native-claude-runner.js';
import { createNormalizedMessage } from '../types.js';
import { e2bSandboxDb, e2bSessionDb, e2bSessionMessagesDb, credentialsDb, userDb, userClaudeSettingsDb } from '../../database/db.js';
import {
  applyClaudePermissionSettingsToBundle,
  extractE2BAuthSelectionsFromMetadata,
  resolveE2BAuthBundle,
  syncClaudeProfileFromSandbox,
  syncE2BAuthToSandbox,
} from './auth-sync.js';
import { resolveSandboxConnectHostFromRequest } from './connect-host.js';
import { resolveE2BAgentProvider } from './project-utils.js';
import { getAcpTransportErrorDetails, isRecoverableAcpTransportError } from '../../lib/acp-transport-errors.js';

/** @type {Map<string, { session: any, unsubEvent: Function, unsubPerm: Function, agent: string, sandboxId: string | null, emit: Function, emittedCount: number, meaningfulOutputCount: number, completionCount: number, activeRequests: number }>} */
const activeBridgedSessions = new Map();

const PERSISTED_MESSAGE_KINDS = new Set([
  'text',
  'stream_delta',
  'tool_use',
  'tool_result',
  'thinking',
  'error',
  'interactive_prompt',
  'task_notification',
]);

function parseJsonRecord(value) {
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

function createBridgeState({ session = null, agentId, sandboxId, ws, onMessage, runtime = 'acp' }) {
  return {
    runtime,
    session,
    unsubEvent: null,
    unsubPerm: null,
    agent: agentId,
    sandboxId: sandboxId || null,
    emit: (msg) => {
      if (onMessage) {
        onMessage(msg);
        return;
      }
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    },
    emittedCount: 0,
    meaningfulOutputCount: 0,
    completionCount: 0,
    activeRequests: 0,
  };
}

function emitBridgeMessage(bridgeState, msg, options = {}) {
  if (!bridgeState || !msg) {
    return;
  }

  bridgeState.emittedCount += 1;
  if (msg.kind !== 'complete') {
    bridgeState.meaningfulOutputCount += 1;
  } else {
    bridgeState.completionCount += 1;
  }

  if (options.persist !== false) {
    persistBridgeMessage(msg);
  }

  bridgeState.emit?.(msg);
}

function isNativeClaudeBridgeState(bridged) {
  return bridged?.runtime === 'claude-native' && bridged?.nativeRunner;
}

function getSessionMetadata(sessionOrSessionId) {
  const record = typeof sessionOrSessionId === 'string'
    ? e2bSessionDb.getBySessionId(sessionOrSessionId)
    : sessionOrSessionId;
  return parseJsonRecord(record?.metadata_json) || {};
}

function updateSessionMetadata(sessionId, updater) {
  const record = e2bSessionDb.getBySessionId(sessionId);
  if (!record) {
    return null;
  }

  const current = getSessionMetadata(record);
  const next = typeof updater === 'function'
    ? updater(current)
    : {
        ...current,
        ...(updater && typeof updater === 'object' ? updater : {}),
      };

  e2bSessionDb.touch(sessionId, { metadata: next });
  return next;
}

async function syncSelectedClaudeProfileFromSandbox(sandboxId, client = null) {
  if (!sandboxId) {
    return { synced: false, reason: 'missing_sandbox_id' };
  }

  const sandboxRecord = e2bSandboxDb.getBySandboxId(sandboxId);
  if (!sandboxRecord?.user_id) {
    return { synced: false, reason: 'sandbox_unavailable' };
  }

  const authSelections = extractE2BAuthSelectionsFromMetadata(sandboxRecord.metadata_json);
  const claudeSelection = authSelections?.claude;
  if (claudeSelection?.mode !== 'profile' || !claudeSelection.profileId) {
    return { synced: false, reason: 'claude_not_profile_bound' };
  }

  const activeClient = client || (await ensureSandboxConnected(sandboxId));
  if (!activeClient) {
    return { synced: false, reason: 'sandbox_client_unavailable' };
  }

  return syncClaudeProfileFromSandbox(activeClient, {
    userId: sandboxRecord.user_id,
    profileId: claudeSelection.profileId,
    sandboxId,
  });
}

function applyStoredClaudePermissionSettings(bundle, userId) {
  if (!userId) {
    return bundle;
  }

  return applyClaudePermissionSettingsToBundle(bundle, userClaudeSettingsDb.getSettings(userId));
}

async function resolveSandboxAuthBundle(sandboxRecord, options = {}) {
  if (!sandboxRecord) {
    return null;
  }

  const sandboxMetadata = parseJsonRecord(sandboxRecord.metadata_json) || {};
  const authSelections = extractE2BAuthSelectionsFromMetadata(sandboxRecord.metadata_json);
  const sandboxConnectHost =
    typeof options.sandboxConnectHost === 'string' && options.sandboxConnectHost.trim()
      ? options.sandboxConnectHost.trim()
      : resolveSandboxConnectHostFromRequest(null, sandboxRecord);

  let authBundle = await resolveE2BAuthBundle(authSelections, {
    strict: false,
    userId: sandboxRecord.user_id || null,
    sandboxConnectHost:
      sandboxConnectHost ||
      (typeof sandboxMetadata.sandboxConnectHost === 'string' ? sandboxMetadata.sandboxConnectHost : ''),
    refreshClaudeProfiles: false,
  });

  authBundle = applyStoredClaudePermissionSettings(authBundle, sandboxRecord.user_id || null);

  return { authBundle, authSelections, sandboxMetadata, sandboxConnectHost };
}

async function syncSandboxAuthState(client, sandboxRecord, options = {}) {
  if (!client || !sandboxRecord?.sandbox_id) {
    return { synced: false, reason: 'missing_context' };
  }

  const resolved = await resolveSandboxAuthBundle(sandboxRecord, options);
  if (!resolved) {
    return { synced: false, reason: 'missing_bundle' };
  }

  let { authBundle, authSelections, sandboxMetadata, sandboxConnectHost } = resolved;

  const wroteBackClaudeProfile = await syncSelectedClaudeProfileFromSandbox(sandboxRecord.sandbox_id, client).catch((syncError) => {
    console.warn('[E2B Bridge] Failed to sync Claude auth back from sandbox ' + sandboxRecord.sandbox_id + ':', syncError?.message || syncError);
    return { synced: false, reason: 'writeback_failed' };
  });

  if (wroteBackClaudeProfile?.synced) {
    authBundle = await resolveE2BAuthBundle(authSelections, {
      strict: false,
      userId: sandboxRecord.user_id || null,
      sandboxConnectHost:
        sandboxConnectHost ||
        (typeof sandboxMetadata?.sandboxConnectHost === 'string' ? sandboxMetadata.sandboxConnectHost : ''),
      refreshClaudeProfiles: false,
    });
    authBundle = applyStoredClaudePermissionSettings(authBundle, sandboxRecord.user_id || null);
  }

  await syncE2BAuthToSandbox(client, authBundle);

  if (sandboxRecord.user_id) {
    const gitConfig = userDb.getGitConfig(sandboxRecord.user_id);
    if (gitConfig?.git_name || gitConfig?.git_email) {
      await setupGitCredentials(client, {
        gitName: gitConfig.git_name || undefined,
        gitEmail: gitConfig.git_email || undefined,
      });
    }
  }

  return { synced: true, authBundle };
}

async function resolveNativeClaudeProcessEnv(sandboxId, sandboxConnectHost = '') {
  if (!sandboxId) {
    return {};
  }

  const sandboxRecord = e2bSandboxDb.getBySandboxId(sandboxId);
  if (!sandboxRecord) {
    return {};
  }

  const resolved = await resolveSandboxAuthBundle(sandboxRecord, { sandboxConnectHost });
  const authBundle = resolved?.authBundle || { files: [], envs: {} };
  const hasClaudeCredentialsFile = (authBundle.files || []).some((file) => file?.targetPath?.endsWith('/.claude/.credentials.json'));
  const hasClaudeBaseUrl =
    typeof authBundle.envs?.ANTHROPIC_BASE_URL === 'string' && authBundle.envs.ANTHROPIC_BASE_URL.trim();

  if (hasClaudeCredentialsFile && !hasClaudeBaseUrl) {
    return {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
    };
  }

  return {};
}

const DEFAULT_CODEX_FEATURE_TOGGLES = {
  multiAgent: true,
  parallelFanOut: true,
  reasoningSummaries: true,
  shellTool: true,
  webSearch: true,
  networkAccess: true,
};

const CODEX_CONFIG_OPTION_CANDIDATES = {
  multiAgent: ['multi_agent', 'multi agent', 'child_agents', 'child agents', 'sub_agent', 'sub agent'],
  parallelFanOut: ['enable_fanout', 'fanout', 'parallel_fanout', 'parallel fan out'],
  shellTool: ['shell_tool', 'shell tool', 'shell', 'commands', 'terminal'],
  webSearch: ['web_search', 'web search', 'search the web', 'internet search'],
  networkAccess: ['network_access', 'network access', 'internet', 'sandbox_workspace_write.network_access'],
};

const ENABLED_SELECT_VALUE_CANDIDATES = [
  'true',
  'enabled',
  'enable',
  'on',
  'yes',
  'allow',
  'allowed',
  'live',
  'auto',
];

const DISABLED_SELECT_VALUE_CANDIDATES = [
  'false',
  'disabled',
  'disable',
  'off',
  'no',
  'deny',
  'blocked',
  'none',
  'never',
];

function normalizeCodexFeatureToggles(featureToggles = {}) {
  return {
    multiAgent: featureToggles.multiAgent !== false,
    parallelFanOut: featureToggles.parallelFanOut !== false,
    reasoningSummaries: featureToggles.reasoningSummaries !== false,
    shellTool: featureToggles.shellTool !== false,
    webSearch: featureToggles.webSearch !== false,
    networkAccess: featureToggles.networkAccess !== false,
  };
}

function normalizeConfigMatchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactConfigMatchValue(value) {
  return normalizeConfigMatchValue(value).replace(/\s+/g, '');
}

function collectConfigMatchFields(option) {
  return [
    option?.id,
    option?.name,
    option?.category,
  ].filter((value) => typeof value === 'string' && value.trim());
}

function scoreCandidateMatch(fields, candidates = []) {
  const normalizedFields = fields.map((value) => normalizeConfigMatchValue(value)).filter(Boolean);
  const compactFields = fields.map((value) => compactConfigMatchValue(value)).filter(Boolean);
  let bestScore = 0;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeConfigMatchValue(candidate);
    const compactCandidate = compactConfigMatchValue(candidate);
    if (!normalizedCandidate || !compactCandidate) {
      continue;
    }

    if (normalizedFields.some((value) => value === normalizedCandidate) || compactFields.some((value) => value === compactCandidate)) {
      bestScore = Math.max(bestScore, 4);
      continue;
    }

    if (normalizedFields.some((value) => value.includes(normalizedCandidate)) || compactFields.some((value) => value.includes(compactCandidate))) {
      bestScore = Math.max(bestScore, 3);
      continue;
    }

    if (normalizedCandidate.includes(' ') && compactFields.some((value) => compactCandidate.includes(value))) {
      bestScore = Math.max(bestScore, 1);
    }
  }

  return bestScore;
}

function findBestConfigOption(options, candidates) {
  let bestMatch = null;
  let bestScore = 0;

  for (const option of Array.isArray(options) ? options : []) {
    const score = scoreCandidateMatch(collectConfigMatchFields(option), candidates);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = option;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function flattenSelectOptions(options = []) {
  const flattened = [];

  for (const option of Array.isArray(options) ? options : []) {
    if (!option || typeof option !== 'object') {
      continue;
    }

    if ('value' in option && typeof option.value === 'string') {
      flattened.push(option);
      continue;
    }

    if (Array.isArray(option.options)) {
      flattened.push(...flattenSelectOptions(option.options));
    }
  }

  return flattened;
}

function findSelectValue(options, enabled) {
  const candidates = enabled ? ENABLED_SELECT_VALUE_CANDIDATES : DISABLED_SELECT_VALUE_CANDIDATES;
  const flattened = flattenSelectOptions(options);
  let bestMatch = null;
  let bestScore = 0;

  for (const option of flattened) {
    const score = scoreCandidateMatch([option?.value, option?.name, option?.description], candidates);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = option;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

async function applyCodexFeatureTogglesToSession(session, featureToggles = DEFAULT_CODEX_FEATURE_TOGGLES) {
  if (!session || resolveE2BAgentProvider(session.agent || '') !== 'codex') {
    return;
  }

  const resolvedFeatureToggles = normalizeCodexFeatureToggles(featureToggles);
  const targetThoughtLevel = resolvedFeatureToggles.reasoningSummaries ? 'medium' : 'minimal';

  try {
    await session.setThoughtLevel(targetThoughtLevel);
  } catch (error) {
    console.warn(
      `[E2B Bridge] Could not set Codex thought level to ${targetThoughtLevel}:`,
      error?.message || error,
    );
  }

  let configOptions = [];
  try {
    configOptions = await session.getConfigOptions();
  } catch (error) {
    console.warn('[E2B Bridge] Could not read Codex session config options:', error?.message || error);
    return;
  }

  for (const [toggleKey, candidates] of Object.entries(CODEX_CONFIG_OPTION_CANDIDATES)) {
    const option = findBestConfigOption(configOptions, candidates);
    if (!option) {
      continue;
    }

    const nextValue = resolvedFeatureToggles[toggleKey];
    if (option.type === 'boolean') {
      if (option.currentValue === nextValue) {
        continue;
      }
      try {
        await session.setConfigOption(option.id, String(nextValue));
      } catch (error) {
        console.warn(
          `[E2B Bridge] Could not set Codex config option ${option.id}=${nextValue}:`,
          error?.message || error,
        );
      }
      continue;
    }

    if (option.type === 'select') {
      const selectedValue = findSelectValue(option.options, nextValue);
      if (!selectedValue || option.currentValue === selectedValue.value) {
        continue;
      }
      try {
        await session.setConfigOption(option.id, selectedValue.value);
      } catch (error) {
        console.warn(
          `[E2B Bridge] Could not set Codex config option ${option.id}=${selectedValue.value}:`,
          error?.message || error,
        );
      }
    }
  }
}

export function summarizeE2BBridgeError(error, context = {}) {
  const baseMessage = error instanceof Error ? error.message : String(error || 'E2B bridge error');
  const errorData = error && typeof error === 'object' && typeof error.data === 'object' ? error.data : null;
  const detailedMessage =
    typeof errorData?.message === 'string' && errorData.message.trim()
      ? errorData.message.trim()
      : '';
  const agentStderr =
    typeof errorData?.agentStderr === 'string' && errorData.agentStderr.trim()
      ? errorData.agentStderr
      : '';
  const agent = String(context.agent || '').toLowerCase();
  const details = `${baseMessage}\n${detailedMessage}\n${agentStderr}\n${getAcpTransportErrorDetails(error)}`;
  const hints = [];

  if (agent.includes('codex') || /codex/i.test(details)) {
    if (/refresh_token_reused/i.test(details)) {
      hints.push('Codex auth in the sandbox is using a reused refresh token. Re-sync Codex auth with an API key or a dedicated cloud profile.');
    }

    if (/127\.0\.0\.1:8317|localhost:8317/i.test(details)) {
      hints.push('Codex config in the sandbox still points to a loopback proxy URL. Set a sandbox connect host and re-sync E2B auth.');
    }

    if (/Authentication required/i.test(details)) {
      hints.push('Codex authentication is not configured correctly inside the sandbox.');
    }
  }

  if (/headers timeout error|und_err_headers_timeout/i.test(details)) {
    hints.push('The E2B ACP bridge timed out waiting for the sandbox to acknowledge the request. Retry once the sandbox connection is healthy.');
  }

  if (/sandbox was not found|sandbox not found/i.test(details)) {
    hints.push('The E2B sandbox is gone. Reconnect the sandbox or start a new cloud session before retrying.');
  }

  if (hints.length > 0) {
    return `${hints.join(' ')}${detailedMessage ? ` (${detailedMessage})` : ''}`;
  }

  return detailedMessage || baseMessage;
}

function withReadableE2BError(error, context = {}) {
  const message = summarizeE2BBridgeError(error, context);
  if (error instanceof Error) {
    error.message = message;
    return error;
  }

  return new Error(message);
}

function isAuthenticationRequiredError(error) {
  const message = String(error?.message || error || '');
  return /authentication required/i.test(message);
}

async function ensureCodexLiveAuthenticated(client) {
  if (!client || typeof client.getLiveConnection !== 'function') {
    return false;
  }

  let live = null;
  try {
    live = await client.getLiveConnection('codex');
  } catch (error) {
    console.warn('[E2B Bridge] Could not open Codex live connection for manual auth:', error?.message || error);
    return false;
  }

  const methodIds = ['openai-api-key', 'codex-api-key', 'chatgpt'];
  const failures = [];

  for (const methodId of methodIds) {
    try {
      await live.acp.authenticate({ methodId });
      return true;
    } catch (error) {
      failures.push(`${methodId}: ${error?.message || error}`);
    }
  }

  if (failures.length > 0) {
    console.warn('[E2B Bridge] Codex manual auth attempts failed:', failures.join(' | '));
  }

  return false;
}

/**
 * Ensure the sandbox is ready before creating sessions.
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
async function ensureSandbox(sandboxId = null, options = {}) {
  let client = null;

  if (sandboxId) {
    const sandboxRecord = e2bSandboxDb.getBySandboxId(sandboxId);
    const resolved = await resolveSandboxAuthBundle(sandboxRecord, options);
    const authBundle = resolved?.authBundle || { envs: {} };
    const envs = { ...(authBundle.envs || {}) };
    const githubToken = sandboxRecord?.user_id
      ? credentialsDb.getActiveCredential(sandboxRecord.user_id, 'github_oauth')
      : null;

    if (githubToken) {
      envs.GITHUB_TOKEN = githubToken;
    }

    client = await ensureSandboxConnected(sandboxId, envs);
    if (client && sandboxRecord) {
      await syncSandboxAuthState(client, sandboxRecord, options);
    }
  } else {
    client = getSandboxClient();
  }

  if (!client) {
    client = await createSandbox();
  }

  return client;
}

function disposeBridge(sessionId) {
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged) {
    return;
  }

  try {
    bridged.unsubEvent?.();
  } catch {
    // Ignore subscription cleanup failures.
  }

  try {
    bridged.unsubPerm?.();
  } catch {
    // Ignore subscription cleanup failures.
  }

  try {
    bridged.close?.();
  } catch {
    // Ignore terminal cleanup failures.
  }

  activeBridgedSessions.delete(sessionId);
}

function shouldPersistMessage(msg) {
  if (!msg?.sessionId || !msg?.id || !PERSISTED_MESSAGE_KINDS.has(msg.kind)) {
    return false;
  }

  // Persist the outbound prompt eagerly at send-time so refresh/reconnect does
  // not depend on sandbox-agent echoing a user chunk back first.
  if (msg.kind === 'text' && msg.role === 'user') {
    return false;
  }

  return true;
}

function persistBridgeMessage(msg) {
  if (!shouldPersistMessage(msg)) {
    return;
  }

  try {
    e2bSessionMessagesDb.append(msg.sessionId, msg);
  } catch (error) {
    console.warn('[E2B Bridge] Failed to persist message:', error?.message || error);
  }
}

function safeUpdateSessionStatus(sessionId, status) {
  try {
    e2bSessionDb.updateStatus(sessionId, status);
  } catch (error) {
    console.warn('[E2B Bridge] Failed to update session status:', error?.message || error);
  }
}

function updateBridgeActivity(sessionId, isStarting, terminalStatus = null) {
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged) {
    return;
  }

  if (isStarting) {
    bridged.activeRequests += 1;
    safeUpdateSessionStatus(sessionId, 'active');
    return;
  }

  bridged.activeRequests = Math.max(0, bridged.activeRequests - 1);
  safeUpdateSessionStatus(sessionId, terminalStatus || (bridged.activeRequests > 0 ? 'active' : 'idle'));
}

function persistPromptMessage(sessionId, agent, message) {
  const content = typeof message === 'string' ? message.trim() : '';
  if (!sessionId || !content) {
    return;
  }

  try {
    e2bSessionMessagesDb.append(
      sessionId,
      createNormalizedMessage({
        id: `e2b_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        provider: resolveE2BAgentProvider(agent || 'claude'),
        kind: 'text',
        role: 'user',
        content,
      }),
    );
  } catch (error) {
    console.warn('[E2B Bridge] Failed to persist prompt message:', error?.message || error);
  }
}

export function reconnectE2BSessionWriter(sessionId, ws) {
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged || !ws) {
    return false;
  }

  bridged.emit = (msg) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  };

  return true;
}

function buildSilentPromptError(agent, response = null) {
  const provider = resolveE2BAgentProvider(agent || 'claude');
  const providerLabel = provider === 'codex'
    ? 'Codex'
    : provider === 'cursor'
      ? 'Cursor'
      : provider === 'gemini'
        ? 'Gemini'
        : 'Claude';
  const stopReason =
    response && typeof response === 'object' && typeof response.stopReason === 'string' && response.stopReason.trim()
      ? response.stopReason.trim()
      : '';

  return `${providerLabel} in E2B completed without emitting any session output${stopReason ? ` (stopReason=${stopReason})` : ''}. This usually indicates a sandbox-agent or provider runtime issue inside the cloud sandbox.`;
}

function emitSyntheticComplete(bridged, sessionId, provider) {
  if (!bridged || !sessionId) {
    return;
  }

  const completeMsg = createNormalizedMessage({
    id: `e2b_complete_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    provider,
    kind: 'complete',
    exitCode: 0,
    success: true,
  });

  bridged.completionCount += 1;
  bridged.emit?.(completeMsg);
}

function attachBridge(sessionId, session, { agentId, sandboxId, ws, onMessage }) {
  disposeBridge(sessionId);

  const bridgeState = createBridgeState({
    session,
    agentId,
    sandboxId,
    ws,
    onMessage,
    runtime: 'acp',
  });

  const unsubEvent = session.onEvent((event) => {
    const normalized = normalizeEvent(event, sessionId, agentId);
    for (const msg of normalized) {
      emitBridgeMessage(bridgeState, msg);
    }
  });

  const unsubPerm = session.onPermissionRequest((request) => {
    const normalizedTool = normalizeE2BToolCall(request.toolCall, request.id);
    const permMsg = createNormalizedMessage({
      sessionId,
      provider: 'e2b',
      kind: 'permission_request',
      requestId: request.id,
      toolName: normalizedTool.toolName,
      input: normalizedTool.toolInput,
      context: buildE2BPermissionContext(request),
    });

    emitBridgeMessage(bridgeState, permMsg, { persist: false });
  });

  bridgeState.unsubEvent = unsubEvent;
  bridgeState.unsubPerm = unsubPerm;

  activeBridgedSessions.set(sessionId, bridgeState);
}

async function createNativeClaudeSession(sessionId, options) {
  const {
    agent,
    cwd,
    model,
    sandboxId,
    ws,
    onMessage,
    sandboxConnectHost = '',
  } = options;
  const client = await ensureSandbox(sandboxId, { sandboxConnectHost });
  const resolvedSandboxId = sandboxId || getSandboxId() || null;
  const sessionRecord = e2bSessionDb.getBySessionId(sessionId);
  const metadata = getSessionMetadata(sessionRecord);
  const processEnv = await resolveNativeClaudeProcessEnv(resolvedSandboxId, sandboxConnectHost);
  const bridgeState = createBridgeState({
    agentId: agent || 'claude',
    sandboxId: resolvedSandboxId,
    ws,
    onMessage,
    runtime: 'claude-native',
  });

  const runner = new NativeClaudeE2BRunner({
    client,
    sessionId,
    sandboxId: resolvedSandboxId,
    cwd,
    model,
    processEnv,
    emitMessage: (msg) => emitBridgeMessage(bridgeState, msg),
    onMetadataChange: (patch) => {
      updateSessionMetadata(sessionId, (current) => ({
        ...current,
        runtime: 'claude-native',
        ...(patch && typeof patch === 'object' ? patch : {}),
      }));
    },
    onTerminated: (error, status = null) => {
      if (activeBridgedSessions.get(sessionId) !== bridgeState) {
        return;
      }

      void syncSelectedClaudeProfileFromSandbox(resolvedSandboxId, client).catch((syncError) => {
        console.warn(`[E2B Bridge] Failed to write back Claude sandbox auth for ${resolvedSandboxId || 'unknown'}:`, syncError?.message || syncError);
      });

      activeBridgedSessions.delete(sessionId);
      updateSessionMetadata(sessionId, (current) => ({
        ...current,
        runtime: 'claude-native',
        pendingPermissions: [],
      }));

      const exitCode = Number.isFinite(status?.exitCode) ? status.exitCode : null;
      if (exitCode !== 0 || bridgeState.activeRequests > 0) {
        emitBridgeMessage(
          bridgeState,
          createNormalizedMessage({
            id: `claude_native_exit_${Date.now()}`,
            sessionId,
            provider: 'claude',
            kind: 'error',
            content: error?.message || 'Claude Code process stopped unexpectedly inside E2B.',
          }),
        );
      }

      safeUpdateSessionStatus(sessionId, exitCode === 0 ? 'ended' : 'error');
    },
  });

  const startResult = await runner.start({
    processId: metadata.processId,
    metadata,
  });

  bridgeState.nativeRunner = runner;
  bridgeState.processId = startResult.processId;
  bridgeState.close = () => {
    void runner.close();
  };
  bridgeState.abort = () => runner.abort();
  bridgeState.sendPrompt = (message) => runner.sendPrompt(message);
  bridgeState.respondPermission = (permissionId, reply) => runner.respondPermission(permissionId, reply);

  activeBridgedSessions.set(sessionId, bridgeState);

  updateSessionMetadata(sessionId, (current) => ({
    ...current,
    runtime: 'claude-native',
    processId: startResult.processId || current.processId || null,
    nativeClaudeSessionId: startResult.nativeSessionId || current.nativeClaudeSessionId || null,
    pendingPermissions: startResult.pendingPermissions || current.pendingPermissions || [],
  }));

  return {
    sessionId,
    sandboxSessionId: sessionId,
    agentSessionId: startResult.nativeSessionId || startResult.processId || sessionId,
    processId: startResult.processId,
    nativeSessionId: startResult.nativeSessionId || null,
    runtime: 'claude-native',
    created: startResult.created,
  };
}

/**
 * Start a new agent session inside the E2B sandbox and bridge events to WebSocket.
 *
 * @param {string} sessionId - claudecodeui session ID
 * @param {object} options
 * @param {string} options.agent - Agent to use ('claude' | 'codex' | 'opencode' | 'cursor' | 'amp')
 * @param {string} [options.cwd] - Working directory inside the sandbox
 * @param {string} [options.model] - Model override
 * @param {boolean} [options.resume] - Whether to prefer resuming an existing session
 * @param {string} [options.sandboxId] - Target sandbox ID
 * @param {object} [options.featureToggles] - Codex session feature toggles
 * @param {WebSocket} [options.ws] - WebSocket to stream events to
 * @param {Function} [options.onMessage] - Callback for each NormalizedMessage
 * @returns {Promise<{ sessionId: string, sandboxSessionId: string, agentSessionId: string, created: boolean }>}
 */
export async function createE2BSession(sessionId, options) {
  const {
    agent,
    cwd,
    model,
    sandboxId,
    featureToggles = DEFAULT_CODEX_FEATURE_TOGGLES,
    ws,
    onMessage,
    resume = false,
    sandboxConnectHost = '',
  } = options;
  const agentId = mapProviderToAgent(agent);

  if (resolveE2BAgentProvider(agentId) === 'claude') {
    console.log(
      `[E2B Bridge] Ensuring native Claude session: ${sessionId}, sandbox: ${sandboxId || getSandboxId() || 'active'}`,
    );
    return createNativeClaudeSession(sessionId, {
      ...options,
      agent: agentId,
    });
  }

  const client = await ensureSandbox(sandboxId, { sandboxConnectHost });
  const resolvedSandboxId = sandboxId || getSandboxId() || null;

  console.log(
    `[E2B Bridge] Ensuring session: ${sessionId}, agent: ${agentId}, sandbox: ${resolvedSandboxId || 'active'}`,
  );

  try {
    let session = null;
    let created = false;

    if (resume) {
      try {
        session = await client.resumeSession(sessionId);
      } catch (error) {
        if (agentId === 'codex' && isAuthenticationRequiredError(error)) {
          const recovered = await ensureCodexLiveAuthenticated(client);
          if (recovered) {
            session = await client.resumeSession(sessionId);
          } else {
            console.warn(`[E2B Bridge] Could not resume session ${sessionId}:`, error.message);
          }
        } else {
          console.warn(`[E2B Bridge] Could not resume session ${sessionId}:`, error.message);
        }
      }
    }

    if (!session) {
      try {
        session = await client.getSession(sessionId);
      } catch (error) {
        console.warn(`[E2B Bridge] Could not look up existing session ${sessionId}:`, error.message);
      }
    }

    if (!session) {
      const sessionOpts = { id: sessionId, agent: agentId };
      if (cwd) sessionOpts.cwd = cwd;
      if (agentId === 'codex') {
        await ensureCodexLiveAuthenticated(client);
      }
      try {
        session = await client.createSession(sessionOpts);
      } catch (error) {
        if (agentId === 'codex' && isAuthenticationRequiredError(error)) {
          const recovered = await ensureCodexLiveAuthenticated(client);
          if (recovered) {
            session = await client.createSession(sessionOpts);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      created = true;
    }

    if (model) {
      try {
        await session.setModel(model);
      } catch (e) {
        console.warn(`[E2B Bridge] Could not set model ${model}:`, e.message);
      }
    }

    await applyCodexFeatureTogglesToSession(session, featureToggles);

    attachBridge(sessionId, session, {
      agentId,
      sandboxId: resolvedSandboxId,
      ws,
      onMessage,
    });

    if (session.id !== sessionId) {
      console.warn(
        `[E2B Bridge] Session ID mismatch. requested=${sessionId} actual=${session.id} agentSessionId=${session.agentSessionId}`,
      );
    }

    console.log(`[E2B Bridge] Session created: ${sessionId} -> ${session.agentSessionId}`);

    return {
      sessionId,
      sandboxSessionId: session.id,
      agentSessionId: session.agentSessionId,
      created,
    };
  } catch (error) {
    if (isRecoverableAcpTransportError(error)) {
      await invalidateSandboxConnection(resolvedSandboxId, error);
      disposeBridge(sessionId);
    }

    throw withReadableE2BError(error, {
      agent: agentId,
      sandboxId: resolvedSandboxId,
    });
  }
}

/**
 * Send a prompt/message to an active E2B session.
 *
 * @param {string} sessionId
 * @param {string} message - User message text
 * @returns {Promise<void>}
 */
export async function sendMessageToE2BSession(sessionId, message, options = {}) {
  let bridged = activeBridgedSessions.get(sessionId);

  if (!bridged || (options.sandboxId && bridged.sandboxId !== options.sandboxId)) {
    const sessionRecord = e2bSessionDb.getBySessionId(sessionId);
    const sandboxId = options.sandboxId || sessionRecord?.sandbox_id || null;
    const agent = options.agent || sessionRecord?.agent || 'claude';

    if (sandboxId) {
      await createE2BSession(sessionId, {
        agent,
        cwd: options.cwd,
        model: options.model || sessionRecord?.model || null,
        featureToggles: options.featureToggles,
        resume: true,
        sandboxId,
        sandboxConnectHost: options.sandboxConnectHost || '',
        ws: options.ws,
        onMessage: options.onMessage,
      });
      bridged = activeBridgedSessions.get(sessionId);
    }
  }

  if (!bridged) {
    throw new Error(`No active E2B session: ${sessionId}`);
  }

  if (isNativeClaudeBridgeState(bridged)) {
    const sandboxRecord = (bridged.sandboxId || options.sandboxId)
      ? e2bSandboxDb.getBySandboxId(bridged.sandboxId || options.sandboxId)
      : null;

    if (sandboxRecord && bridged.nativeRunner?.client) {
      await syncSandboxAuthState(bridged.nativeRunner.client, sandboxRecord, {
        sandboxConnectHost: options.sandboxConnectHost || '',
      });
    }

    console.log(`[E2B Bridge] Sending message to native Claude session ${sessionId}`);
    persistPromptMessage(sessionId, bridged.agent || options.agent || 'claude', message);
    updateBridgeActivity(sessionId, true);
    let terminalStatus = 'idle';

    try {
      await bridged.sendPrompt(message);
    } catch (error) {
      terminalStatus = 'error';
      throw withReadableE2BError(error, {
        agent: bridged.agent || options.agent || 'claude',
        sandboxId: bridged.sandboxId || options.sandboxId || null,
      });
    } finally {
      const nativeClaudeClient = bridged.nativeRunner?.client || null;
      await syncSelectedClaudeProfileFromSandbox(bridged.sandboxId || options.sandboxId || null, nativeClaudeClient).catch((syncError) => {
        console.warn(`[E2B Bridge] Failed to write back Claude auth after prompt ${sessionId}:`, syncError?.message || syncError);
      });

      if (activeBridgedSessions.has(sessionId)) {
        updateBridgeActivity(sessionId, false, terminalStatus);
      }
    }

    return;
  }

  await applyCodexFeatureTogglesToSession(bridged.session, options.featureToggles);

  console.log(`[E2B Bridge] Sending message to session ${sessionId}`);
  persistPromptMessage(sessionId, bridged.agent || options.agent || 'claude', message);
  updateBridgeActivity(sessionId, true);
  let terminalStatus = 'idle';
  try {
    const emittedBeforePrompt = bridged.emittedCount;
    const meaningfulOutputBeforePrompt = bridged.meaningfulOutputCount;
    const completionBeforePrompt = bridged.completionCount;
    const promptOnce = () => bridged.session.prompt([{ type: 'text', text: message }]);
    let response;

    try {
      response = await promptOnce();
    } catch (error) {
      if (
        resolveE2BAgentProvider(bridged.agent || options.agent || '') === 'codex' &&
        isAuthenticationRequiredError(error)
      ) {
        const client = await ensureSandbox(bridged.sandboxId || options.sandboxId || null, {
          sandboxConnectHost: options.sandboxConnectHost || '',
        });
        const recovered = await ensureCodexLiveAuthenticated(client);
        if (!recovered) {
          throw error;
        }
        response = await promptOnce();
      } else {
        throw error;
      }
    }

    if (bridged.emittedCount === emittedBeforePrompt) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (bridged.meaningfulOutputCount === meaningfulOutputBeforePrompt) {
      const errorMessage = buildSilentPromptError(bridged.agent || options.agent || '', response);
      const syntheticError = createNormalizedMessage({
        id: `e2b_empty_output_${Date.now()}`,
        sessionId,
        provider: resolveE2BAgentProvider(bridged.agent || options.agent || ''),
        kind: 'error',
        content: errorMessage,
      });
      persistBridgeMessage(syntheticError);
      bridged.emit?.(syntheticError);
    }

    if (bridged.completionCount === completionBeforePrompt) {
      emitSyntheticComplete(
        bridged,
        sessionId,
        resolveE2BAgentProvider(bridged.agent || options.agent || ''),
      );
    }
  } catch (error) {
    terminalStatus = 'error';

    if (isRecoverableAcpTransportError(error)) {
      await invalidateSandboxConnection(bridged.sandboxId || options.sandboxId || null, error);
      disposeBridge(sessionId);
    }

    throw withReadableE2BError(error, {
      agent: bridged.agent || options.agent || '',
      sandboxId: bridged.sandboxId || options.sandboxId || null,
    });
  } finally {
    if (activeBridgedSessions.has(sessionId)) {
      updateBridgeActivity(sessionId, false, terminalStatus);
    }
  }
}

/**
 * Respond to a permission request in an E2B session.
 *
 * @param {string} sessionId
 * @param {string} permissionId
 * @param {'once' | 'always' | 'reject'} reply
 * @returns {Promise<void>}
 */
export async function respondE2BPermission(sessionId, permissionId, reply) {
  let bridged = activeBridgedSessions.get(sessionId);

  if (!bridged) {
    const sessionRecord = e2bSessionDb.getBySessionId(sessionId);
    if (!sessionRecord?.sandbox_id) {
      throw new Error(`No active E2B session: ${sessionId}`);
    }

    await createE2BSession(sessionId, {
      agent: sessionRecord.agent || 'claude',
      model: sessionRecord.model || null,
      resume: true,
      sandboxId: sessionRecord.sandbox_id,
    });
    bridged = activeBridgedSessions.get(sessionId);
  }

  if (isNativeClaudeBridgeState(bridged)) {
    await bridged.respondPermission(permissionId, reply);
    return;
  }

  const client = await ensureSandbox(bridged?.sandboxId || null);
  if (!client) {
    throw new Error('No active E2B sandbox');
  }

  try {
    await client.respondPermission(permissionId, reply);
  } catch (error) {
    if (isRecoverableAcpTransportError(error)) {
      await invalidateSandboxConnection(bridged?.sandboxId || null, error);
      disposeBridge(sessionId);
    }

    throw withReadableE2BError(error, {
      agent: bridged?.agent || 'claude',
      sandboxId: bridged?.sandboxId || null,
    });
  }
}

/**
 * Abort/destroy an E2B session.
 *
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function syncClaudeSettingsToSandbox(sandboxId, options = {}) {
  if (!sandboxId) {
    return { synced: false, reason: 'missing_sandbox_id' };
  }

  try {
    await ensureSandbox(sandboxId, options);
    return { synced: true, sandboxId };
  } catch (error) {
    return {
      synced: false,
      sandboxId,
      error: error instanceof Error ? error.message : String(error || 'Unknown error'),
    };
  }
}

export async function syncClaudeSettingsToActiveSandboxes(userId, options = {}) {
  if (!userId) {
    return { total: 0, synced: 0, failed: [] };
  }

  const sandboxes = e2bSandboxDb.getActive(userId);
  const failed = [];
  let synced = 0;

  for (const sandboxRecord of sandboxes) {
    const result = await syncClaudeSettingsToSandbox(sandboxRecord.sandbox_id, options);
    if (result.synced) {
      synced += 1;
    } else {
      failed.push(result);
    }
  }

  return {
    total: sandboxes.length,
    synced,
    failed,
  };
}

export async function abortE2BSession(sessionId) {
  const sessionRecord = e2bSessionDb.getBySessionId(sessionId);
  const bridged = activeBridgedSessions.get(sessionId);
  const sandboxId = bridged?.sandboxId || sessionRecord?.sandbox_id || null;
  const metadata = getSessionMetadata(sessionRecord);

  console.log(`[E2B Bridge] Aborting session: ${sessionId}`);

  if (isNativeClaudeBridgeState(bridged)) {
    activeBridgedSessions.delete(sessionId);
    await bridged.abort();
    await syncSelectedClaudeProfileFromSandbox(sandboxId, bridged.nativeRunner?.client || null).catch((syncError) => {
      console.warn(`[E2B Bridge] Failed to persist Claude sandbox auth during abort ${sessionId}:`, syncError?.message || syncError);
    });
    updateSessionMetadata(sessionId, (current) => ({
      ...current,
      runtime: 'claude-native',
      pendingPermissions: [],
    }));
    safeUpdateSessionStatus(sessionId, 'ended');
    return;
  }

  if (resolveE2BAgentProvider(sessionRecord?.agent || '') === 'claude' && metadata.processId) {
    disposeBridge(sessionId);
    const client = await ensureSandbox(sandboxId);
    if (client) {
      try {
        await client.stopProcess(metadata.processId);
      } catch {
        try {
          await client.killProcess(metadata.processId);
        } catch {
          // Ignore already-stopped processes.
        }
      }
    }

    updateSessionMetadata(sessionId, (current) => ({
      ...current,
      runtime: 'claude-native',
      pendingPermissions: [],
    }));
    safeUpdateSessionStatus(sessionId, 'ended');
    return;
  }

  disposeBridge(sessionId);

  const client = await ensureSandbox(sandboxId);
  if (client) {
    try {
      await client.destroySession(sessionId);
    } catch (e) {
      console.warn(`[E2B Bridge] Error destroying session:`, e.message);
    }
  }

  safeUpdateSessionStatus(sessionId, 'ended');
}

/**
 * Check if an E2B session is active.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isE2BSessionActive(sessionId) {
  return (activeBridgedSessions.get(sessionId)?.activeRequests || 0) > 0;
}

/**
 * Get all active E2B session IDs.
 * @returns {string[]}
 */
export function getActiveE2BSessions() {
  return Array.from(activeBridgedSessions.entries())
    .filter(([, bridged]) => (bridged?.activeRequests || 0) > 0)
    .map(([sessionId]) => sessionId);
}

/**
 * Map claudecodeui provider names to sandbox-agent agent IDs.
 * @param {string} provider
 * @returns {string}
 */
function mapProviderToAgent(provider) {
  const mapping = {
    'claude': 'claude',
    'claude-code': 'claude',
    'codex': 'codex',
    'openai-codex': 'codex',
    'gemini': 'gemini',
    'opencode': 'opencode',
    'cursor': 'cursor',
    'amp': 'amp',
    'pi': 'pi',
  };
  return mapping[provider?.toLowerCase()] || provider || 'claude';
}

/**
 * Cleanup all active sessions (for shutdown).
 */
export async function cleanupAllE2BSessions() {
  for (const sessionId of activeBridgedSessions.keys()) {
    await abortE2BSession(sessionId);
  }
}
