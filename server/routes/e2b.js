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
  resumeSandbox,
  destroySandbox,
  disposeSandbox,
  listSandboxAgents,
  getSandboxStatus,
  getSandboxClient,
} from '../providers/e2b/sandbox-manager.js';
import {
  createE2BSession,
  sendMessageToE2BSession,
  respondE2BPermission,
  abortE2BSession,
  isE2BSessionActive,
  getActiveE2BSessions,
} from '../providers/e2b/session-bridge.js';
import { e2bSandboxDb, credentialsDb } from '../database/db.js';

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
    const sandboxId = await pauseSandbox();
    // Update DB record
    if (sandboxId) {
      e2bSandboxDb.updateStatus(sandboxId, 'paused');
    }
    res.json({ success: true, sandboxId });
  } catch (error) {
    console.error('[E2B Route] Pause sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/resume', async (req, res) => {
  try {
    const { sandboxId } = req.body || {};
    if (!sandboxId) {
      return res.status(400).json({ success: false, error: 'sandboxId is required' });
    }
    await resumeSandbox(sandboxId);
    e2bSandboxDb.updateStatus(sandboxId, 'running');
    res.json({ success: true, ...getSandboxStatus() });
  } catch (error) {
    console.error('[E2B Route] Resume sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/destroy', async (req, res) => {
  try {
    const status = getSandboxStatus();
    await destroySandbox();
    if (status.sandboxId) {
      e2bSandboxDb.updateStatus(status.sandboxId, 'destroyed');
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Destroy sandbox error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create sandbox initialized with a GitHub repo.
 */
router.post('/sandbox/create-with-repo', async (req, res) => {
  try {
    const { repoUrl, branch, template, envs: extraEnvs } = req.body || {};
    if (!repoUrl) {
      return res.status(400).json({ success: false, error: 'repoUrl is required' });
    }

    // Resolve GitHub token for private repos
    const githubToken = credentialsDb.getActiveCredential(req.user.id, 'github_oauth');
    const envs = { ...extraEnvs };
    if (githubToken) {
      envs.GITHUB_TOKEN = githubToken;
    }

    // Create sandbox
    const client = await createSandbox({ template, envs });

    // Build clone URL with token for private repos
    let cloneUrl = repoUrl;
    if (githubToken && repoUrl.startsWith('https://github.com/')) {
      cloneUrl = repoUrl.replace('https://github.com/', `https://x-access-token:${githubToken}@github.com/`);
    }

    // Extract repo name from URL
    const repoName = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'repo';
    const workspacePath = `/home/user/${repoName}`;
    const branchArg = branch ? `--branch ${branch}` : '';

    // Run git clone inside sandbox
    console.log(`[E2B] Cloning ${repoUrl} (branch: ${branch || 'default'}) into sandbox...`);
    await client.runProcess({
      cmd: ['bash', '-c', `git clone ${branchArg} '${cloneUrl}' '${workspacePath}' 2>&1`],
    });
    console.log(`[E2B] Clone complete: ${workspacePath}`);

    // Save sandbox record
    const status = getSandboxStatus();
    e2bSandboxDb.create(req.user.id, status.sandboxId, {
      repoUrl,
      branch: branch || 'main',
      workspacePath,
    });

    res.json({
      success: true,
      sandboxId: status.sandboxId,
      workspacePath,
      inspectorUrl: status.inspectorUrl,
    });
  } catch (error) {
    console.error('[E2B Route] Create with repo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * List user's saved sandboxes.
 */
router.get('/sandboxes', (req, res) => {
  try {
    const sandboxes = e2bSandboxDb.getActive(req.user.id);
    res.json({ success: true, sandboxes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Trigger git commit + push inside the active sandbox.
 */
router.post('/sandbox/git-save', async (req, res) => {
  try {
    const client = getSandboxClient();
    if (!client) {
      return res.status(400).json({ success: false, error: 'No active sandbox' });
    }

    const { workspacePath, commitMessage } = req.body || {};
    const cwd = workspacePath || '/home/user';
    const message = commitMessage || `auto-save ${new Date().toISOString()}`;

    const result = await client.runProcess({
      cmd: ['bash', '-c', `cd '${cwd}' && git add -A && git diff --cached --quiet || git commit -m '${message.replace(/'/g, "'\\''")}' && git push 2>&1`],
    });

    res.json({ success: true, output: result.stdout || '' });
  } catch (error) {
    console.error('[E2B Route] Git save error:', error);
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
