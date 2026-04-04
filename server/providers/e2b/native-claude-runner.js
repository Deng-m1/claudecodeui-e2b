import { WebSocket } from 'ws';
import { createNormalizedMessage } from '../types.js';
import { claudeAdapter } from '../claude/adapter.js';
import { ensureNativeCliInstalled } from './sandbox-manager.js';

const DEFAULT_PROCESS_CWD = '/home/user';
const TERMINAL_ENV = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'claudecodeui-e2b-claude-native',
};
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function sanitizeProcessCwd(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_PROCESS_CWD;
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function stripTerminalControl(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(ANSI_ESCAPE_RE, '')
    .trim();
}

function buildPermissionDecision(reply, request = {}) {
  const normalizedReply = typeof reply === 'string' ? reply.trim().toLowerCase() : 'reject';
  const input = request?.input && typeof request.input === 'object' ? request.input : {};

  if (normalizedReply === 'reject') {
    return {
      behavior: 'deny',
      message: 'User denied tool use',
    };
  }

  return {
    behavior: 'allow',
    updatedInput: input,
  };
}

function buildResultErrorText(frame) {
  const errors = Array.isArray(frame?.errors)
    ? frame.errors.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const stopReason = normalizeNonEmptyString(frame?.stop_reason);

  if (errors.length > 0) {
    return errors.join('\n');
  }

  if (stopReason) {
    return `Claude Code stopped with ${stopReason}.`;
  }

  return 'Claude Code failed inside the E2B sandbox.';
}

function buildFallbackAssistantMessages(frame, sessionId) {
  const text = normalizeNonEmptyString(frame?.result);
  if (!text) {
    return [];
  }

  return [
    createNormalizedMessage({
      id: frame?.uuid ? `${frame.uuid}_fallback_text` : undefined,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: text,
    }),
  ];
}

function toReadyError(error) {
  return error instanceof Error ? error : new Error(String(error || 'Claude terminal failed to initialize'));
}

async function hasRunningProcess(client, processId) {
  if (!client || !processId) {
    return false;
  }

  try {
    const processInfo = await client.getProcess(processId);
    return processInfo?.status === 'running' || processInfo?.status === 'starting';
  } catch {
    return false;
  }
}

export function buildNativeClaudeLaunchScript(options = {}) {
  const model = normalizeNonEmptyString(options.model);
  const args = [
    'claude',
    '--print',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
  ];

  if (model) {
    args.push('--model', model);
  }

  return [
    "trap 'stty echo >/dev/null 2>&1 || true' EXIT INT TERM",
    'stty -echo >/dev/null 2>&1 || true',
    `cat | ${args.map(shellEscape).join(' ')}`,
  ].join('\n');
}

export function buildNativeClaudeUserMessage(prompt, nativeSessionId = '') {
  return {
    type: 'user',
    session_id: normalizeNonEmptyString(nativeSessionId),
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(prompt || '') }],
    },
    parent_tool_use_id: null,
  };
}

export function buildNativeClaudePermissionResponse(requestId, reply, request = {}) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: buildPermissionDecision(reply, request),
    },
  };
}

export function normalizeNativeClaudePermissionRequest(frame) {
  const request = frame?.request && typeof frame.request === 'object' ? frame.request : {};
  const toolName = normalizeNonEmptyString(request.tool_name) || 'unknown';
  const input = request?.input && typeof request.input === 'object' ? request.input : {};
  const requestId = normalizeNonEmptyString(frame?.request_id);

  return {
    requestId,
    toolName,
    input,
    context: {
      availableReplies: ['once', 'always', 'reject'],
      blockedPath: normalizeNonEmptyString(request.blocked_path) || null,
      description: normalizeNonEmptyString(request.description) || '',
      toolCallId: normalizeNonEmptyString(request.tool_use_id) || null,
      agentId: normalizeNonEmptyString(request.agent_id) || null,
      permissionSuggestions: Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : [],
      rawRequest: request,
    },
  };
}

export function parseNativeClaudeProtocolLine(line) {
  const sanitized = stripTerminalControl(line);
  if (!sanitized) {
    return null;
  }

  try {
    return JSON.parse(sanitized);
  } catch {
    return null;
  }
}

export class NativeClaudeE2BRunner {
  constructor(options) {
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.sandboxId = options.sandboxId || null;
    this.cwd = sanitizeProcessCwd(options.cwd);
    this.model = normalizeNonEmptyString(options.model);
    this.processEnv = options.processEnv && typeof options.processEnv === 'object' ? options.processEnv : {};
    this.emitMessage = typeof options.emitMessage === 'function' ? options.emitMessage : () => {};
    this.onMetadataChange = typeof options.onMetadataChange === 'function' ? options.onMetadataChange : () => {};
    this.onTerminated = typeof options.onTerminated === 'function' ? options.onTerminated : () => {};
    this.processId = '';
    this.nativeSessionId = '';
    this.pendingPermissions = new Map();
    this.outputBuffer = '';
    this.pendingTurn = null;
    this.manualClose = false;
    this.aborting = false;
    this.terminal = null;
    this.terminalReady = null;
    this.resolveTerminalReady = null;
    this.rejectTerminalReady = null;
    this.lastTurnHadAssistantOutput = false;
  }

  async start(options = {}) {
    const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
    const resumeProcessId = normalizeNonEmptyString(options.processId || metadata.processId);
    const attachedToExistingProcess = await hasRunningProcess(this.client, resumeProcessId);

    if (attachedToExistingProcess) {
      this.processId = resumeProcessId;
    } else {
      await ensureNativeCliInstalled(this.client, 'claude');
      const processInfo = await this.client.createProcess({
        command: 'bash',
        args: ['-lc', buildNativeClaudeLaunchScript({ model: this.model })],
        cwd: this.cwd,
        env: {
          ...TERMINAL_ENV,
          ...this.processEnv,
        },
        interactive: true,
        tty: true,
      });
      this.processId = processInfo.id;
    }

    this.attachTerminal();
    await this.terminalReady;

    this.nativeSessionId = normalizeNonEmptyString(metadata.nativeClaudeSessionId || this.nativeSessionId);
    this.restorePendingPermissions(metadata.pendingPermissions);
    this.syncMetadata();

    return {
      created: !attachedToExistingProcess,
      processId: this.processId,
      nativeSessionId: this.nativeSessionId || null,
      pendingPermissions: this.serializePendingPermissions(),
    };
  }

  attachTerminal() {
    this.terminal = this.client.connectProcessTerminal(this.processId, { WebSocket });
    this.terminalReady = new Promise((resolve, reject) => {
      this.resolveTerminalReady = resolve;
      this.rejectTerminalReady = reject;
    });

    try {
      this.terminal.resize({ cols: 120, rows: 30 });
    } catch {
      // Resize failures during initial attach are non-fatal.
    }

    this.terminal.onReady(() => {
      this.resolveTerminalReady?.();
    });

    this.terminal.onData((data) => {
      this.handleTerminalData(Buffer.from(data).toString('utf8'));
    });

    this.terminal.onError((error) => {
      this.handleTerminalFailure(toReadyError(error));
    });

    this.terminal.onExit((status) => {
      const exitCode = status?.exitCode;
      const signal = normalizeNonEmptyString(status?.signal);
      const exitDetails = [
        Number.isFinite(exitCode) ? `exitCode=${exitCode}` : '',
        signal ? `signal=${signal}` : '',
      ].filter(Boolean).join(', ');
      this.handleTerminalFailure(
        new Error(`Claude Code process exited${exitDetails ? ` (${exitDetails})` : ''}`),
        status,
      );
    });
  }

  restorePendingPermissions(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      const requestId = normalizeNonEmptyString(entry?.requestId);
      if (!requestId || this.pendingPermissions.has(requestId)) {
        continue;
      }

      this.pendingPermissions.set(requestId, {
        requestId,
        toolName: normalizeNonEmptyString(entry?.toolName) || 'unknown',
        input: entry?.input && typeof entry.input === 'object' ? entry.input : {},
        context: entry?.context && typeof entry.context === 'object' ? entry.context : {},
      });
    }

    for (const entry of this.pendingPermissions.values()) {
      this.emitMessage(
        createNormalizedMessage({
          id: `claude_permission_${entry.requestId}`,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'permission_request',
          requestId: entry.requestId,
          toolName: entry.toolName,
          input: entry.input,
          context: entry.context,
        }),
      );
    }
  }

  serializePendingPermissions() {
    return Array.from(this.pendingPermissions.values()).map((entry) => ({
      requestId: entry.requestId,
      toolName: entry.toolName,
      input: entry.input,
      context: entry.context,
    }));
  }

  syncMetadata() {
    this.onMetadataChange({
      runtime: 'claude-native',
      processId: this.processId || null,
      nativeClaudeSessionId: this.nativeSessionId || null,
      pendingPermissions: this.serializePendingPermissions(),
    });
  }

  async sendPrompt(message) {
    if (this.pendingTurn) {
      throw new Error('Claude Code is already processing a prompt in this E2B session.');
    }

    await this.terminalReady;
    this.lastTurnHadAssistantOutput = false;

    const payload = buildNativeClaudeUserMessage(message, this.nativeSessionId);

    return new Promise((resolve, reject) => {
      this.pendingTurn = { resolve, reject };

      try {
        this.terminal.sendInput(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pendingTurn = null;
        reject(toReadyError(error));
      }
    });
  }

  async respondPermission(permissionId, reply) {
    const normalizedPermissionId = normalizeNonEmptyString(permissionId);
    const request = this.pendingPermissions.get(normalizedPermissionId);

    if (!request) {
      throw new Error(`No pending Claude permission request found: ${permissionId}`);
    }

    await this.terminalReady;
    const payload = buildNativeClaudePermissionResponse(normalizedPermissionId, reply, request.context?.rawRequest || {});
    this.terminal.sendInput(`${JSON.stringify(payload)}\n`);
    this.pendingPermissions.delete(normalizedPermissionId);
    this.syncMetadata();
  }

  handleTerminalData(chunk) {
    this.outputBuffer += String(chunk || '');

    let newlineIndex = this.outputBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.outputBuffer.slice(0, newlineIndex);
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      this.handleProtocolLine(line);
      newlineIndex = this.outputBuffer.indexOf('\n');
    }
  }

  handleProtocolLine(line) {
    const frame = parseNativeClaudeProtocolLine(line);
    if (!frame || typeof frame !== 'object') {
      return;
    }

    if (frame.type === 'system' && frame.subtype === 'init') {
      const nextSessionId = normalizeNonEmptyString(frame.session_id);
      if (nextSessionId && nextSessionId !== this.nativeSessionId) {
        this.nativeSessionId = nextSessionId;
        this.syncMetadata();
      }
      return;
    }

    if (frame.type === 'assistant') {
      const normalized = claudeAdapter.normalizeMessage(frame, this.sessionId);
      if (frame.error) {
        this.emitMessage(
          createNormalizedMessage({
            id: frame.uuid ? `${frame.uuid}_error` : undefined,
            sessionId: this.sessionId,
            provider: 'claude',
            kind: 'error',
            content: `Claude Code reported ${frame.error}.`,
          }),
        );
      }

      for (const message of normalized) {
        if (message.kind === 'text' || message.kind === 'stream_delta' || message.kind === 'tool_use' || message.kind === 'thinking') {
          this.lastTurnHadAssistantOutput = true;
        }
        this.emitMessage(message);
      }
      return;
    }

    if (frame.type === 'stream_event') {
      const normalized = claudeAdapter.normalizeMessage({
        ...frame.event,
        uuid: frame.uuid,
        timestamp: new Date().toISOString(),
      }, this.sessionId);
      for (const message of normalized) {
        if (message.kind === 'text' || message.kind === 'stream_delta' || message.kind === 'tool_use' || message.kind === 'thinking') {
          this.lastTurnHadAssistantOutput = true;
        }
        this.emitMessage(message);
      }
      return;
    }

    if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool') {
      const normalized = normalizeNativeClaudePermissionRequest(frame);
      this.pendingPermissions.set(normalized.requestId, normalized);
      this.syncMetadata();
      this.emitMessage(
        createNormalizedMessage({
          id: `claude_permission_${normalized.requestId}`,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'permission_request',
          requestId: normalized.requestId,
          toolName: normalized.toolName,
          input: normalized.input,
          context: normalized.context,
        }),
      );
      return;
    }

    if (frame.type === 'result') {
      if (frame.subtype === 'success' && !this.lastTurnHadAssistantOutput) {
        for (const message of buildFallbackAssistantMessages(frame, this.sessionId)) {
          this.emitMessage(message);
        }
      }

      if (frame.is_error || frame.subtype !== 'success') {
        this.emitMessage(
          createNormalizedMessage({
            id: frame.uuid ? `${frame.uuid}_error` : undefined,
            sessionId: this.sessionId,
            provider: 'claude',
            kind: 'error',
            content: buildResultErrorText(frame),
          }),
        );

        const pendingTurn = this.pendingTurn;
        this.pendingTurn = null;
        pendingTurn?.reject(new Error(buildResultErrorText(frame)));
        return;
      }

      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_complete` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'complete',
          exitCode: 0,
          success: true,
        }),
      );

      const pendingTurn = this.pendingTurn;
      this.pendingTurn = null;
      pendingTurn?.resolve();
      return;
    }

    if (frame.type === 'system' && frame.subtype === 'task_notification') {
      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_task_notification` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'task_notification',
          status: frame.status,
          summary: normalizeNonEmptyString(frame.summary) || 'Task notification',
        }),
      );
      return;
    }

    if (frame.type === 'system' && frame.subtype === 'status') {
      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_status` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'status',
          text: normalizeNonEmptyString(frame.status) || 'Claude Code status update',
        }),
      );
      return;
    }

    if (frame.type === 'tool_use_summary') {
      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_tool_use_summary` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'status',
          text: normalizeNonEmptyString(frame.summary) || 'Claude Code tool summary',
        }),
      );
      return;
    }

    if (frame.type === 'auth_status' && frame.error) {
      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_auth_error` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'error',
          content: normalizeNonEmptyString(frame.error) || 'Claude Code authentication failed.',
        }),
      );
      return;
    }

    if (frame.type === 'rate_limit_event') {
      this.emitMessage(
        createNormalizedMessage({
          id: frame.uuid ? `${frame.uuid}_rate_limit` : undefined,
          sessionId: this.sessionId,
          provider: 'claude',
          kind: 'status',
          text: 'Claude Code rate limit update',
        }),
      );
    }
  }

  handleTerminalFailure(error, status = null) {
    if (this.manualClose || this.aborting) {
      return;
    }

    const failure = toReadyError(error);
    this.rejectTerminalReady?.(failure);

    const pendingTurn = this.pendingTurn;
    this.pendingTurn = null;
    pendingTurn?.reject(failure);

    this.onTerminated(failure, status);
  }

  async close() {
    this.manualClose = true;

    if (!this.terminal) {
      return;
    }

    this.terminal.close();
    await this.terminal.closed.catch(() => {});
    this.terminal = null;
  }

  async abort() {
    this.aborting = true;
    await this.close();

    if (!this.processId) {
      return;
    }

    try {
      await this.client.stopProcess(this.processId);
    } catch {
      try {
        await this.client.killProcess(this.processId);
      } catch {
        // Ignore already-stopped processes.
      }
    }
  }
}
