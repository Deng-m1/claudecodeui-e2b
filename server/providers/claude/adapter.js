/**
 * Claude provider adapter.
 *
 * Normalizes Claude SDK session history into NormalizedMessage format.
 * @module adapters/claude
 */

import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { isInternalContent } from '../utils.js';

const PROVIDER = 'claude';
const snapshotCache = new Map();

function buildClaudeCacheKey(sessionId, projectName) {
  return `${projectName || ''}::${sessionId}`;
}

async function statSignature(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

async function parseAgentTools(filePath) {
  const tools = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
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
        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content.map((item) => item.text || '').join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } catch (error) {
    console.warn(`[ClaudeAdapter] Failed to parse agent file ${filePath}:`, error.message);
  }

  return tools;
}

async function loadClaudeRawMessages(projectName, sessionId) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const sessionFilePath = path.join(projectDir, `${sessionId}.jsonl`);

  const rawMessages = [];
  const agentIds = new Set();

  try {
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
        rawMessages.push(entry);

        if (entry.toolUseResult?.agentId) {
          agentIds.add(entry.toolUseResult.agentId);
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        rawMessages: [],
        sessionFilePath,
        agentFilePaths: [],
      };
    }
    throw error;
  }

  const agentFilePaths = [];
  const agentToolsCache = new Map();
  for (const agentId of agentIds) {
    const filePath = path.join(projectDir, `agent-${agentId}.jsonl`);
    try {
      await fs.access(filePath);
      agentFilePaths.push(filePath);
      const tools = await parseAgentTools(filePath);
      if (tools.length > 0) {
        agentToolsCache.set(agentId, tools);
      }
    } catch {
      // Ignore missing agent files.
    }
  }

  for (const entry of rawMessages) {
    if (!entry.toolUseResult?.agentId) {
      continue;
    }

    const tools = agentToolsCache.get(entry.toolUseResult.agentId);
    if (tools?.length) {
      entry.subagentTools = tools;
    }
  }

  rawMessages.sort((left, right) => {
    return new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime();
  });

  return {
    rawMessages,
    sessionFilePath,
    agentFilePaths,
  };
}

function normalizeClaudeRawMessages(rawMessages, sessionId) {
  const toolResultMap = new Map();
  for (const raw of rawMessages) {
    if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
      for (const part of raw.message.content) {
        if (part.type === 'tool_result') {
          toolResultMap.set(part.tool_use_id, {
            content: part.content,
            isError: Boolean(part.is_error),
            timestamp: raw.timestamp,
            subagentTools: raw.subagentTools,
            toolUseResult: raw.toolUseResult,
          });
        }
      }
    }
  }

  const normalized = [];
  for (const raw of rawMessages) {
    const entries = normalizeMessage(raw, sessionId);
    normalized.push(...entries);
  }

  for (const msg of normalized) {
    if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
      const tr = toolResultMap.get(msg.toolId);
      msg.toolResult = {
        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        isError: tr.isError,
        toolUseResult: tr.toolUseResult,
      };
      msg.subagentTools = tr.subagentTools;
    }
  }

  return normalized;
}

async function buildClaudeFingerprint(sessionFilePath, agentFilePaths = []) {
  const signatures = [await statSignature(sessionFilePath)];
  for (const filePath of agentFilePaths) {
    signatures.push(await statSignature(filePath));
  }
  return signatures.join('|');
}

async function loadHistorySnapshot(sessionId, opts = {}) {
  const { projectName = '' } = opts;
  if (!projectName) {
    return { messages: [], tokenUsage: null, fingerprint: 'claude:missing-project' };
  }

  const cacheKey = buildClaudeCacheKey(sessionId, projectName);
  const cached = snapshotCache.get(cacheKey);
  if (cached) {
    const currentFingerprint = await buildClaudeFingerprint(cached.sessionFilePath, cached.agentFilePaths);
    if (currentFingerprint === cached.fingerprint) {
      return {
        messages: cached.messages,
        tokenUsage: null,
        fingerprint: cached.fingerprint,
      };
    }
  }

  const { rawMessages, sessionFilePath, agentFilePaths } = await loadClaudeRawMessages(projectName, sessionId);
  const normalized = normalizeClaudeRawMessages(rawMessages, sessionId);
  const fingerprint = await buildClaudeFingerprint(sessionFilePath, agentFilePaths);

  snapshotCache.set(cacheKey, {
    fingerprint,
    messages: normalized,
    sessionFilePath,
    agentFilePaths,
  });

  return {
    messages: normalized,
    tokenUsage: null,
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
 * Normalize a raw JSONL message or realtime SDK event into NormalizedMessage(s).
 * Handles both history entries (JSONL `{ message: { role, content } }`) and
 * realtime streaming events (`content_block_delta`, `content_block_stop`, etc.).
 * @param {object} raw - A single entry from JSONL or a live SDK event
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  if (raw.type === 'content_block_delta' && raw.delta?.text) {
    return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
  }
  if (raw.type === 'content_block_stop') {
    return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
  }

  const messages = [];
  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.uuid || generateMessageId('claude');

  if (raw.message?.role === 'user' && raw.message?.content) {
    if (Array.isArray(raw.message.content)) {
      for (const part of raw.message.content) {
        if (part.type === 'tool_result') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr_${part.tool_use_id}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId: part.tool_use_id,
            content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            isError: Boolean(part.is_error),
            subagentTools: raw.subagentTools,
            toolUseResult: raw.toolUseResult,
          }));
        } else if (part.type === 'text') {
          const text = part.text || '';
          if (text && !isInternalContent(text)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: text,
            }));
          }
        }
      }

      if (messages.length === 0) {
        const textParts = raw.message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .filter(Boolean)
          .join('\n');
        if (textParts && !isInternalContent(textParts)) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_text`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: textParts,
          }));
        }
      }
    } else if (typeof raw.message.content === 'string') {
      const text = raw.message.content;
      if (text && !isInternalContent(text)) {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'user',
          content: text,
        }));
      }
    }
    return messages;
  }

  if (raw.type === 'thinking' && raw.message?.content) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'thinking',
      content: raw.message.content,
    }));
    return messages;
  }

  if (raw.type === 'tool_use' && raw.toolName) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: raw.toolName,
      toolInput: raw.toolInput,
      toolId: raw.toolCallId || baseId,
    }));
    return messages;
  }

  if (raw.type === 'tool_result') {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: raw.toolCallId || '',
      content: raw.output || '',
      isError: false,
    }));
    return messages;
  }

  if (raw.message?.role === 'assistant' && raw.message?.content) {
    if (Array.isArray(raw.message.content)) {
      let partIndex = 0;
      for (const part of raw.message.content) {
        if (part.type === 'text' && part.text) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: part.text,
          }));
        } else if (part.type === 'tool_use') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: part.name,
            toolInput: part.input,
            toolId: part.id,
          }));
        } else if (part.type === 'thinking' && part.thinking) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: part.thinking,
          }));
        }
        partIndex += 1;
      }
    } else if (typeof raw.message.content === 'string') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content: raw.message.content,
      }));
    }
    return messages;
  }

  return messages;
}

export const claudeAdapter = {
  normalizeMessage,
  loadHistorySnapshot,

  async fetchHistory(sessionId, opts = {}) {
    const { limit = null, offset = 0 } = opts;

    try {
      const snapshot = await loadHistorySnapshot(sessionId, opts);
      return paginateMessages(snapshot.messages || [], limit, offset);
    } catch (error) {
      console.warn(`[ClaudeAdapter] Failed to load session ${sessionId}:`, error.message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  },
};
