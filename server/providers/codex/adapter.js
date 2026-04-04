/**
 * Codex (OpenAI) provider adapter.
 *
 * Normalizes Codex SDK session history into NormalizedMessage format.
 * @module adapters/codex
 */

import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createNormalizedMessage, generateMessageId } from '../types.js';

const PROVIDER = 'codex';
const sessionFileCache = new Map();
const snapshotCache = new Map();

function isVisibleCodexUserMessage(payload) {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

function extractCodexText(content) {
  if (!Array.isArray(content)) {
    return content;
  }

  return content
    .map((item) => {
      if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') {
        return item.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function tryParseJson(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeCodexToolCall(toolName, rawInput) {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
  const parsedInput = tryParseJson(rawInput);
  const lowerToolName = normalizedToolName.toLowerCase();
  const isExecCommandTool =
    lowerToolName === 'shell_command' ||
    lowerToolName === 'exec_command' ||
    lowerToolName.endsWith('.exec_command');

  if (isExecCommandTool) {
    if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
      const command =
        typeof parsedInput.command === 'string' && parsedInput.command.trim()
          ? parsedInput.command.trim()
          : typeof parsedInput.cmd === 'string' && parsedInput.cmd.trim()
            ? parsedInput.cmd.trim()
            : typeof parsedInput.commandLine === 'string' && parsedInput.commandLine.trim()
              ? parsedInput.commandLine.trim()
              : '';

      return {
        toolName: 'Bash',
        toolInput: {
          ...parsedInput,
          command,
        },
      };
    }

    const stringCommand = typeof parsedInput === 'string' ? parsedInput.trim() : '';
    return {
      toolName: 'Bash',
      toolInput: {
        command: stringCommand,
      },
    };
  }

  return {
    toolName: normalizedToolName || 'Unknown',
    toolInput: parsedInput,
  };
}

async function statSignature(filePath) {
  if (!filePath) {
    return 'codex:missing';
  }

  try {
    const stats = await fs.stat(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

async function findCodexSessionFile(dir, sessionId) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (
      entry.isFile() &&
      (
        entry.name === `${sessionId}.jsonl` ||
        entry.name.endsWith(`-${sessionId}.jsonl`)
      )
    ) {
      return path.join(dir, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const resolved = await findCodexSessionFile(path.join(dir, entry.name), sessionId);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveCodexSessionFile(sessionId) {
  const cachedPath = sessionFileCache.get(sessionId);
  if (cachedPath) {
    try {
      await fs.access(cachedPath);
      return cachedPath;
    } catch {
      sessionFileCache.delete(sessionId);
    }
  }

  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const resolved = await findCodexSessionFile(sessionsDir, sessionId);
  if (resolved) {
    sessionFileCache.set(sessionId, resolved);
  }
  return resolved;
}

async function loadCodexRawMessages(sessionId) {
  const sessionFilePath = await resolveCodexSessionFile(sessionId);
  if (!sessionFilePath) {
    return {
      rawMessages: [],
      tokenUsage: null,
      sessionFilePath: '',
    };
  }

  const rawMessages = [];
  let tokenUsage = null;
  const fileStream = fsSync.createReadStream(sessionFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
        const info = entry.payload.info;
        if (info.total_token_usage) {
          tokenUsage = {
            used: info.total_token_usage.total_tokens || 0,
            total: info.model_context_window || 200000,
          };
        }
      }

      if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload)) {
        rawMessages.push({
          type: 'user',
          timestamp: entry.timestamp,
          message: {
            role: 'user',
            content: entry.payload.message,
          },
        });
      }

      if (
        entry.type === 'response_item' &&
        entry.payload?.type === 'message' &&
        entry.payload.role === 'assistant'
      ) {
        const textContent = extractCodexText(entry.payload.content);
        if (typeof textContent === 'string' && textContent.trim()) {
          rawMessages.push({
            type: 'assistant',
            timestamp: entry.timestamp,
            message: {
              role: 'assistant',
              content: textContent,
            },
          });
        }
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
        const summaryText = entry.payload.summary
          ?.map((summary) => summary.text)
          .filter(Boolean)
          .join('\n');

        if (summaryText?.trim()) {
          rawMessages.push({
            type: 'thinking',
            timestamp: entry.timestamp,
            isReasoning: true,
            message: {
              role: 'assistant',
              content: summaryText,
            },
          });
        }
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
        const normalizedTool = normalizeCodexToolCall(entry.payload.name, entry.payload.arguments);

        rawMessages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName: normalizedTool.toolName,
          toolInput: normalizedTool.toolInput,
          toolCallId: entry.payload.call_id,
        });
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
        rawMessages.push({
          type: 'tool_result',
          timestamp: entry.timestamp,
          toolCallId: entry.payload.call_id,
          output: entry.payload.output,
        });
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
        const toolName = entry.payload.name || 'custom_tool';
        const input = entry.payload.input || '';

        if (toolName === 'apply_patch') {
          const fileMatch = input.match(/\*\*\* Update File: (.+)/);
          const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
          const lines = input.split('\n');
          const oldLines = [];
          const newLines = [];

          for (const patchLine of lines) {
            if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
              oldLines.push(patchLine.substring(1));
            } else if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
              newLines.push(patchLine.substring(1));
            }
          }

          rawMessages.push({
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName: 'Edit',
            toolInput: JSON.stringify({
              file_path: filePath,
              old_string: oldLines.join('\n'),
              new_string: newLines.join('\n'),
            }),
            toolCallId: entry.payload.call_id,
          });
        } else {
          const normalizedTool = normalizeCodexToolCall(toolName, input);
          rawMessages.push({
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName: normalizedTool.toolName,
            toolInput: normalizedTool.toolInput,
            toolCallId: entry.payload.call_id,
          });
        }
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
        rawMessages.push({
          type: 'tool_result',
          timestamp: entry.timestamp,
          toolCallId: entry.payload.call_id,
          output: entry.payload.output || '',
        });
      }
    } catch {
      // Skip malformed lines.
    }
  }

  rawMessages.sort((left, right) => {
    return new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime();
  });

  return {
    rawMessages,
    tokenUsage,
    sessionFilePath,
  };
}

/**
 * Normalize a raw Codex JSONL message into NormalizedMessage(s).
 * @param {object} raw - A single parsed message from Codex JSONL
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
function normalizeCodexHistoryEntry(raw, sessionId) {
  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.uuid || generateMessageId('codex');

  if (raw.message?.role === 'user') {
    const content = typeof raw.message.content === 'string'
      ? raw.message.content
      : Array.isArray(raw.message.content)
        ? raw.message.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n')
        : String(raw.message.content || '');
    if (!content.trim()) return [];
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'text',
      role: 'user',
      content,
    })];
  }

  if (raw.message?.role === 'assistant') {
    const content = typeof raw.message.content === 'string'
      ? raw.message.content
      : Array.isArray(raw.message.content)
        ? raw.message.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n')
        : '';
    if (!content.trim()) return [];
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'text',
      role: 'assistant',
      content,
    })];
  }

  if (raw.type === 'thinking' || raw.isReasoning) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'thinking',
      content: raw.message?.content || '',
    })];
  }

  if (raw.type === 'tool_use' || raw.toolName) {
    const normalizedTool = normalizeCodexToolCall(raw.toolName, raw.toolInput);
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: normalizedTool.toolName,
      toolInput: normalizedTool.toolInput,
      toolId: raw.toolCallId || baseId,
    })];
  }

  if (raw.type === 'tool_result') {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: raw.toolCallId || '',
      content: raw.output || '',
      isError: Boolean(raw.isError),
    })];
  }

  return [];
}

function attachToolResults(messages) {
  const toolResultMap = new Map();
  for (const message of messages) {
    if (message.kind === 'tool_result' && message.toolId) {
      toolResultMap.set(message.toolId, message);
    }
  }

  for (const message of messages) {
    if (message.kind === 'tool_use' && message.toolId && toolResultMap.has(message.toolId)) {
      const result = toolResultMap.get(message.toolId);
      message.toolResult = { content: result.content, isError: result.isError };
    }
  }

  return messages;
}

async function loadHistorySnapshot(sessionId) {
  const sessionFilePath = await resolveCodexSessionFile(sessionId);
  const fingerprint = await statSignature(sessionFilePath);
  const cached = snapshotCache.get(sessionId);

  if (cached && cached.fingerprint === fingerprint) {
    return {
      messages: cached.messages,
      tokenUsage: cached.tokenUsage,
      fingerprint,
    };
  }

  const { rawMessages, tokenUsage } = await loadCodexRawMessages(sessionId);
  const normalized = [];

  for (const rawMessage of rawMessages) {
    normalized.push(...normalizeCodexHistoryEntry(rawMessage, sessionId));
  }

  attachToolResults(normalized);
  snapshotCache.set(sessionId, {
    fingerprint,
    messages: normalized,
    tokenUsage,
  });

  return {
    messages: normalized,
    tokenUsage,
    fingerprint,
  };
}

function paginateMessages(messages, limit = null, offset = 0) {
  const total = messages.length;

  if (limit === null) {
    return {
      messages,
      total,
      hasMore: false,
      offset: 0,
      limit: null,
    };
  }

  const safeLimit = Math.max(0, Number(limit) || 0);
  const safeOffset = Math.max(0, Number(offset) || 0);
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

/**
 * Normalize a raw Codex event (history JSONL or transformed SDK event) into NormalizedMessage(s).
 * @param {object} raw - A history entry (has raw.message.role) or transformed SDK event (has raw.type)
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  if (raw.message?.role) {
    return normalizeCodexHistoryEntry(raw, sessionId);
  }

  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.uuid || generateMessageId('codex');

  if (raw.type === 'item') {
    switch (raw.itemType) {
      case 'agent_message':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'text', role: 'assistant', content: raw.message?.content || '',
        })];
      case 'reasoning':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'thinking', content: raw.message?.content || '',
        })];
      case 'command_execution':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: 'Bash', toolInput: { command: raw.command },
          toolId: baseId,
          output: raw.output, exitCode: raw.exitCode, status: raw.status,
        })];
      case 'file_change':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: 'FileChanges', toolInput: raw.changes,
          toolId: baseId, status: raw.status,
        })];
      case 'mcp_tool_call':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: raw.tool || 'MCP', toolInput: raw.arguments,
          toolId: baseId, server: raw.server, result: raw.result,
          error: raw.error, status: raw.status,
        })];
      case 'web_search':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: 'WebSearch', toolInput: { query: raw.query },
          toolId: baseId,
        })];
      case 'todo_list':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: 'TodoList', toolInput: { items: raw.items },
          toolId: baseId,
        })];
      case 'error':
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'error', content: raw.message?.content || 'Unknown error',
        })];
      default:
        return [createNormalizedMessage({
          id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
          kind: 'tool_use', toolName: raw.itemType || 'Unknown',
          toolInput: raw.item || raw, toolId: baseId,
        })];
    }
  }

  if (raw.type === 'turn_complete') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'complete',
    })];
  }

  if (raw.type === 'turn_failed') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'error', content: raw.error?.message || 'Turn failed',
    })];
  }

  return [];
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const codexAdapter = {
  normalizeMessage,
  loadHistorySnapshot,
  async fetchHistory(sessionId, opts = {}) {
    const { limit = null, offset = 0 } = opts;

    try {
      const snapshot = await loadHistorySnapshot(sessionId);
      return {
        ...paginateMessages(snapshot.messages, limit, offset),
        tokenUsage: snapshot.tokenUsage,
      };
    } catch (error) {
      console.warn(`[CodexAdapter] Failed to load session ${sessionId}:`, error.message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  },
};
