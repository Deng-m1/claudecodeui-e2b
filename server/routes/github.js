import express from 'express';
import { Octokit } from '@octokit/rest';
import { credentialsDb } from '../database/db.js';

const router = express.Router();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

const CREDENTIAL_TYPE = 'github_oauth';

// Simple in-memory state store for OAuth CSRF (entries expire after 10 min)
const oauthStates = new Map();
function createOAuthState() {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  oauthStates.set(state, Date.now());
  // Clean up expired states
  for (const [k, v] of oauthStates) {
    if (Date.now() - v > 600_000) oauthStates.delete(k);
  }
  return state;
}
function consumeOAuthState(state) {
  if (!state || !oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}

function getOAuthRedirectUri(req) {
  if (process.env.GITHUB_REDIRECT_URI) return process.env.GITHUB_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/github/oauth/callback`;
}

function getUserOctokit(userId) {
  const token = credentialsDb.getActiveCredential(userId, CREDENTIAL_TYPE);
  if (!token) return null;
  return new Octokit({ auth: token });
}

// ─── OAuth flow ──────────────────────────────────────────────────────────────

/**
 * GET /oauth/authorize
 * Redirect user to GitHub consent screen.
 */
router.get('/oauth/authorize', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
  }
  const redirectUri = getOAuthRedirectUri(req);
  const state = createOAuthState();
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo,read:user&state=${state}`;
  res.redirect(url);
});

/**
 * GET /oauth/callback
 * Exchange authorization code for access token.
 */
router.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }
  if (!consumeOAuthState(state)) {
    return res.status(403).send('Invalid or expired state – possible CSRF');
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error('[GitHub OAuth] Token exchange failed:', tokenData);
      return res.status(400).send(`GitHub OAuth failed: ${tokenData.error_description || tokenData.error}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch GitHub user info
    const octokit = new Octokit({ auth: accessToken });
    const { data: ghUser } = await octokit.users.getAuthenticated();

    // Store token – remove any previous OAuth credential, then create new one
    const userId = req.user?.id || 1;
    const existing = credentialsDb.getCredentials(userId, CREDENTIAL_TYPE);
    for (const cred of existing) {
      credentialsDb.deleteCredential(userId, cred.id);
    }
    credentialsDb.createCredential(
      userId,
      `github:${ghUser.login}`,
      CREDENTIAL_TYPE,
      accessToken,
      `GitHub OAuth – ${ghUser.login} (${ghUser.email || 'no email'})`,
    );

    // Redirect to frontend settings page with success indicator
    res.send(`
      <html><body><script>
        window.opener?.postMessage({ type: 'github-oauth-success', login: '${ghUser.login}' }, '*');
        window.close();
      </script><p>GitHub connected! You can close this window.</p></body></html>
    `);
  } catch (err) {
    console.error('[GitHub OAuth] Callback error:', err);
    res.status(500).send('OAuth callback failed');
  }
});

/**
 * GET /oauth/status
 * Check current GitHub connection.
 */
router.get('/oauth/status', async (req, res) => {
  try {
    const octokit = getUserOctokit(req.user.id);
    if (!octokit) {
      return res.json({ connected: false });
    }
    const { data: user } = await octokit.users.getAuthenticated();
    res.json({
      connected: true,
      login: user.login,
      avatarUrl: user.avatar_url,
      name: user.name,
    });
  } catch (err) {
    // Token might be revoked
    res.json({ connected: false, error: err.message });
  }
});

/**
 * DELETE /oauth/disconnect
 * Remove stored GitHub OAuth token.
 */
router.delete('/oauth/disconnect', (req, res) => {
  const existing = credentialsDb.getCredentials(req.user.id, CREDENTIAL_TYPE);
  for (const cred of existing) {
    credentialsDb.deleteCredential(req.user.id, cred.id);
  }
  res.json({ success: true });
});

// ─── Repo / Branch listing ──────────────────────────────────────────────────

/**
 * GET /repos
 * List repositories for the authenticated GitHub user.
 * Query: ?page=1&per_page=30&sort=updated&type=all&q=searchterm
 */
router.get('/repos', async (req, res) => {
  try {
    const octokit = getUserOctokit(req.user.id);
    if (!octokit) {
      return res.status(401).json({ error: 'GitHub not connected' });
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = Math.min(parseInt(req.query.per_page) || 30, 100);
    const sort = req.query.sort || 'updated';
    const type = req.query.type || 'all';
    const search = req.query.q || '';

    if (search) {
      // Use search API for filtering
      const { data: user } = await octokit.users.getAuthenticated();
      const { data } = await octokit.search.repos({
        q: `${search} user:${user.login} fork:true`,
        sort: sort === 'updated' ? 'updated' : 'stars',
        per_page: perPage,
        page,
      });
      return res.json({
        repos: data.items.map(formatRepo),
        total: data.total_count,
        page,
        perPage,
      });
    }

    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort,
      type,
      per_page: perPage,
      page,
    });

    res.json({
      repos: data.map(formatRepo),
      total: data.length,
      page,
      perPage,
    });
  } catch (err) {
    console.error('[GitHub] List repos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /repos/:owner/:repo/branches
 * List branches for a repository.
 */
router.get('/repos/:owner/:repo/branches', async (req, res) => {
  try {
    const octokit = getUserOctokit(req.user.id);
    if (!octokit) {
      return res.status(401).json({ error: 'GitHub not connected' });
    }

    const { owner, repo } = req.params;
    const page = parseInt(req.query.page) || 1;
    const perPage = Math.min(parseInt(req.query.per_page) || 100, 100);

    const { data } = await octokit.repos.listBranches({
      owner,
      repo,
      per_page: perPage,
      page,
    });

    // Also get default branch
    const { data: repoData } = await octokit.repos.get({ owner, repo });

    res.json({
      branches: data.map((b) => ({
        name: b.name,
        isDefault: b.name === repoData.default_branch,
        sha: b.commit.sha,
      })),
      defaultBranch: repoData.default_branch,
    });
  } catch (err) {
    console.error('[GitHub] List branches error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function formatRepo(r) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch,
    language: r.language,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url,
    owner: { login: r.owner.login, avatarUrl: r.owner.avatar_url },
  };
}

export default router;
