import { WebSocket } from 'ws';
import { WebSocketWriter } from '../../lib/session-writer.js';
import { remoteHostsDb, remoteHostSessionMessagesDb, remoteHostSessionsDb, remoteWorkspacesDb } from '../../database/db.js';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { mapPermissionModeToCodexOptions, normalizeCodexPermissionMode } from '../codex/permissions.js';
import { resolveRemoteWorkspaceTarget } from './agent-client.js';
import { isRemoteHostProjectName } from './project-utils.js';
import { executeRemoteProcessWithFallback } from './transport.js';

const SUPPORTED_REMOTE_CHAT_PROVIDERS = new Set(['claude', 'codex']);
const DEFAULT_REMOTE_PROCESS_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_REMOTE_PROCESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const activeRemoteChatSessions = new Map();

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function buildSessionSummary(command, fallback = 'New Session') {
  const normalized = normalizeNonEmptyString(command).replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function toMessageTimestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  return new Date().toISOString();
}

function buildSyntheticRemoteSessionId(provider) {
  return `remote_${provider}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildUserPromptMessage(sessionId, provider, command) {
  return createNormalizedMessage({
    id: generateMessageId('remote_user'),
    sessionId,
    provider,
    kind: 'text',
    role: 'user',
    content: command,
  });
}

function persistRemoteHistoryMessage(sessionId, message) {
  if (!sessionId || !message) {
    return;
  }

  const persistableKinds = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'error', 'interactive_prompt', 'task_notification']);
  if (!persistableKinds.has(message.kind)) {
    return;
  }

  remoteHostSessionMessagesDb.append(sessionId, message);
}

function createRemoteChatError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function extractClaudeAssistantText(rawMessage) {
  const content = rawMessage?.message?.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseClaudeJsonOutput(stdout, fallbackSessionId) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const messages = [];
  const seenErrors = new Set();
  let actualSessionId = normalizeNonEmptyString(fallbackSessionId) || null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = toMessageTimestamp(entry.timestamp);
    if (entry?.type === 'system' && entry?.subtype === 'init' && typeof entry.session_id === 'string') {
      actualSessionId = entry.session_id;
      continue;
    }

    const sessionId = actualSessionId || normalizeNonEmptyString(entry?.session_id) || fallbackSessionId || '';
    const assistantText = extractClaudeAssistantText(entry);

    if (entry?.type === 'assistant') {
      if (entry.error) {
        const content = assistantText || String(entry.error);
        const signature = `assistant-error:${content}`;
        if (!seenErrors.has(signature)) {
          seenErrors.add(signature);
          messages.push(createNormalizedMessage({
            id: generateMessageId('remote_claude_error'),
            sessionId,
            timestamp,
            provider: 'claude',
            kind: 'error',
            content,
          }));
        }
        continue;
      }

      if (assistantText) {
        messages.push(createNormalizedMessage({
          id: generateMessageId('remote_claude_text'),
          sessionId,
          timestamp,
          provider: 'claude',
          kind: 'text',
          role: 'assistant',
          content: assistantText,
        }));
      }
      continue;
    }

    if (entry?.type === 'result' && entry?.is_error === true) {
      const content = normalizeNonEmptyString(entry.result) || assistantText || 'Remote Claude session failed';
      const signature = `result-error:${content}`;
      if (!seenErrors.has(signature)) {
        seenErrors.add(signature);
        messages.push(createNormalizedMessage({
          id: generateMessageId('remote_claude_error'),
          sessionId,
          timestamp,
          provider: 'claude',
          kind: 'error',
          content,
        }));
      }
      continue;
    }

    if (entry?.type === 'result' && assistantText.length === 0) {
      const content = normalizeNonEmptyString(entry.result);
      if (content) {
        messages.push(createNormalizedMessage({
          id: generateMessageId('remote_claude_text'),
          sessionId,
          timestamp,
          provider: 'claude',
          kind: 'text',
          role: 'assistant',
          content,
        }));
      }
    }
  }

  return {
    actualSessionId: actualSessionId || fallbackSessionId || null,
    messages,
    hasError: messages.some((message) => message.kind === 'error'),
  };
}

function parseCodexJsonOutput(stdout, fallbackSessionId) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const messages = [];
  let actualSessionId = normalizeNonEmptyString(fallbackSessionId) || null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = toMessageTimestamp(entry.timestamp);

    if (entry?.type === 'thread.started' && typeof entry.thread_id === 'string') {
      actualSessionId = entry.thread_id;
      continue;
    }

    const sessionId = actualSessionId || fallbackSessionId || '';
    if (entry?.type === 'turn.failed') {
      const content = normalizeNonEmptyString(entry?.error?.message) || 'Remote Codex turn failed';
      messages.push(createNormalizedMessage({
        id: generateMessageId('remote_codex_error'),
        sessionId,
        timestamp,
        provider: 'codex',
        kind: 'error',
        content,
      }));
      continue;
    }

    if (!entry?.item || (entry.type !== 'item.started' && entry.type !== 'item.updated' && entry.type !== 'item.completed')) {
      continue;
    }

    const item = entry.item;
    if (item.type === 'agent_message' && entry.type === 'item.completed' && normalizeNonEmptyString(item.text)) {
      messages.push(createNormalizedMessage({
        id: item.id || generateMessageId('remote_codex_text'),
        sessionId,
        timestamp,
        provider: 'codex',
        kind: 'text',
        role: 'assistant',
        content: item.text,
      }));
      continue;
    }

    if (item.type === 'command_execution') {
      if (entry.type === 'item.started') {
        messages.push(createNormalizedMessage({
          id: `${item.id || generateMessageId('remote_codex_tool')}_use`,
          sessionId,
          timestamp,
          provider: 'codex',
          kind: 'tool_use',
          toolName: 'Bash',
          toolInput: { command: item.command || '' },
          toolId: item.id || generateMessageId('remote_codex_tool_call'),
        }));
        continue;
      }

      if (entry.type === 'item.completed') {
        messages.push(createNormalizedMessage({
          id: `${item.id || generateMessageId('remote_codex_tool')}_result`,
          sessionId,
          timestamp,
          provider: 'codex',
          kind: 'tool_result',
          toolId: item.id || '',
          content: normalizeNonEmptyString(item.aggregated_output) || '',
          isError: Number.isFinite(item.exit_code) ? item.exit_code !== 0 : false,
        }));
      }
    }
  }

  return {
    actualSessionId: actualSessionId || fallbackSessionId || null,
    messages,
    hasError: messages.some((message) => message.kind === 'error' || message.isError),
  };
}

function formatRemoteCommandFailure(provider, response) {
  const stdout = normalizeNonEmptyString(response?.stdout);
  const stderr = normalizeNonEmptyString(response?.stderr);

  if (stdout) {
    return stdout;
  }

  if (stderr) {
    return stderr;
  }

  if (response?.timedOut) {
    return `Remote ${provider} command timed out`;
  }

  return `Remote ${provider} command failed`;
}

function resolveRemoteClaudePermissionMode(permissionMode, remoteUsername = '') {
  const normalized = normalizeNonEmptyString(permissionMode) || 'default';
  if (normalized === 'bypassPermissions' && remoteUsername.trim().toLowerCase() === 'root') {
    return 'acceptEdits';
  }

  return normalized;
}

function buildRemoteCodexExecutionProfile(permissionMode) {
  const normalizedPermissionMode = normalizeCodexPermissionMode(permissionMode, 'bypassPermissions');
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(normalizedPermissionMode);

  return {
    permissionMode: normalizedPermissionMode,
    sandboxMode,
    approvalPolicy,
    isolationKey: `${normalizedPermissionMode}:${sandboxMode}:${approvalPolicy}`,
  };
}

function inferRemoteCodexExecutionProfileFromArgs(args = []) {
  if (!Array.isArray(args) || args.length === 0) {
    return null;
  }

  let sandboxMode = '';
  let approvalPolicy = '';

  for (let index = 0; index < args.length; index += 1) {
    const value = normalizeNonEmptyString(args[index]);
    if (!value) {
      continue;
    }

    if ((value === '-s' || value === '--sandbox') && index + 1 < args.length) {
      sandboxMode = normalizeNonEmptyString(args[index + 1]);
      index += 1;
      continue;
    }

    if ((value === '-a' || value === '--ask-for-approval') && index + 1 < args.length) {
      approvalPolicy = normalizeNonEmptyString(args[index + 1]);
      index += 1;
      continue;
    }

    if (value === '--full-auto') {
      sandboxMode = sandboxMode || 'workspace-write';
      approvalPolicy = approvalPolicy || 'on-request';
      continue;
    }

    if (value === '--dangerously-bypass-approvals-and-sandbox') {
      sandboxMode = sandboxMode || 'danger-full-access';
      approvalPolicy = approvalPolicy || 'never';
    }
  }

  if (!sandboxMode || !approvalPolicy) {
    return null;
  }

  if (sandboxMode === 'danger-full-access' && approvalPolicy === 'never') {
    return buildRemoteCodexExecutionProfile('bypassPermissions');
  }

  if (sandboxMode === 'workspace-write' && approvalPolicy === 'never') {
    return buildRemoteCodexExecutionProfile('acceptEdits');
  }

  if (sandboxMode === 'workspace-write' && approvalPolicy === 'untrusted') {
    return buildRemoteCodexExecutionProfile('default');
  }

  return {
    permissionMode: null,
    sandboxMode,
    approvalPolicy,
    isolationKey: `${sandboxMode}:${approvalPolicy}`,
  };
}

function inferStoredRemoteCodexExecutionProfile(metadata = null) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const storedProfile = metadata.codexExecutionProfile;
  if (storedProfile && typeof storedProfile === 'object') {
    const permissionMode = normalizeCodexPermissionMode(storedProfile.permissionMode, '');
    if (permissionMode) {
      return buildRemoteCodexExecutionProfile(permissionMode);
    }
  }

  const storedPermissionMode = normalizeCodexPermissionMode(metadata.permissionMode, '');
  if (storedPermissionMode) {
    return buildRemoteCodexExecutionProfile(storedPermissionMode);
  }

  return inferRemoteCodexExecutionProfileFromArgs(metadata.remoteArgs);
}

function resolveRemoteCodexSessionReuse(requestedSessionId, sessionRecord, permissionMode) {
  const normalizedRequestedSessionId = normalizeNonEmptyString(requestedSessionId);
  const executionProfile = buildRemoteCodexExecutionProfile(permissionMode);

  if (!normalizedRequestedSessionId) {
    return {
      requestedSessionId: null,
      resumeSessionId: null,
      executionProfile,
      reuseMode: 'new_session',
      previousExecutionProfile: null,
    };
  }

  const previousExecutionProfile = inferStoredRemoteCodexExecutionProfile(sessionRecord?.metadata);
  if (!previousExecutionProfile) {
    return {
      requestedSessionId: normalizedRequestedSessionId,
      resumeSessionId: null,
      executionProfile,
      reuseMode: 'new_session_unknown_profile',
      previousExecutionProfile: null,
    };
  }

  if (previousExecutionProfile.isolationKey !== executionProfile.isolationKey) {
    return {
      requestedSessionId: normalizedRequestedSessionId,
      resumeSessionId: null,
      executionProfile,
      reuseMode: 'new_session_profile_mismatch',
      previousExecutionProfile,
    };
  }

  return {
    requestedSessionId: normalizedRequestedSessionId,
    resumeSessionId: normalizedRequestedSessionId,
    executionProfile,
    reuseMode: 'resume_existing',
    previousExecutionProfile,
  };
}

function buildRemoteProcessPayload(provider, {
  command,
  sessionId,
  model,
  permissionMode,
  cwd,
  remoteUsername,
} = {}) {
  const normalizedCommand = normalizeNonEmptyString(command);

  if (provider === 'codex') {
    const executionProfile = buildRemoteCodexExecutionProfile(permissionMode);
    const args = ['-a', executionProfile.approvalPolicy, '-s', executionProfile.sandboxMode];

    if (sessionId) {
      args.push('exec', 'resume', sessionId, '--json', '--skip-git-repo-check');
    } else {
      args.push('exec', '--json', '--skip-git-repo-check');
    }

    if (model) {
      args.push('--model', model);
    }

    if (normalizedCommand) {
      args.push(normalizedCommand);
    }

    return {
      command: 'codex',
      args,
      cwd,
      loginShell: true,
      timeoutMs: DEFAULT_REMOTE_PROCESS_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_REMOTE_PROCESS_MAX_OUTPUT_BYTES,
    };
  }

  if (provider === 'claude') {
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];
    const resolvedPermissionMode = resolveRemoteClaudePermissionMode(permissionMode, remoteUsername);

    if (resolvedPermissionMode) {
      args.push('--permission-mode', resolvedPermissionMode);
    }

    if (model) {
      args.push('--model', model);
    }

    if (sessionId) {
      args.push('-r', sessionId);
    }

    if (normalizedCommand) {
      args.push(normalizedCommand);
    }

    return {
      command: 'claude',
      args,
      cwd,
      loginShell: true,
      timeoutMs: DEFAULT_REMOTE_PROCESS_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_REMOTE_PROCESS_MAX_OUTPUT_BYTES,
    };
  }

  throw createRemoteChatError(`Remote chat provider is not supported yet: ${provider}`, 400);
}

function buildFallbackErrorMessage(sessionId, provider, content) {
  return createNormalizedMessage({
    id: generateMessageId(`remote_${provider}_error`),
    sessionId,
    provider,
    kind: 'error',
    content,
  });
}

function resolveRemoteSessionTarget(userId, options = {}) {
  const projectName = normalizeNonEmptyString(options.projectName);
  if (projectName && isRemoteHostProjectName(projectName)) {
    const resolved = resolveRemoteWorkspaceTarget(projectName, userId);
    return {
      host: resolved.host,
      workspace: resolved.workspace,
      projectName,
      projectRoot: resolved.workspace.workspace_root,
    };
  }

  const sessionId = normalizeNonEmptyString(options.sessionId);
  if (sessionId) {
    const sessionRecord = remoteHostSessionsDb.getBySessionId(sessionId);
    if (sessionRecord?.user_id !== userId) {
      throw createRemoteChatError('Remote session not found', 404);
    }

    const workspace = remoteWorkspacesDb.getById(userId, sessionRecord.workspace_id);
    const host = workspace ? remoteHostsDb.getById(userId, workspace.remote_host_id) : null;
    if (!workspace || !host) {
      throw createRemoteChatError('Remote session target is unavailable', 404);
    }

    return {
      host,
      workspace,
      projectName: isRemoteHostProjectName(projectName) ? projectName : null,
      projectRoot: workspace.workspace_root,
      sessionRecord,
    };
  }

  throw createRemoteChatError('Remote chat requires a remote project or session context', 400);
}

function emitRemoteMessages(writer, messages = []) {
  for (const message of messages) {
    writer.send(message);
  }
}

export function isRemoteHostChatSupported(provider) {
  return SUPPORTED_REMOTE_CHAT_PROVIDERS.has(provider);
}

export function isRemoteHostSessionActive(sessionId) {
  return activeRemoteChatSessions.has(sessionId);
}

export function reconnectRemoteHostSessionWriter(sessionId, ws) {
  if (!sessionId || !ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const active = activeRemoteChatSessions.get(sessionId);
  if (!active) {
    return false;
  }

  const userId = ws.userId ?? null;
  active.writer = new WebSocketWriter(ws, userId).bindSession(sessionId);
  return true;
}

export function abortRemoteHostSession() {
  return false;
}

export function getActiveRemoteHostSessions() {
  return Array.from(activeRemoteChatSessions.keys());
}

export function isPersistedRemoteHostSession(sessionId) {
  if (!sessionId) {
    return false;
  }

  return Boolean(remoteHostSessionsDb.getBySessionId(sessionId));
}

export async function queryRemoteHostChat(provider, command, options = {}, writer, { userId = null } = {}) {
  if (!userId) {
    throw createRemoteChatError('Remote chat requires an authenticated user', 401);
  }

  if (!isRemoteHostChatSupported(provider)) {
    throw createRemoteChatError(`Remote chat provider is not supported yet: ${provider}`, 400);
  }

  const requestedSessionId = normalizeNonEmptyString(options.sessionId) || null;
  const remoteTarget = resolveRemoteSessionTarget(userId, options);
  const resolvedPermissionMode = provider === 'codex'
    ? normalizeCodexPermissionMode(options.permissionMode, 'bypassPermissions')
    : normalizeNonEmptyString(options.permissionMode) || 'default';
  const codexSessionReuse = provider === 'codex'
    ? resolveRemoteCodexSessionReuse(requestedSessionId, remoteTarget.sessionRecord, resolvedPermissionMode)
    : null;
  const resumeSessionId = provider === 'codex'
    ? (codexSessionReuse?.resumeSessionId ?? null)
    : requestedSessionId;
  const processPayload = buildRemoteProcessPayload(provider, {
    command,
    sessionId: resumeSessionId,
    model: normalizeNonEmptyString(options.model) || null,
    permissionMode: resolvedPermissionMode,
    cwd: remoteTarget.projectRoot,
    remoteUsername: normalizeNonEmptyString(remoteTarget.host?.username) || '',
  });

  if (resumeSessionId) {
    activeRemoteChatSessions.set(resumeSessionId, {
      provider,
      writer,
      startedAt: Date.now(),
      workspaceId: remoteTarget.workspace.id,
    });

    writer.send(createNormalizedMessage({
      sessionId: resumeSessionId,
      provider,
      kind: 'status',
      text: `Running remote ${provider} on ${remoteTarget.host.host}`,
      canInterrupt: false,
    }));
  }

  let response;
  let requestError = null;
  try {
    response = await executeRemoteProcessWithFallback(remoteTarget.host, processPayload, {
      agentTimeoutMs: DEFAULT_REMOTE_PROCESS_TIMEOUT_MS + 15_000,
      timeoutMs: DEFAULT_REMOTE_PROCESS_TIMEOUT_MS + 15_000,
      maxOutputBytes: DEFAULT_REMOTE_PROCESS_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    requestError = error;
  }

  const liveWriter = resumeSessionId
    ? (activeRemoteChatSessions.get(resumeSessionId)?.writer || writer)
    : writer;

  if (requestError) {
    const failedSessionId = resumeSessionId || buildSyntheticRemoteSessionId(provider);
    const errorMessage = buildFallbackErrorMessage(
      failedSessionId,
      provider,
      requestError?.message || `Remote ${provider} request failed`,
    );

    remoteHostSessionsDb.upsert(userId, failedSessionId, {
      remoteHostId: remoteTarget.host.id,
      workspaceId: remoteTarget.workspace.id,
      provider,
      model: normalizeNonEmptyString(options.model) || null,
      summary: normalizeNonEmptyString(options.sessionSummary) || buildSessionSummary(command),
      status: 'error',
      metadata: {
        projectName: remoteTarget.projectName,
        projectRoot: remoteTarget.projectRoot,
        requestedSessionId,
        resumeSessionId,
        permissionMode: provider === 'codex' ? resolvedPermissionMode : undefined,
        sessionReuse: codexSessionReuse?.reuseMode,
        codexExecutionProfile: codexSessionReuse?.executionProfile,
        remoteCommand: processPayload.command,
        remoteArgs: processPayload.args,
      },
    });
    if (normalizeNonEmptyString(command)) {
      persistRemoteHistoryMessage(failedSessionId, buildUserPromptMessage(failedSessionId, provider, command));
    }
    persistRemoteHistoryMessage(failedSessionId, errorMessage);

    if (resumeSessionId) {
      activeRemoteChatSessions.delete(resumeSessionId);
    } else {
      liveWriter.send(createNormalizedMessage({
        sessionId: failedSessionId,
        provider,
        kind: 'session_created',
        newSessionId: failedSessionId,
      }));
    }

    liveWriter.send(errorMessage);
    liveWriter.send(createNormalizedMessage({
      sessionId: failedSessionId,
      provider,
      kind: 'complete',
      exitCode: 1,
      success: false,
    }));
    return;
  }

  const parsed = provider === 'codex'
    ? parseCodexJsonOutput(response.stdout || '', resumeSessionId)
    : parseClaudeJsonOutput(response.stdout || '', resumeSessionId);

  const actualSessionId = parsed.actualSessionId || resumeSessionId || buildSyntheticRemoteSessionId(provider);
  const historyMessages = [];
  const userPrompt = normalizeNonEmptyString(command);

  if (userPrompt) {
    historyMessages.push(buildUserPromptMessage(actualSessionId, provider, userPrompt));
  }

  historyMessages.push(
    ...parsed.messages.map((message) => (
      message.sessionId === actualSessionId
        ? message
        : { ...message, sessionId: actualSessionId }
    )),
  );

  if (historyMessages.length === 0 || (response.exitCode !== 0 && !parsed.hasError)) {
    historyMessages.push(buildFallbackErrorMessage(
      actualSessionId,
      provider,
      formatRemoteCommandFailure(provider, response),
    ));
  }

  const sessionSummary = normalizeNonEmptyString(options.sessionSummary) || buildSessionSummary(command);
  const hasError = historyMessages.some((message) => message.kind === 'error' || message.isError);

  remoteHostSessionsDb.upsert(userId, actualSessionId, {
    remoteHostId: remoteTarget.host.id,
    workspaceId: remoteTarget.workspace.id,
    provider,
    model: normalizeNonEmptyString(options.model) || null,
    summary: sessionSummary,
    status: hasError ? 'error' : 'completed',
    metadata: {
      projectName: remoteTarget.projectName,
      projectRoot: remoteTarget.projectRoot,
      requestedSessionId,
      resumeSessionId,
      permissionMode: provider === 'codex' ? resolvedPermissionMode : undefined,
      sessionReuse: codexSessionReuse?.reuseMode,
      codexExecutionProfile: codexSessionReuse?.executionProfile,
      remoteCommand: processPayload.command,
      remoteArgs: processPayload.args,
      exitCode: response.exitCode ?? 0,
      timedOut: response.timedOut === true,
    },
  });

  for (const message of historyMessages) {
    persistRemoteHistoryMessage(actualSessionId, message);
  }

  if (!requestedSessionId || requestedSessionId !== actualSessionId) {
    liveWriter.send(createNormalizedMessage({
      sessionId: actualSessionId,
      provider,
      kind: 'session_created',
      newSessionId: actualSessionId,
    }));
  }

  emitRemoteMessages(liveWriter, historyMessages.filter((message) => message.kind !== 'text' || message.role !== 'user'));

  liveWriter.send(createNormalizedMessage({
    sessionId: actualSessionId,
    provider,
    kind: 'complete',
    exitCode: Number.isFinite(response.exitCode) ? response.exitCode : 0,
    success: !hasError && Number(response.exitCode || 0) === 0,
    actualSessionId: requestedSessionId && requestedSessionId !== actualSessionId ? actualSessionId : undefined,
  }));

  if (resumeSessionId) {
    activeRemoteChatSessions.delete(resumeSessionId);
  }
}

export {
  buildRemoteCodexExecutionProfile,
  buildRemoteProcessPayload,
  inferStoredRemoteCodexExecutionProfile,
  parseClaudeJsonOutput,
  parseCodexJsonOutput,
  resolveRemoteCodexSessionReuse,
};
