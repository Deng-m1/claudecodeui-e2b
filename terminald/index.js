#!/usr/bin/env node

import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticateToken, authenticateWebSocket } from '../server/middleware/auth.js';
import { TERMINALD_HOST, TERMINALD_PORT } from './config.js';
import {
  closeTerminalRecord,
  getProjectTerminal,
  getTerminalById,
  listProjectTerminals,
  markTerminalState,
  touchTerminal,
  upsertProjectTerminal,
} from './store.js';
import { attachTerminal, closeTerminal, resolveTerminalRecord } from './runtime/index.js';
import { resolveTerminalRuntimeContext } from './runtime/context.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin(origin, callback) {
    callback(null, origin || true);
  },
  credentials: false,
}));

function toProjectTerminalResponse(record) {
  return {
    id: record.id,
    terminalKey: record.terminalKey,
    projectName: record.projectName,
    projectRoot: record.projectRoot,
    runtime: record.runtime,
    sandboxId: record.sandboxId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAttachedAt: record.lastAttachedAt,
  };
}

function resolveProjectName(req) {
  return String(req.params.projectName || req.body?.projectName || '').trim();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'terminald' });
});

app.get('/api/terminals/projects/:projectName', authenticateToken, async (req, res) => {
  try {
    const projectName = resolveProjectName(req);
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const terminals = listProjectTerminals(req.user.id, projectName).map(toProjectTerminalResponse);
    res.json({ projectName, terminals });
  } catch (error) {
    console.error('[terminald] list terminals failed:', error);
    res.status(500).json({ error: error.message || 'Failed to list terminals' });
  }
});

app.post('/api/terminals/projects/:projectName/ensure', authenticateToken, async (req, res) => {
  try {
    const projectName = resolveProjectName(req);
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const terminalKey = typeof req.body?.terminalKey === 'string' && req.body.terminalKey.trim()
      ? req.body.terminalKey.trim()
      : 'default';

    const existing = getProjectTerminal(req.user.id, projectName, terminalKey) || {
      userId: req.user.id,
      terminalKey,
      projectName,
      projectRoot: '',
      runtime: 'local',
      sandboxId: null,
      tmuxSessionName: null,
      processId: null,
      metadata: null,
      status: 'active',
    };

    const { context, record } = await resolveTerminalRecord(projectName, req.user.id, existing, {
      projectPath: typeof req.body?.projectPath === 'string' ? req.body.projectPath : null,
    });
    const persisted = upsertProjectTerminal({
      id: record.id,
      userId: req.user.id,
      terminalKey,
      projectName,
      projectRoot: context.projectRoot,
      runtime: context.runtime,
      sandboxId: context.sandboxId,
      tmuxSessionName: record.tmuxSessionName || null,
      processId: record.processId || null,
      metadata: record.metadata || null,
      status: 'active',
    });

    res.json({ terminal: toProjectTerminalResponse(persisted) });
  } catch (error) {
    console.error('[terminald] ensure terminal failed:', error);
    res.status(500).json({ error: error.message || 'Failed to ensure terminal' });
  }
});

app.post('/api/terminals/:terminalId/close', authenticateToken, async (req, res) => {
  try {
    const terminal = getTerminalById(req.params.terminalId);
    if (!terminal || terminal.userId !== req.user.id) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    const context = await resolveTerminalRuntimeContext(terminal.projectName, { userId: req.user.id });
    await closeTerminal(terminal, context);
    const closed = closeTerminalRecord(terminal.id);
    res.json({ terminal: closed ? toProjectTerminalResponse(closed) : null });
  } catch (error) {
    console.error('[terminald] close terminal failed:', error);
    res.status(500).json({ error: error.message || 'Failed to close terminal' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

async function handleTerminalSocket(ws, user) {
  let bridge = null;
  let activeTerminalId = null;
  let resolvedContext = null;
  let isClosing = false;

  const closeBridge = async () => {
    if (!bridge) {
      return;
    }

    const currentBridge = bridge;
    bridge = null;
    try {
      await currentBridge.close?.();
    } catch {
      // Ignore attach close failures during disconnect.
    }
  };

  ws.on('message', async (rawMessage) => {
    try {
      const payload = JSON.parse(Buffer.isBuffer(rawMessage) ? rawMessage.toString('utf8') : String(rawMessage));

      if (payload.type === 'init') {
        await closeBridge();

        const projectName = String(payload.projectName || '').trim();
        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : null;
        const terminalKey = typeof payload.terminalKey === 'string' && payload.terminalKey.trim()
          ? payload.terminalKey.trim()
          : sessionId
            ? `session:${sessionId}`
            : 'default';
        const cols = Math.max(1, Math.min(Number(payload.cols) || 120, 500));
        const rows = Math.max(1, Math.min(Number(payload.rows) || 30, 200));

        if (!projectName) {
          throw new Error('projectName is required to initialize a project terminal');
        }

        const existing = getProjectTerminal(user.userId || user.id, projectName, terminalKey) || {
          userId: user.userId || user.id,
          terminalKey,
          projectName,
          projectRoot: '',
          runtime: payload.projectRuntime || 'local',
          sandboxId: null,
          tmuxSessionName: null,
          processId: null,
          metadata: null,
          status: 'active',
        };

        const { context, record } = await resolveTerminalRecord(projectName, user.userId || user.id, existing, {
          projectPath: typeof payload.projectPath === 'string' ? payload.projectPath : null,
          sessionId,
          hasSession: Boolean(payload.hasSession),
          provider: typeof payload.provider === 'string' ? payload.provider : null,
          initialCommand: typeof payload.initialCommand === 'string' ? payload.initialCommand : null,
          isPlainShell: Boolean(payload.isPlainShell),
        });
        resolvedContext = context;
        const persisted = upsertProjectTerminal({
          id: record.id,
          userId: user.userId || user.id,
          terminalKey,
          projectName,
          projectRoot: context.projectRoot,
          runtime: context.runtime,
          sandboxId: context.sandboxId,
          tmuxSessionName: record.tmuxSessionName || null,
          processId: record.processId || null,
          metadata: record.metadata || null,
          status: 'active',
          lastAttachedAt: new Date().toISOString(),
        });

        activeTerminalId = persisted.id;
        touchTerminal(persisted.id, 'active');

        bridge = await attachTerminal(persisted, context, { cols, rows });
        bridge.onReady?.((status) => {
          safeSend(ws, { type: 'ready', terminalId: persisted.id, runtime: context.runtime, ...status });
        });
        bridge.onOutput((data) => {
          safeSend(ws, { type: 'output', data });
        });
        bridge.onError?.((error) => {
          const message = typeof error?.message === 'string' ? error.message : 'Terminal bridge error';
          safeSend(ws, { type: 'output', data: `\r\n\x1b[31m${message}\x1b[0m\r\n` });
        });
        bridge.onExit((status = {}) => {
          if (activeTerminalId) {
            markTerminalState(activeTerminalId, 'stopped');
          }
          const exitCode = typeof status.exitCode === 'number' ? status.exitCode : 0;
          safeSend(ws, { type: 'output', data: `\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m\r\n` });
        });

        safeSend(ws, {
          type: 'terminal',
          terminalId: persisted.id,
          runtime: context.runtime,
          projectName,
          projectRoot: context.projectRoot,
        });
        return;
      }

      if (!bridge) {
        return;
      }

      if (payload.type === 'input' && typeof payload.data === 'string') {
        bridge.write(payload.data);
        return;
      }

      if (payload.type === 'resize') {
        const cols = Math.max(1, Math.min(Number(payload.cols) || 120, 500));
        const rows = Math.max(1, Math.min(Number(payload.rows) || 30, 200));
        bridge.resize(cols, rows);
      }
    } catch (error) {
      console.error('[terminald] websocket error:', error);
      safeSend(ws, { type: 'output', data: `\r\n\x1b[31m${error.message || 'Terminal error'}\x1b[0m\r\n` });
    }
  });

  ws.on('close', async () => {
    if (isClosing) {
      return;
    }

    isClosing = true;
    await closeBridge();
    if (activeTerminalId) {
      touchTerminal(activeTerminalId, 'active');
    }
  });

  ws.on('error', async (error) => {
    console.error('[terminald] websocket transport failure:', error);
    await closeBridge();
    if (activeTerminalId) {
      touchTerminal(activeTerminalId, 'active');
    }
  });
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/ws/project-terminal') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const user = authenticateWebSocket(token);

  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    void handleTerminalSocket(ws, user);
  });
});

server.listen(TERMINALD_PORT, TERMINALD_HOST, () => {
  console.log(`[terminald] listening on http://${TERMINALD_HOST}:${TERMINALD_PORT}`);
});
