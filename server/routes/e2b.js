/**
 * E2B Routes
 *
 * REST API endpoints for managing E2B sandbox lifecycle,
 * sessions, and configuration.
 */

import express from 'express';
import {
  isE2BEnabled,
  createSandbox,
  connectToSandbox,
  pauseSandbox,
  destroySandbox,
  disposeSandbox,
  listSandboxAgents,
  getSandboxStatus,
} from '../providers/e2b/sandbox-manager.js';
import {
  createE2BSession,
  sendMessageToE2BSession,
  respondE2BPermission,
  abortE2BSession,
  isE2BSessionActive,
  getActiveE2BSessions,
} from '../providers/e2b/session-bridge.js';

const router = express.Router();

// --- Sandbox Lifecycle ---

router.get('/status', (req, res) => {
  res.json({
    success: true,
    enabled: isE2BEnabled(),
    ...getSandboxStatus(),
  });
});

router.post('/sandbox/create', async (req, res) => {
  try {
    const { template, envs } = req.body || {};
    await createSandbox({ template, envs });
    res.json({ success: true, ...getSandboxStatus() });
  } catch (error) {
    console.error('[E2B Route] Create sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/connect', async (req, res) => {
  try {
    const { baseUrl, token } = req.body || {};
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: 'baseUrl is required' });
    }
    await connectToSandbox({ baseUrl, token });
    res.json({ success: true, ...getSandboxStatus() });
  } catch (error) {
    console.error('[E2B Route] Connect sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/pause', async (req, res) => {
  try {
    await pauseSandbox();
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Pause sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/destroy', async (req, res) => {
  try {
    await destroySandbox();
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Destroy sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sandbox/agents', async (req, res) => {
  try {
    const agents = await listSandboxAgents();
    res.json({ success: true, agents });
  } catch (error) {
    console.error('[E2B Route] List agents error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Session Management ---

router.post('/sessions/create', async (req, res) => {
  try {
    const { sessionId, agent, cwd, model } = req.body || {};
    if (!sessionId || !agent) {
      return res.status(400).json({ success: false, error: 'sessionId and agent are required' });
    }
    const result = await createE2BSession(sessionId, { agent, cwd, model });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[E2B Route] Create session error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sessions/:sessionId/message', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body || {};
    if (!message) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }
    await sendMessageToE2BSession(sessionId, message);
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sessions/:sessionId/permission', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { permissionId, reply } = req.body || {};
    if (!permissionId || !reply) {
      return res.status(400).json({ success: false, error: 'permissionId and reply are required' });
    }
    await respondE2BPermission(sessionId, permissionId, reply);
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Permission response error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sessions/:sessionId/abort', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await abortE2BSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Abort session error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions', (req, res) => {
  res.json({
    success: true,
    sessions: getActiveE2BSessions().map(id => ({
      id,
      active: isE2BSessionActive(id),
    })),
  });
});

export default router;
