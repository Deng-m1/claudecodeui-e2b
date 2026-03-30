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

/**
 * Determine the originating sub-provider from the agent field.
 * @param {string} agent - Agent identifier from sandbox-agent (e.g. 'claude-code', 'codex')
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
    const update = payload.params;
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
          messages.push(createNormalizedMessage({
            id: event.id || undefined,
            sessionId,
            timestamp: ts,
            provider,
            kind: 'tool_use',
            toolName: toolCall.name || toolCall.tool || 'unknown',
            toolInput: toolCall.input ?? toolCall.arguments ?? {},
            toolId: toolCall.id || event.id,
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
    messages.push(createNormalizedMessage({
      id: event.id || undefined,
      sessionId,
      timestamp: ts,
      provider,
      kind: 'permission_request',
      requestId: perm.id || event.id,
      toolName: perm.toolCall?.name || perm.toolCall?.tool || 'unknown',
      input: perm.toolCall?.input || perm.toolCall?.arguments || {},
      context: perm,
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

  // ACP ContentChunk has { content: ContentBlock[] }
  const blocks = Array.isArray(content) ? content : content.content || content.blocks || [];
  if (!Array.isArray(blocks)) {
    if (typeof blocks === 'string') return blocks;
    return '';
  }

  return blocks
    .filter(b => b && (b.type === 'text' || !b.type))
    .map(b => b.text || b.content || '')
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

/**
 * Fetch session history from sandbox-agent.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {Promise<import('../types.js').FetchHistoryResult>}
 */
export async function fetchHistory(sessionId, opts = {}) {
  const { getSandboxClient } = await import('./sandbox-manager.js');
  const client = getSandboxClient();

  if (!client) {
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  }

  try {
    const session = await client.getSession(sessionId);
    if (!session) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const eventsPage = await client.getEvents({ sessionId, limit: opts.limit || 200 });
    const normalized = [];

    for (const event of eventsPage.items) {
      const msgs = normalizeEvent(event, sessionId, session.agent);
      normalized.push(...msgs);
    }

    return {
      messages: normalized,
      total: normalized.length,
      hasMore: !!eventsPage.nextCursor,
      offset: opts.offset || 0,
      limit: opts.limit || null,
    };
  } catch (error) {
    console.error('[E2B] Error fetching history:', error.message);
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  }
}

export const e2bAdapter = {
  fetchHistory,
  normalizeMessage: normalizeEvent,
};
