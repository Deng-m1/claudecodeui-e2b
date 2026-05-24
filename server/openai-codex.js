/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex } from '@openai/codex-sdk';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { codexAdapter } from './providers/codex/adapter.js';
import { mapPermissionModeToCodexOptions } from './providers/codex/permissions.js';
import { createNormalizedMessage } from './providers/types.js';

// Track active sessions
const activeCodexSessions = new Map();

const DEFAULT_CODEX_FEATURE_TOGGLES = {
  multiAgent: true,
  parallelFanOut: true,
  reasoningSummaries: true,
  shellTool: true,
  webSearch: true,
  networkAccess: true,
};

function createPendingSessionKey() {
  return `codex-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function moveActiveCodexSession(previousKey, nextKey) {
  if (!previousKey || !nextKey || previousKey === nextKey) {
    return nextKey;
  }

  const session = activeCodexSessions.get(previousKey);
  if (!session) {
    return nextKey;
  }

  activeCodexSessions.delete(previousKey);
  activeCodexSessions.set(nextKey, session);
  return nextKey;
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

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

function buildCodexClientOptions(featureToggles) {
  return {
    config: {
      features: {
        multi_agent: featureToggles.multiAgent,
        enable_fanout: featureToggles.parallelFanOut,
        shell_tool: featureToggles.shellTool,
      },
    },
  };
}

function buildCodexThreadOptions({ workingDirectory, sandboxMode, approvalPolicy, model, featureToggles }) {
  return {
    workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy,
    model,
    modelReasoningEffort: featureToggles.reasoningSummaries ? undefined : 'minimal',
    webSearchEnabled: featureToggles.webSearch,
    networkAccessEnabled: featureToggles.networkAccess,
  };
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    permissionMode = 'bypassPermissions',
    featureToggles = DEFAULT_CODEX_FEATURE_TOGGLES,
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const resolvedFeatureToggles = normalizeCodexFeatureToggles(featureToggles);

  let codex;
  let thread;
  let currentSessionId = sessionId || null;
  let activeSessionKey = sessionId || createPendingSessionKey();
  let terminalFailure = null;
  let sessionCreatedSent = false;
  const abortController = new AbortController();

  try {
    // Initialize Codex SDK
    codex = new Codex(buildCodexClientOptions(resolvedFeatureToggles));

    // Thread options with sandbox, approval, and feature settings
    const threadOptions = buildCodexThreadOptions({
      workingDirectory,
      sandboxMode,
      approvalPolicy,
      model,
      featureToggles: resolvedFeatureToggles,
    });

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Track the session
    activeCodexSessions.set(activeSessionKey, {
      thread,
      codex,
      writer: ws,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString()
    });

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(command, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started') {
        const realSessionId = event.thread_id || thread.id || null;

        if (realSessionId) {
          currentSessionId = realSessionId;
          activeSessionKey = moveActiveCodexSession(activeSessionKey, realSessionId);

          if (ws?.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(realSessionId);
          }

          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({
              kind: 'session_created',
              newSessionId: realSessionId,
              sessionId: realSessionId,
              provider: 'codex'
            }));
          }
        }
      }

      // Check if session was aborted
      const session = activeCodexSessions.get(activeSessionKey);
      if (!session || session.status === 'aborted') {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = transformCodexEvent(event);

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = codexAdapter.normalizeMessage(transformed, currentSessionId);
      for (const msg of normalizedMsgs) {
        sendMessage(ws, msg);
      }

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: currentSessionId || sessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
      }

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed' && event.usage) {
        const totalTokens = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
        sendMessage(ws, createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: { used: totalTokens, total: 200000 },
          sessionId: currentSessionId,
          provider: 'codex'
        }));
      }
    }

    // Send completion event
    if (!terminalFailure) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'complete',
        actualSessionId: thread.id || currentSessionId || null,
        sessionId: currentSessionId,
        provider: 'codex'
      }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: currentSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }

  } catch (error) {
    const session = activeCodexSessions.get(activeSessionKey);
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: error.message,
        sessionId: currentSessionId || sessionId || null,
        provider: 'codex'
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: currentSessionId || sessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    // Update session status
    const session = activeCodexSessions.get(activeSessionKey);
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

export function reconnectCodexSessionWriter(sessionId, newRawWs) {
  const session = activeCodexSessions.get(sessionId);
  if (!session?.writer?.updateWebSocket) {
    return false;
  }

  session.writer.updateWebSocket(newRawWs);
  return true;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
