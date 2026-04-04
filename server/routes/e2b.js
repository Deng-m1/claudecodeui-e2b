/**
 * E2B Routes
 *
 * REST API endpoints for managing E2B sandbox lifecycle,
 * sessions, and configuration.
 */

import express from 'express';
import {
  isE2BEnabled,
  isE2BConfigured,
  createSandbox,
  connectToSandbox,
  pauseSandbox,
  resumeSandbox,
  destroySandbox,
  listSandboxAgents,
  getSandboxStatus,
  getSandboxClient,
  getNativeCliRuntimeStatus,
  setupGitCredentials,
} from '../providers/e2b/sandbox-manager.js';
import {
  createE2BSession,
  sendMessageToE2BSession,
  respondE2BPermission,
  abortE2BSession,
  isE2BSessionActive,
  getActiveE2BSessions,
} from '../providers/e2b/session-bridge.js';
import {
  extractE2BAuthSelectionsFromMetadata,
  getDefaultE2BAuthSelections,
  getE2BAuthOverview,
  normalizeE2BAuthSelections,
  resolveE2BAuthBundle,
  sanitizeE2BAuthSelections,
  summarizeE2BAuthBundle,
  syncE2BAuthToSandbox,
} from '../providers/e2b/auth-sync.js';
import { resolveSandboxConnectHostFromRequest } from '../providers/e2b/connect-host.js';
import { e2bSandboxDb, e2bSessionDb, e2bSessionMessagesDb, credentialsDb, sessionNamesDb, userDb } from '../database/db.js';

const router = express.Router();

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveSandboxConnectHost(req, sandboxRecord = null) {
  return resolveSandboxConnectHostFromRequest(req, sandboxRecord);
}

async function buildSandboxRuntimeContext(req, inputSelections = null, options = {}) {
  const { sandboxRecord = null, strict = true } = options;
  const overview = await getE2BAuthOverview();
  const sandboxConnectHost = resolveSandboxConnectHost(req, sandboxRecord);

  const baseSelections = sandboxRecord
    ? extractE2BAuthSelectionsFromMetadata(sandboxRecord.metadata_json, overview)
    : getDefaultE2BAuthSelections(overview);

  const normalizedSelections = inputSelections
    ? normalizeE2BAuthSelections({ ...baseSelections, ...inputSelections }, overview)
    : baseSelections;

  const authBundle = await resolveE2BAuthBundle(normalizedSelections, {
    strict,
    overview,
    userId: req.user.id,
    sandboxConnectHost,
    refreshClaudeProfiles: false,
  });

  const envs = { ...authBundle.envs };
  const githubToken = credentialsDb.getActiveCredential(req.user.id, 'github_oauth');
  if (githubToken) {
    envs.GITHUB_TOKEN = githubToken;
  }

  return {
    overview,
    authBundle,
    envs,
    authSelections: sanitizeE2BAuthSelections(normalizedSelections, overview),
    authSummary: summarizeE2BAuthBundle(authBundle),
    sandboxConnectHost,
  };
}

async function applySandboxGitIdentity(req, client) {
  const gitConfig = userDb.getGitConfig(req.user.id);
  if (!gitConfig?.git_name && !gitConfig?.git_email) {
    return;
  }

  await setupGitCredentials(client, {
    gitName: gitConfig.git_name || undefined,
    gitEmail: gitConfig.git_email || undefined,
  });
}

// --- Sandbox Lifecycle ---

router.get('/status', (req, res) => {
  res.json({
    success: true,
    configured: isE2BConfigured(),
    enabled: isE2BEnabled(),
    ...getSandboxStatus(),
  });
});

router.get('/sandbox/native-cli-status', async (_req, res) => {
  try {
    const nativeCli = await getNativeCliRuntimeStatus();
    res.json({
      success: true,
      ...getSandboxStatus(),
      nativeCli,
    });
  } catch (error) {
    console.error('[E2B Route] Native CLI status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/auth-sources', async (req, res) => {
  try {
    const overview = await getE2BAuthOverview();
    res.json({
      success: true,
      providers: overview,
      defaultSelections: getDefaultE2BAuthSelections(overview),
    });
  } catch (error) {
    console.error('[E2B Route] Auth sources error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sandbox/create', async (req, res) => {
  try {
    const { template, envs: userEnvs, authSelections } = req.body || {};
    const runtimeContext = await buildSandboxRuntimeContext(req, authSelections);
    const envs = { ...runtimeContext.envs, ...(userEnvs || {}) };
    const client = await createSandbox({ template, envs, forceNew: true });

    await syncE2BAuthToSandbox(client, runtimeContext.authBundle);
    await applySandboxGitIdentity(req, client);
    const nativeCli = await getNativeCliRuntimeStatus(client);

    res.json({
      success: true,
      authSummary: runtimeContext.authSummary,
      nativeCli,
      ...getSandboxStatus(),
    });
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
    const { sandboxId, authSelections } = req.body || {};
    if (!sandboxId) {
      return res.status(400).json({ success: false, error: 'sandboxId is required' });
    }

    const sandboxRecord = e2bSandboxDb.getBySandboxId(sandboxId);
    const runtimeContext = await buildSandboxRuntimeContext(req, authSelections, {
      sandboxRecord,
      strict: false,
    });

    const client = await resumeSandbox(sandboxId, runtimeContext.envs);
    await syncE2BAuthToSandbox(client, runtimeContext.authBundle);
    await applySandboxGitIdentity(req, client);
    const nativeCli = await getNativeCliRuntimeStatus(client);

    e2bSandboxDb.updateStatus(sandboxId, 'running');
    res.json({
      success: true,
      authSummary: runtimeContext.authSummary,
      nativeCli,
      ...getSandboxStatus(),
    });
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
    const { repoUrl, branch, template, envs: extraEnvs, authSelections } = req.body || {};
    if (!repoUrl) {
      return res.status(400).json({ success: false, error: 'repoUrl is required' });
    }

    const runtimeContext = await buildSandboxRuntimeContext(req, authSelections);
    const envs = { ...runtimeContext.envs, ...(extraEnvs || {}) };

    // Create sandbox (this also sets up git credential helper via setupGitCredentials)
    const client = await createSandbox({ template, envs, forceNew: true });
    await syncE2BAuthToSandbox(client, runtimeContext.authBundle);

    // Re-run credential setup with user's real git identity if configured
    await applySandboxGitIdentity(req, client);
    const nativeCli = await getNativeCliRuntimeStatus(client);

    // Normalize clone URL to plain HTTPS (credential helper provides auth)
    let cloneUrl = repoUrl;
    if (!cloneUrl.startsWith('https://')) {
      // Convert git@github.com:owner/repo.git -> https://github.com/owner/repo.git
      cloneUrl = cloneUrl.replace(/^git@github\.com:/, 'https://github.com/');
    }

    // Extract repo name from URL
    const repoName = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'repo';
    const workspacePath = `/home/user/${repoName}`;
    const branchArg = branch ? `--branch ${branch}` : '';

    // Run git clone inside sandbox (credential helper handles authentication)
    console.log(`[E2B] Cloning ${repoUrl} (branch: ${branch || 'default'}) into sandbox...`);
    await client.runProcess({
      command: 'bash',
      args: ['-c', `git clone ${branchArg} '${cloneUrl}' '${workspacePath}' 2>&1`],
    });
    console.log(`[E2B] Clone complete: ${workspacePath}`);

    // Save sandbox record
    const status = getSandboxStatus();
    e2bSandboxDb.create(req.user.id, status.sandboxId, {
      repoUrl,
      branch: branch || 'main',
      workspacePath,
      metadata: {
        authSelections: runtimeContext.authSelections,
        authSummary: runtimeContext.authSummary,
        sandboxConnectHost: runtimeContext.sandboxConnectHost || null,
      },
    });

    res.json({
      success: true,
      sandboxId: status.sandboxId,
      workspacePath,
      inspectorUrl: status.inspectorUrl,
      authSummary: runtimeContext.authSummary,
      nativeCli,
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
      command: 'bash',
      args: ['-c', `cd '${cwd}' && git add -A && git diff --cached --quiet || git commit -m '${message.replace(/'/g, "'\\''")}' && git push 2>&1`],
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
    const { sessionId, agent, cwd, model, sandboxId } = req.body || {};
    if (!sessionId || !agent) {
      return res.status(400).json({ success: false, error: 'sessionId and agent are required' });
    }
    const result = await createE2BSession(sessionId, {
      agent,
      cwd,
      model,
      sandboxId,
      resume: false,
      sandboxConnectHost: resolveSandboxConnectHost(req),
    });
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
    await sendMessageToE2BSession(sessionId, message, {
      sandboxConnectHost: resolveSandboxConnectHost(req),
    });
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

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await abortE2BSession(sessionId);
    e2bSessionMessagesDb.deleteBySessionId(sessionId);
    e2bSessionDb.delete(sessionId);
    sessionNamesDb.deleteName(sessionId, 'e2b');
    res.json({ success: true });
  } catch (error) {
    console.error('[E2B Route] Delete session error:', error);
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
