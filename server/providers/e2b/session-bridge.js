/**
 * E2B Session Bridge
 *
 * Bridges sandbox-agent sessions with claudecodeui's WebSocket streaming.
 * Manages creating sessions inside E2B sandboxes, streaming events to
 * connected WebSocket clients, and handling tool approval/permission flows.
 *
 * @module providers/e2b/session-bridge
 */

import { getSandboxClient, createSandbox, isE2BEnabled } from './sandbox-manager.js';
import { normalizeEvent } from './adapter.js';
import { createNormalizedMessage } from '../types.js';

/** @type {Map<string, { session: any, unsubEvent: Function, unsubPerm: Function, agent: string }>} */
const activeBridgedSessions = new Map();

/**
 * Ensure the sandbox is ready before creating sessions.
 * @returns {Promise<import('sandbox-agent').SandboxAgent>}
 */
async function ensureSandbox() {
  let client = getSandboxClient();
  if (!client) {
    client = await createSandbox();
  }
  return client;
}

/**
 * Start a new agent session inside the E2B sandbox and bridge events to WebSocket.
 *
 * @param {string} sessionId - claudecodeui session ID
 * @param {object} options
 * @param {string} options.agent - Agent to use ('claude-code' | 'codex' | 'opencode' | 'cursor' | 'amp')
 * @param {string} [options.cwd] - Working directory inside the sandbox
 * @param {string} [options.model] - Model override
 * @param {WebSocket} [options.ws] - WebSocket to stream events to
 * @param {Function} [options.onMessage] - Callback for each NormalizedMessage
 * @returns {Promise<{ sessionId: string, agentSessionId: string }>}
 */
export async function createE2BSession(sessionId, options) {
  const { agent, cwd, model, ws, onMessage } = options;
  const client = await ensureSandbox();

  // Map claudecodeui provider names to sandbox-agent agent IDs
  const agentId = mapProviderToAgent(agent);

  console.log(`[E2B Bridge] Creating session: ${sessionId}, agent: ${agentId}`);

  const sessionOpts = { agent: agentId };
  if (cwd) sessionOpts.cwd = cwd;

  const session = await client.createSession(sessionOpts);

  if (model) {
    try {
      await session.setModel(model);
    } catch (e) {
      console.warn(`[E2B Bridge] Could not set model ${model}:`, e.message);
    }
  }

  // Subscribe to events and bridge to WebSocket / callback
  const unsubEvent = session.onEvent((event) => {
    const normalized = normalizeEvent(event, sessionId, agentId);
    for (const msg of normalized) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
      if (onMessage) {
        onMessage(msg);
      }
    }
  });

  // Subscribe to permission requests
  const unsubPerm = session.onPermissionRequest((request) => {
    const permMsg = createNormalizedMessage({
      sessionId,
      provider: 'e2b',
      kind: 'permission_request',
      requestId: request.id,
      toolName: request.toolCall?.name || request.toolCall?.tool || 'unknown',
      input: request.toolCall?.input || request.toolCall?.arguments || {},
      context: {
        availableReplies: request.availableReplies,
        options: request.options,
      },
    });

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(permMsg));
    }
    if (onMessage) {
      onMessage(permMsg);
    }
  });

  activeBridgedSessions.set(sessionId, {
    session,
    unsubEvent,
    unsubPerm,
    agent: agentId,
  });

  console.log(`[E2B Bridge] Session created: ${sessionId} -> ${session.agentSessionId}`);

  return {
    sessionId,
    agentSessionId: session.agentSessionId,
  };
}

/**
 * Send a prompt/message to an active E2B session.
 *
 * @param {string} sessionId
 * @param {string} message - User message text
 * @returns {Promise<void>}
 */
export async function sendMessageToE2BSession(sessionId, message) {
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged) {
    throw new Error(`No active E2B session: ${sessionId}`);
  }

  console.log(`[E2B Bridge] Sending message to session ${sessionId}`);
  await bridged.session.prompt([{ type: 'text', text: message }]);
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
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged) {
    throw new Error(`No active E2B session: ${sessionId}`);
  }

  const client = getSandboxClient();
  if (!client) {
    throw new Error('No active E2B sandbox');
  }

  await client.respondPermission(permissionId, reply);
}

/**
 * Abort/destroy an E2B session.
 *
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function abortE2BSession(sessionId) {
  const bridged = activeBridgedSessions.get(sessionId);
  if (!bridged) return;

  console.log(`[E2B Bridge] Aborting session: ${sessionId}`);

  bridged.unsubEvent();
  bridged.unsubPerm();

  const client = getSandboxClient();
  if (client) {
    try {
      await client.destroySession(sessionId);
    } catch (e) {
      console.warn(`[E2B Bridge] Error destroying session:`, e.message);
    }
  }

  activeBridgedSessions.delete(sessionId);
}

/**
 * Check if an E2B session is active.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isE2BSessionActive(sessionId) {
  return activeBridgedSessions.has(sessionId);
}

/**
 * Get all active E2B session IDs.
 * @returns {string[]}
 */
export function getActiveE2BSessions() {
  return Array.from(activeBridgedSessions.keys());
}

/**
 * Map claudecodeui provider names to sandbox-agent agent IDs.
 * @param {string} provider
 * @returns {string}
 */
function mapProviderToAgent(provider) {
  const mapping = {
    'claude': 'claude-code',
    'claude-code': 'claude-code',
    'codex': 'codex',
    'openai-codex': 'codex',
    'opencode': 'opencode',
    'cursor': 'cursor',
    'amp': 'amp',
    'pi': 'pi',
  };
  return mapping[provider?.toLowerCase()] || provider || 'claude-code';
}

/**
 * Cleanup all active sessions (for shutdown).
 */
export async function cleanupAllE2BSessions() {
  for (const sessionId of activeBridgedSessions.keys()) {
    await abortE2BSession(sessionId);
  }
}
