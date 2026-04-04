/**
 * Gemini provider adapter.
 *
 * Normalizes Gemini CLI session history into NormalizedMessage format.
 * @module adapters/gemini
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sessionManager from '../../sessionManager.js';
import { createNormalizedMessage, generateMessageId } from '../types.js';

const PROVIDER = 'gemini';
const snapshotCache = new Map();
const sessionFileCache = new Map();

async function statSignature(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function buildMemoryFingerprint(session) {
  const messageCount = Array.isArray(session?.messages) ? session.messages.length : 0;
  const lastActivity = session?.lastActivity ? new Date(session.lastActivity).getTime() : 0;
  const createdAt = session?.createdAt ? new Date(session.createdAt).getTime() : 0;
  return `memory:${messageCount}:${lastActivity}:${createdAt}`;
}

async function resolveGeminiSessionFile(sessionId) {
  const cachedPath = sessionFileCache.get(sessionId);
  if (cachedPath) {
    try {
      await fs.access(cachedPath);
      return cachedPath;
    } catch {
      sessionFileCache.delete(sessionId);
    }
  }

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  let projectDirs = [];
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const directPath = path.join(geminiTmpDir, projectDir, 'chats', `${sessionId}.json`);
    try {
      await fs.access(directPath);
      sessionFileCache.set(sessionId, directPath);
      return directPath;
    } catch {
      // Try the slower content-based lookup below.
    }

    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles = [];
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(chatsDir, chatFile);
      try {
        const session = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const fileSessionId = session.sessionId || chatFile.replace(/\.json$/, '');
        if (fileSessionId !== sessionId) {
          continue;
        }

        sessionFileCache.set(sessionId, filePath);
        return filePath;
      } catch {
        // Ignore malformed files.
      }
    }
  }

  return null;
}

function normalizeGeminiHistoryEntries(rawMessages, sessionId) {
  const normalized = [];

  for (let index = 0; index < rawMessages.length; index += 1) {
    const raw = rawMessages[index];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('gemini');
    const role = raw.message?.role || raw.role;
    const content = raw.message?.content || raw.content;

    if (!role || !content) {
      continue;
    }

    const normalizedRole = role === 'user' ? 'user' : 'assistant';

    if (Array.isArray(content)) {
      for (let partIdx = 0; partIdx < content.length; partIdx += 1) {
        const part = content[partIdx];
        if (part.type === 'text' && part.text) {
          normalized.push(createNormalizedMessage({
            id: `${baseId}_${partIdx}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: normalizedRole,
            content: part.text,
          }));
        } else if (part.type === 'tool_use') {
          normalized.push(createNormalizedMessage({
            id: `${baseId}_${partIdx}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: part.name,
            toolInput: part.input,
            toolId: part.id || generateMessageId('gemini_tool'),
          }));
        } else if (part.type === 'tool_result') {
          normalized.push(createNormalizedMessage({
            id: `${baseId}_${partIdx}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId: part.tool_use_id || '',
            content: part.content === undefined ? '' : String(part.content),
            isError: Boolean(part.is_error),
          }));
        }
      }
    } else if (typeof content === 'string' && content.trim()) {
      normalized.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: normalizedRole,
        content,
      }));
    }
  }

  const toolResultMap = new Map();
  for (const message of normalized) {
    if (message.kind === 'tool_result' && message.toolId) {
      toolResultMap.set(message.toolId, message);
    }
  }

  for (const message of normalized) {
    if (message.kind === 'tool_use' && message.toolId && toolResultMap.has(message.toolId)) {
      const result = toolResultMap.get(message.toolId);
      message.toolResult = { content: result.content, isError: result.isError };
    }
  }

  return normalized;
}

async function loadHistorySnapshot(sessionId) {
  const memorySession = sessionManager.getSession(sessionId);
  if (memorySession) {
    const fingerprint = buildMemoryFingerprint(memorySession);
    const cached = snapshotCache.get(sessionId);

    if (cached && cached.fingerprint === fingerprint) {
      return {
        messages: cached.messages,
        tokenUsage: null,
        fingerprint,
      };
    }

    const rawMessages = sessionManager.getSessionMessages(sessionId);
    const messages = normalizeGeminiHistoryEntries(rawMessages, sessionId);
    snapshotCache.set(sessionId, { fingerprint, messages });
    return {
      messages,
      tokenUsage: null,
      fingerprint,
    };
  }

  const sessionFilePath = await resolveGeminiSessionFile(sessionId);
  const fingerprint = await statSignature(sessionFilePath);
  const cached = snapshotCache.get(sessionId);
  if (cached && cached.fingerprint === fingerprint) {
    return {
      messages: cached.messages,
      tokenUsage: null,
      fingerprint,
    };
  }

  if (!sessionFilePath) {
    return {
      messages: [],
      tokenUsage: null,
      fingerprint,
    };
  }

  const session = JSON.parse(await fs.readFile(sessionFilePath, 'utf8'));
  const rawMessages = (session.messages || []).map((message) => {
    const role = message.type === 'user'
      ? 'user'
      : (message.type === 'gemini' || message.type === 'assistant')
        ? 'assistant'
        : message.type;

    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content.filter((part) => part.text).map((part) => part.text).join('\n');
    }

    return {
      type: 'message',
      message: { role, content },
      timestamp: message.timestamp || null,
    };
  });

  const messages = normalizeGeminiHistoryEntries(rawMessages, sessionId);
  snapshotCache.set(sessionId, { fingerprint, messages });
  return {
    messages,
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
 * Normalize a realtime NDJSON event from Gemini CLI into NormalizedMessage(s).
 * Handles: message (delta/final), tool_use, tool_result, result, error.
 * @param {object} raw - A parsed NDJSON event
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.uuid || generateMessageId('gemini');

  if (raw.type === 'message' && raw.role === 'assistant') {
    const content = raw.content || '';
    const msgs = [];
    if (content) {
      msgs.push(createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'stream_delta', content }));
    }
    if (raw.delta !== true) {
      msgs.push(createNormalizedMessage({ sessionId, timestamp: ts, provider: PROVIDER, kind: 'stream_end' }));
    }
    return msgs;
  }

  if (raw.type === 'tool_use') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'tool_use', toolName: raw.tool_name, toolInput: raw.parameters || {},
      toolId: raw.tool_id || baseId,
    })];
  }

  if (raw.type === 'tool_result') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'tool_result', toolId: raw.tool_id || '',
      content: raw.output === undefined ? '' : String(raw.output),
      isError: raw.status === 'error',
    })];
  }

  if (raw.type === 'result') {
    const msgs = [createNormalizedMessage({ sessionId, timestamp: ts, provider: PROVIDER, kind: 'stream_end' })];
    if (raw.stats?.total_tokens) {
      msgs.push(createNormalizedMessage({
        sessionId, timestamp: ts, provider: PROVIDER,
        kind: 'status', text: 'Complete', tokens: raw.stats.total_tokens, canInterrupt: false,
      }));
    }
    return msgs;
  }

  if (raw.type === 'error') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'error', content: raw.error || raw.message || 'Unknown Gemini streaming error',
    })];
  }

  return [];
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const geminiAdapter = {
  normalizeMessage,
  loadHistorySnapshot,
  async fetchHistory(sessionId, opts = {}) {
    const { limit = null, offset = 0 } = opts;

    try {
      const snapshot = await loadHistorySnapshot(sessionId);
      return paginateMessages(snapshot.messages, limit, offset);
    } catch (error) {
      console.warn(`[GeminiAdapter] Failed to load session ${sessionId}:`, error.message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  },
};
