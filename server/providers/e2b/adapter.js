/**
 * E2B Provider Adapter
 *
 * Maps sandbox-agent's ACP SessionEvent / SessionUpdate payloads
 * into claudecodeui's NormalizedMessage format.
 *
 * @module providers/e2b/adapter
 */

import { createNormalizedMessage } from '../types.js';

const PROVIDER = 'e2b';
const ACP_TOOL_KIND_LABELS = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Bash',
  think: 'Think',
  fetch: 'Fetch',
  switch_mode: 'SwitchMode',
  other: 'Tool',
};

/**
 * Determine the originating sub-provider from the agent field.
 * @param {string} agent - Agent identifier from sandbox-agent (e.g. 'claude', 'codex')
 * @returns {string}
 */
function resolveSubProvider(agent) {
  if (!agent) return PROVIDER;
  const lower = agent.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex') || lower.includes('openai')) return 'codex';
  if (lower.includes('cursor')) return 'cursor';
  return PROVIDER;
}

function formatToolKindLabel(kind) {
  if (!kind || typeof kind !== 'string') {
    return '';
  }

  const normalized = kind.trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (ACP_TOOL_KIND_LABELS[normalized]) {
    return ACP_TOOL_KIND_LABELS[normalized];
  }

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function derivePermissionReplies(options) {
  if (!Array.isArray(options)) {
    return [];
  }

  const replies = new Set();
  for (const option of options) {
    const kind =
      typeof option?.kind === 'string' && option.kind.trim()
        ? option.kind.trim().toLowerCase()
        : '';

    if (kind === 'allow_once') {
      replies.add('once');
    } else if (kind === 'allow_always') {
      replies.add('always');
    } else if (kind === 'reject_once' || kind === 'reject_always') {
      replies.add('reject');
    }
  }

  return Array.from(replies);
}

export function coalesceHistoryMessages(messages, sessionId) {
  const coalesced = [];
  let pendingUser = null;
  let pendingAssistant = null;

  const flushUser = () => {
    if (!pendingUser?.content) {
      pendingUser = null;
      return;
    }

    coalesced.push(
      createNormalizedMessage({
        id: pendingUser.id,
        sessionId,
        timestamp: pendingUser.timestamp,
        provider: pendingUser.provider,
        kind: 'text',
        role: 'user',
        content: pendingUser.content,
      }),
    );
    pendingUser = null;
  };

  const flushAssistant = () => {
    if (!pendingAssistant?.content) {
      pendingAssistant = null;
      return;
    }

    coalesced.push(
      createNormalizedMessage({
        id: pendingAssistant.id,
        sessionId,
        timestamp: pendingAssistant.timestamp,
        provider: pendingAssistant.provider,
        kind: 'text',
        role: 'assistant',
        content: pendingAssistant.content,
      }),
    );
    pendingAssistant = null;
  };

  for (const msg of messages) {
    if (msg.kind === 'text' && msg.role === 'user') {
      flushAssistant();
      if (!pendingUser) {
        pendingUser = {
          id: `${msg.id || 'e2b_user'}_coalesced`,
          timestamp: msg.timestamp,
          provider: msg.provider,
          content: '',
        };
      }
      pendingUser.content += msg.content || '';
      continue;
    }

    if (msg.kind === 'stream_delta') {
      flushUser();
      if (!pendingAssistant) {
        pendingAssistant = {
          id: `${msg.id || 'e2b_assistant'}_coalesced`,
          timestamp: msg.timestamp,
          provider: msg.provider,
          content: '',
        };
      }
      pendingAssistant.content += msg.content || '';
      continue;
    }

    if (msg.kind === 'complete') {
      // E2B event history can contain extra completion control frames around a
      // single prompt turn. They are not rendered in the UI and should not
      // split a single assistant response into multiple text messages.
      continue;
    }

    flushUser();
    flushAssistant();
    coalesced.push(msg);
  }

  flushUser();
  flushAssistant();

  return coalesced;
}

export function normalizeE2BToolCall(toolCall, fallbackId = '') {
  const legacyName =
    typeof toolCall?.name === 'string' && toolCall.name.trim()
      ? toolCall.name.trim()
      : typeof toolCall?.tool === 'string' && toolCall.tool.trim()
        ? toolCall.tool.trim()
        : '';

  const toolKind =
    typeof toolCall?.kind === 'string' && toolCall.kind.trim()
      ? toolCall.kind.trim()
      : '';

  const toolTitle =
    typeof toolCall?.title === 'string' && toolCall.title.trim()
      ? toolCall.title.trim()
      : '';

  const toolName = legacyName || formatToolKindLabel(toolKind) || toolTitle || 'unknown';
  const toolInput = toolCall?.rawInput ?? toolCall?.input ?? toolCall?.arguments ?? {};
  const toolId = toolCall?.toolCallId || toolCall?.id || fallbackId;

  return {
    toolName,
    toolInput,
    toolId,
    toolKind: toolKind || null,
    toolTitle: toolTitle || null,
  };
}

export function buildE2BPermissionContext(request) {
  const normalized = normalizeE2BToolCall(request?.toolCall, request?.id || '');
  return {
    availableReplies: derivePermissionReplies(request?.options),
    options: request?.options,
    toolKind: normalized.toolKind,
    toolTitle: normalized.toolTitle,
    toolCallId: normalized.toolId || null,
  };
}

/**
 * Convert a sandbox-agent SessionEvent into NormalizedMessage(s).
 *
 * SessionEvent shape:
 *   { id, eventIndex, sessionId, createdAt, connectionId, sender, payload }
 *
 * payload is an ACP JSON-RPC envelope (notification or response).
 * For session/update notifications, payload.params contains SessionUpdate objects.
 *
 * @param {object} event - sandbox-agent SessionEvent
 * @param {string} sessionId - claudecodeui session ID
 * @param {string} [agent] - Agent name for sub-provider resolution
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeEvent(event, sessionId, agent) {
  const messages = [];
  const payload = event.payload;
  const provider = resolveSubProvider(agent);
  const ts = event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString();

  if (!payload) return messages;

  // ACP notification: session/update
  if (payload.method === 'session/update' && payload.params) {
    const update =
      payload.params?.update && typeof payload.params.update === 'object'
        ? payload.params.update
        : payload.params;
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case 'agent_message_chunk': {
        const content = extractTextFromContent(update.content);
        if (content) {
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'stream_delta',
            content,
          }));
        }
        break;
      }

      case 'user_message_chunk': {
        const content = extractTextFromContent(update.content);
        if (content) {
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'text',
            role: 'user',
            content,
          }));
        }
        break;
      }

      case 'agent_thought_chunk': {
        const content = extractTextFromContent(update.content);
        if (content) {
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'thinking',
            content,
          }));
        }
        break;
      }

      case 'tool_call': {
        const toolCall = update.toolCall;
        if (toolCall) {
          const normalizedTool = normalizeE2BToolCall(toolCall, event.id);
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'tool_use',
            toolName: normalizedTool.toolName,
            toolInput: normalizedTool.toolInput,
            toolId: normalizedTool.toolId,
          }));
        }
        break;
      }

      case 'tool_call_update': {
        const toolUpdate = update.toolCallUpdate || update;
        const toolId = toolUpdate.id || toolUpdate.toolCallId;
        const status = toolUpdate.status;

        // If completed with content, emit tool_result
        if (status === 'completed' || toolUpdate.content) {
          const content = extractToolContent(toolUpdate.content);
          messages.push(createNormalizedMessage({
            id: `${event.id || ''}_result`,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'tool_result',
            toolId,
            content: content || '',
            isError: status === 'error',
          }));
        }
        break;
      }

      case 'plan': {
        const planContent = update.plan?.entries?.map(e =>
          `[${e.status || 'pending'}] ${e.title || e.description || ''}`
        ).join('\n') || JSON.stringify(update.plan);
        messages.push(createNormalizedMessage({
          id: event.id || undefined,
          sessionId,
          timestamp: ts,
          provider,
          kind: 'status',
          text: planContent,
        }));
        break;
      }

      case 'usage_update': {
        messages.push(createNormalizedMessage({
          id: event.id || undefined,
          sessionId,
          timestamp: ts,
          provider,
          kind: 'status',
          text: `Tokens: ${JSON.stringify(update.usage || update)}`,
          tokens: update.usage,
        }));
        break;
      }

      case 'session_info_update':
      case 'config_option_update':
      case 'current_mode_update':
      case 'available_commands_update':
        // Metadata updates, skip or emit as status
        break;

      default:
        // Unknown update type, emit raw as status
        if (updateType) {
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'status',
            text: `[${updateType}] ${JSON.stringify(update).slice(0, 200)}`,
          }));
        }
        break;
    }
  }

  // ACP notification: session/requestPermission
  if (payload.method === 'session/requestPermission' && payload.params) {
    const perm = payload.params;
    const normalizedTool = normalizeE2BToolCall(perm.toolCall, event.id);
    messages.push(createNormalizedMessage({
      id: event.id || undefined,
      sessionId,
      timestamp: ts,
      provider,
      kind: 'permission_request',
      requestId: perm.id || event.id,
      toolName: normalizedTool.toolName,
      input: normalizedTool.toolInput,
      context: {
        ...buildE2BPermissionContext(perm),
        rawRequest: perm,
      },
    }));
  }

  // ACP response with result (prompt completion)
  if (payload.result !== undefined && !payload.method) {
    // Prompt completed
    messages.push(createNormalizedMessage({
      id: event.id || undefined,
      sessionId,
      timestamp: ts,
      provider,
      kind: 'complete',
    }));
  }

  return messages;
}

/**
 * Extract text from ACP Content/ContentBlock arrays.
 * @param {any} content
 * @returns {string}
 */
function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content?.text === 'string') return content.text;
  if (typeof content?.content === 'string') return content.content;

  // ACP ContentChunk has { content: ContentBlock[] }
  const blocks = Array.isArray(content)
    ? content
    : Array.isArray(content.content)
      ? content.content
      : Array.isArray(content.blocks)
        ? content.blocks
        : Array.isArray(content.items)
          ? content.items
          : content.type === 'content' && Array.isArray(content.content)
            ? content.content
            : [];
  if (!Array.isArray(blocks)) {
    if (typeof blocks === 'string') return blocks;
    return '';
  }

  return blocks
    .map((block) => extractTextFromContent(block))
    .filter(Boolean)
    .join('');
}

/**
 * Extract content from tool call results.
 * @param {any} content
 * @returns {string}
 */
function extractToolContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;

  // ToolCallContent can be { type: 'content', content: [...] } or { type: 'diff', diff: ... }
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === 'content' && c.content) {
        return extractTextFromContent(c.content);
      }
      if (c.type === 'diff' && c.diff) {
        return `--- ${c.diff.path || ''}\n${c.diff.content || JSON.stringify(c.diff)}`;
      }
      if (c.type === 'text') return c.text || '';
      return JSON.stringify(c);
    }).join('\n');
  }

  return JSON.stringify(content);
}

function paginateMessages(messages, { limit = null, offset = 0 } = {}) {
  if (limit === null || limit === undefined) {
    return {
      messages,
      total: messages.length,
      hasMore: false,
      offset: 0,
      limit: null,
    };
  }

  const safeLimit = Math.max(0, Number(limit) || 0);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const total = messages.length;
  const startIndex = Math.max(0, total - safeOffset - safeLimit);
  const endIndex = Math.max(startIndex, total - safeOffset);

  return {
    messages: messages.slice(startIndex, endIndex),
    total,
    hasMore: startIndex > 0,
    offset: safeOffset,
    limit: safeLimit,
  };
}

function parsePersistedMessageRow(row) {
  if (typeof row?.message_json !== 'string' || !row.message_json.trim()) {
    return null;
  }

  try {
    return JSON.parse(row.message_json);
  } catch {
    return null;
  }
}

async function fetchPersistedHistory(sessionId, opts = {}) {
  const { e2bSessionMessagesDb } = await import('../../database/db.js');
  const rows = e2bSessionMessagesDb.getBySessionId(sessionId);
  const persisted = rows
    .map(parsePersistedMessageRow)
    .filter((message) => message && typeof message === 'object');

  if (persisted.length === 0) {
    return null;
  }

  const coalesced = coalesceHistoryMessages(persisted, sessionId);
  return paginateMessages(coalesced, opts);
}

/**
 * Fetch session history from sandbox-agent.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {Promise<import('../types.js').FetchHistoryResult>}
 */
export async function fetchHistory(sessionId, opts = {}) {
  const { getSandboxClient, ensureSandboxConnected } = await import('./sandbox-manager.js');
  const { e2bSessionDb, e2bSessionMessagesDb } = await import('../../database/db.js');
  const { extractSandboxIdFromProjectName } = await import('./project-utils.js');

  const persisted = await fetchPersistedHistory(sessionId, opts);
  if (persisted) {
    return persisted;
  }

  const sandboxId =
    extractSandboxIdFromProjectName(opts.projectName || '') ||
    e2bSessionDb.getBySessionId(sessionId)?.sandbox_id ||
    null;

  if (sandboxId) {
    await ensureSandboxConnected(sandboxId);
  }

  const client = getSandboxClient();

  if (!client) {
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  }

  try {
    const session = await client.getSession(sessionId);
    if (!session) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const eventsPage = await client.getEvents({ sessionId, limit: 500 });
    const sortedEvents = [...eventsPage.items].sort((left, right) => {
      const leftIndex = typeof left?.eventIndex === 'number' ? left.eventIndex : Number.MAX_SAFE_INTEGER;
      const rightIndex = typeof right?.eventIndex === 'number' ? right.eventIndex : Number.MAX_SAFE_INTEGER;

      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      const leftTs = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTs = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
      return leftTs - rightTs;
    });
    const normalized = [];

    for (const event of sortedEvents) {
      const msgs = normalizeEvent(event, sessionId, session.agent);
      normalized.push(...msgs);
    }

    const mergedHistory = coalesceHistoryMessages(normalized, sessionId);

    for (const message of mergedHistory) {
      e2bSessionMessagesDb.append(sessionId, message);
    }

    return paginateMessages(mergedHistory, opts);
  } catch (error) {
    console.error('[E2B] Error fetching history:', error.message);
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  }
}

async function loadHistorySnapshot(sessionId, opts = {}) {
  const history = await fetchHistory(sessionId, {
    ...opts,
    limit: null,
    offset: 0,
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const oldestId = messages[0]?.id || '';
  const newestId = messages[messages.length - 1]?.id || '';

  return {
    messages,
    tokenUsage: history?.tokenUsage || null,
    fingerprint: `e2b:${sessionId}:${messages.length}:${oldestId}:${newestId}`,
  };
}

export const e2bAdapter = {
  fetchHistory,
  loadHistorySnapshot,
  normalizeMessage: normalizeEvent,
};
