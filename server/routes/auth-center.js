import crypto from 'crypto';
import express from 'express';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { authProfilesDb, e2bSandboxDb } from '../database/db.js';
import {
  CLAUDE_CODE_OAUTH_SCOPES,
  createStoredAuthBundlePayload,
  detectE2BAutoResourcesForProvider,
  getDefaultE2BAuthSelections,
  getE2BAuthOverview,
  maybeAttachHostCodexConfigToProfileResources,
  normalizeE2BAuthSelections,
  resolveE2BAuthBundle,
  resolveE2BCustomResourcesForProvider,
  sanitizeE2BAuthSelections,
  summarizeStoredAuthBundlePayload,
  syncE2BAuthToSandbox,
} from '../providers/e2b/auth-sync.js';
import { resolveSandboxConnectHostFromRequest } from '../providers/e2b/connect-host.js';
import { getSandboxClient, getSandboxId } from '../providers/e2b/sandbox-manager.js';
import { extractSandboxIdFromProjectName, isE2BProjectName } from '../providers/e2b/project-utils.js';
import { loadProjectConfig, saveProjectConfig } from '../projects.js';

const router = express.Router();

const PROVIDERS = ['claude', 'cursor', 'codex', 'gemini'];
const LOGIN_DRAFT_TTL_MS = 20 * 60 * 1000;

const CLAUDE_AUTH_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REDIRECT_URI = 'http://localhost:54545/callback';

const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const CODEX_DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const CODEX_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';

const GEMINI_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID
  || '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET
  || ['GOCSPX', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl'].join('-');
const GEMINI_REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const GEMINI_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const AUTH_CENTER_PROXY_URL = [
  process.env.AUTH_CENTER_PROXY_URL,
  process.env.OAUTH_PROXY_URL,
  process.env.HTTPS_PROXY,
  process.env.HTTP_PROXY,
  process.env.ALL_PROXY,
]
  .map((value) => (typeof value === 'string' ? value.trim() : ''))
  .find(Boolean) || '';

const AUTH_CENTER_PROXY_AGENT = AUTH_CENTER_PROXY_URL ? new HttpsProxyAgent(AUTH_CENTER_PROXY_URL) : null;

if (AUTH_CENTER_PROXY_URL) {
  console.log(`[Auth Center] OAuth proxy enabled: ${AUTH_CENTER_PROXY_URL}`);
}

const PROVIDER_CAPABILITIES = {
  claude: {
    supportsCallback: true,
    supportsDevice: false,
    supportsApiKey: true,
    supportsPathImport: true,
    supportsHostSnapshot: true,
  },
  codex: {
    supportsCallback: true,
    supportsDevice: true,
    supportsApiKey: true,
    supportsPathImport: true,
    supportsHostSnapshot: true,
  },
  gemini: {
    supportsCallback: true,
    supportsDevice: false,
    supportsApiKey: true,
    supportsPathImport: true,
    supportsHostSnapshot: true,
  },
  cursor: {
    supportsCallback: false,
    supportsDevice: false,
    supportsApiKey: true,
    supportsPathImport: false,
    supportsHostSnapshot: true,
  },
};

const loginDrafts = new Map();

function cleanupExpiredDrafts() {
  const now = Date.now();
  for (const [draftId, draft] of loginDrafts.entries()) {
    if (!draft?.createdAt || now - draft.createdAt > LOGIN_DRAFT_TTL_MS) {
      loginDrafts.delete(draftId);
    }
  }
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

function parseJsonOrNull(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function authCenterFetch(url, options = {}) {
  if (!AUTH_CENTER_PROXY_AGENT) {
    return fetch(url, options);
  }

  return fetch(url, {
    ...options,
    agent: AUTH_CENTER_PROXY_AGENT,
  });
}

function extractErrorMessage(value, fallback = 'Unknown error') {
  if (typeof value === 'string') {
    return value.trim() || fallback;
  }

  if (value instanceof Error) {
    return value.message || fallback;
  }

  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const objectValue = value;
  const preferredKeys = [
    'error_description',
    'errorDescription',
    'message',
    'error',
    'description',
    'detail',
    'details',
    'msg',
    'code',
  ];

  for (const key of preferredKeys) {
    if (key in objectValue) {
      const nested = extractErrorMessage(objectValue[key], '');
      if (nested) {
        return nested;
      }
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function toResponseErrorMessage(error, fallback = 'Unexpected error') {
  return extractErrorMessage(error, fallback);
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 16);
}

function normalizeOauthScopeList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [...fallback];
}

function buildDefaultProfileName(provider, suffix) {
  const prefix = provider === 'codex' ? 'Codex' : provider === 'gemini' ? 'Gemini' : provider === 'cursor' ? 'Cursor' : 'Claude';
  return `${prefix} ${suffix} ${nowStamp()}`;
}

function resolveProfileName(provider, rawName, fallbackLabel) {
  if (typeof rawName === 'string' && rawName.trim()) {
    return rawName.trim();
  }

  return buildDefaultProfileName(provider, fallbackLabel);
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64url');
}

function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(96));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCallbackUrl(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) {
    throw new Error('Callback URL is required');
  }

  const buildCallbackPayload = (searchParams, hashParams, raw) => {
    const hashRaw = hashParams?.toString() || '';
    let code = searchParams.get('code') || hashParams.get('code') || '';
    let state = searchParams.get('state') || hashParams.get('state') || '';

    if (code.includes('#')) {
      const [codePart, statePart] = code.split('#', 2);
      code = codePart || '';
      if (!state && statePart) {
        state = statePart;
      }
    }

    if (!state && hashRaw && !hashRaw.includes('=')) {
      state = hashRaw;
    }

    return {
      code,
      state,
      error: searchParams.get('error') || hashParams.get('error') || '',
      errorDescription:
        searchParams.get('error_description') ||
        hashParams.get('error_description') ||
        hashParams.get('errorDescription') ||
        '',
      raw,
    };
  };

  try {
    const url = new URL(trimmed);
    const hashRaw = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hashRaw.startsWith('?') ? hashRaw.slice(1) : hashRaw);
    return buildCallbackPayload(url.searchParams, hashParams, trimmed);
  } catch {
    const normalized = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    const params = new URLSearchParams(normalized);
    if (params.has('code') || params.has('error')) {
      return buildCallbackPayload(params, new URLSearchParams(), trimmed);
    }
  }

  throw new Error('Invalid callback URL');
}

function serializeProfileRow(row) {
  const payloadSummary = summarizeStoredAuthBundlePayload(row.payload_json);
  return {
    id: row.id,
    provider: row.provider,
    name: row.profile_name,
    profileType: row.profile_type,
    source: row.source || null,
    email: row.email || null,
    summary: row.summary || payloadSummary.summary,
    files: payloadSummary.files,
    envKeys: payloadSummary.envKeys,
    warnings: payloadSummary.warnings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildOverviewResponse(hostOverview, profiles) {
  const profilesByProvider = {
    claude: [],
    cursor: [],
    codex: [],
    gemini: [],
  };

  for (const row of profiles) {
    if (profilesByProvider[row.provider]) {
      profilesByProvider[row.provider].push(serializeProfileRow(row));
    }
  }

  return {
    providers: Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        {
          host: hostOverview[provider],
          capabilities: PROVIDER_CAPABILITIES[provider],
          profiles: profilesByProvider[provider],
        },
      ]),
    ),
    defaultSelections: getDefaultE2BAuthSelections(hostOverview),
  };
}

function buildClaudeOauthResources(tokenResponse) {
  const expiresAt = Date.now() + Number(tokenResponse.expires_in || 0) * 1000;
  const scopes = normalizeOauthScopeList(tokenResponse.scope ?? tokenResponse.scopes, CLAUDE_CODE_OAUTH_SCOPES);
  const credentialsContent = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt,
        scopes,
        subscriptionType: tokenResponse.subscription_type ?? tokenResponse.subscriptionType ?? null,
        rateLimitTier: tokenResponse.rate_limit_tier ?? tokenResponse.rateLimitTier ?? null,
      },
    },
    null,
    2,
  );

  return {
    files: [
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.claude/.credentials.json',
        content: credentialsContent,
      },
    ],
    envs: {},
    warnings: [],
  };
}

function buildClaudeApiKeyResources(apiKey) {
  return {
    files: [
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.claude/settings.json',
        content: JSON.stringify({ env: { ANTHROPIC_API_KEY: apiKey } }, null, 2),
      },
    ],
    envs: {
      ANTHROPIC_API_KEY: apiKey,
    },
    warnings: [],
  };
}

function buildCodexOauthResources(tokenResponse) {
  const claims = decodeJwtPayload(tokenResponse.id_token);
  const authContent = JSON.stringify(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: tokenResponse.id_token,
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        account_id:
          claims?.['https://api.openai.com/auth']?.chatgpt_account_id ||
          claims?.['https://api.openai.com/auth']?.user_id ||
          '',
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2,
  );

  return {
    files: [
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.codex/auth.json',
        content: authContent,
      },
    ],
    envs: {},
    warnings: [],
    email: claims?.email || null,
  };
}

function buildCodexApiKeyResources(apiKey) {
  return {
    files: [
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.codex/auth.json',
        content: JSON.stringify(
          {
            auth_mode: 'api_key',
            OPENAI_API_KEY: apiKey,
          },
          null,
          2,
        ),
      },
    ],
    envs: {
      OPENAI_API_KEY: apiKey,
      CODEX_API_KEY: apiKey,
    },
    warnings: [],
    email: 'API Key Auth',
  };
}

function buildGeminiOauthResources(tokenResponse, email) {
  const oauthContent = JSON.stringify(
    {
      ...tokenResponse,
      token_uri: GEMINI_TOKEN_URL,
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      scopes: GEMINI_SCOPES,
      universe_domain: 'googleapis.com',
    },
    null,
    2,
  );

  const accountsContent = JSON.stringify(
    {
      active: email,
      accounts: email ? [email] : [],
    },
    null,
    2,
  );

  return {
    files: [
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.gemini/oauth_creds.json',
        content: oauthContent,
      },
      {
        sourcePath: 'auth-center',
        targetPath: '/home/user/.gemini/google_accounts.json',
        content: accountsContent,
      },
    ],
    envs: {},
    warnings: [],
  };
}

function buildGeminiApiKeyResources(apiKey) {
  return {
    files: [],
    envs: {
      GEMINI_API_KEY: apiKey,
    },
    warnings: [],
  };
}

function buildCursorApiKeyResources(apiKey) {
  return {
    files: [],
    envs: {
      CURSOR_API_KEY: apiKey,
    },
    warnings: [],
  };
}

function buildApiKeyResources(provider, apiKey) {
  if (provider === 'claude') {
    return buildClaudeApiKeyResources(apiKey);
  }

  if (provider === 'codex') {
    return buildCodexApiKeyResources(apiKey);
  }

  if (provider === 'gemini') {
    return buildGeminiApiKeyResources(apiKey);
  }

  return buildCursorApiKeyResources(apiKey);
}

async function exchangeClaudeTokens({ code, state, codeVerifier }) {
  const response = await authCenterFetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed) {
    throw new Error(extractErrorMessage(parsed, `Claude token exchange failed (${response.status})`));
  }

  return parsed;
}

async function exchangeCodexTokens({ code, codeVerifier, redirectUri = CODEX_REDIRECT_URI }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await authCenterFetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed) {
    throw new Error(extractErrorMessage(parsed, `Codex token exchange failed (${response.status})`));
  }

  return parsed;
}

async function requestCodexDeviceCode() {
  const response = await authCenterFetch(CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed) {
    throw new Error(extractErrorMessage(parsed, `Codex device start failed (${response.status})`));
  }

  return parsed;
}

async function pollCodexDeviceToken(draft) {
  const intervalMs = Math.max(3, Number(draft.intervalSeconds || 5)) * 1000;
  const deadline = Date.now() + 2 * 60 * 1000;

  while (Date.now() < deadline) {
    const response = await authCenterFetch(CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: draft.deviceAuthId,
        user_code: draft.userCode,
      }),
    });

    const body = await response.text();
    const parsed = parseJsonOrNull(body);

    if (response.ok && parsed?.authorization_code && parsed?.code_verifier) {
      return parsed;
    }

    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    throw new Error(extractErrorMessage(parsed, `Codex device polling failed (${response.status})`));
  }

  throw new Error('Codex device authentication timed out');
}

async function exchangeGeminiTokens({ code }) {
  const params = new URLSearchParams({
    code,
    client_id: GEMINI_CLIENT_ID,
    client_secret: GEMINI_CLIENT_SECRET,
    redirect_uri: GEMINI_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const response = await authCenterFetch(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed) {
    throw new Error(extractErrorMessage(parsed, `Gemini token exchange failed (${response.status})`));
  }

  return parsed;
}

async function fetchGeminiUserEmail(accessToken) {
  const response = await authCenterFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed?.email) {
    throw new Error(extractErrorMessage(parsed, 'Could not fetch Gemini user email'));
  }

  return parsed.email;
}

function buildStartLoginDraft(provider, flow, profileName) {
  cleanupExpiredDrafts();
  const draftId = crypto.randomUUID();
  const createdAt = Date.now();

  if (provider === 'claude') {
    const pkce = generatePkcePair();
    const state = generateState();
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_CODE_OAUTH_SCOPES.join(' '),
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    const authUrl = `${CLAUDE_AUTH_URL}?${params.toString()}`;
    loginDrafts.set(draftId, { id: draftId, provider, flow, profileName, createdAt, state, ...pkce });
    return {
      draftId,
      provider,
      flow,
      authUrl,
      redirectUri: CLAUDE_REDIRECT_URI,
      instructions: 'Open the URL, complete login, then paste the full callback URL here.',
    };
  }

  if (provider === 'codex' && flow === 'callback') {
    const pkce = generatePkcePair();
    const state = generateState();
    const params = new URLSearchParams({
      client_id: CODEX_CLIENT_ID,
      response_type: 'code',
      redirect_uri: CODEX_REDIRECT_URI,
      scope: 'openid email profile offline_access',
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    });
    const authUrl = `${CODEX_AUTH_URL}?${params.toString()}`;
    loginDrafts.set(draftId, { id: draftId, provider, flow, profileName, createdAt, state, ...pkce });
    return {
      draftId,
      provider,
      flow,
      authUrl,
      redirectUri: CODEX_REDIRECT_URI,
      instructions: 'Open the URL, complete login, then paste the full callback URL here.',
    };
  }

  if (provider === 'gemini') {
    const state = generateState();
    const params = new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      redirect_uri: GEMINI_REDIRECT_URI,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: GEMINI_SCOPES.join(' '),
    });
    const authUrl = `${GEMINI_AUTH_URL}?${params.toString()}`;
    loginDrafts.set(draftId, { id: draftId, provider, flow, profileName, createdAt, state });
    return {
      draftId,
      provider,
      flow,
      authUrl,
      redirectUri: GEMINI_REDIRECT_URI,
      instructions: 'Open the URL, approve access, then paste the full callback URL here.',
    };
  }

  throw new Error(`Unsupported ${provider} login flow: ${flow}`);
}

async function createProfileFromResources(userId, provider, input) {
  const resources =
    provider === 'codex'
      ? await maybeAttachHostCodexConfigToProfileResources(input.resources, { source: input.source })
      : input.resources;

  const profileId = authProfilesDb.create(userId, {
    provider,
    profileName: input.profileName,
    profileType: input.profileType || 'bundle',
    source: input.source || null,
    email: input.email || null,
    summary: input.summary || null,
    payload: createStoredAuthBundlePayload(provider, resources, {
      summary: input.summary || undefined,
      metadata: input.metadata || {},
    }),
    metadata: input.metadata || null,
  });

  return authProfilesDb.getById(userId, profileId);
}

async function maybeApplySelectionsToRunningSandbox(userId, projectName, selections, options = {}) {
  if (!isE2BProjectName(projectName)) {
    return;
  }

  const sandboxId = extractSandboxIdFromProjectName(projectName);
  if (!sandboxId || getSandboxId() !== sandboxId) {
    return;
  }

  const client = getSandboxClient();
  if (!client) {
    return;
  }

  const bundle = await resolveE2BAuthBundle(selections, {
    strict: false,
    userId,
    sandboxConnectHost: options.sandboxConnectHost || '',
    refreshClaudeProfiles: false,
  });

  await syncE2BAuthToSandbox(client, bundle);
}

router.get('/overview', async (req, res) => {
  try {
    cleanupExpiredDrafts();
    const hostOverview = await getE2BAuthOverview();
    const profiles = authProfilesDb.getByUser(req.user.id);

    res.json({
      success: true,
      ...buildOverviewResponse(hostOverview, profiles),
    });
  } catch (error) {
    console.error('[Auth Center] Overview error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to load auth center overview') });
  }
});

router.post('/profiles/host-snapshot', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim();
    assertProvider(provider);

    const resources = await detectE2BAutoResourcesForProvider(provider);
    if (!resources.files?.length && !Object.keys(resources.envs || {}).length) {
      return res.status(400).json({ success: false, error: `No reusable host auth detected for ${provider}` });
    }

    const profile = await createProfileFromResources(req.user.id, provider, {
      profileName: resolveProfileName(provider, req.body?.name, 'Host Snapshot'),
      source: 'host_snapshot',
      summary: `Host snapshot • ${provider}`,
      resources,
    });

    res.json({ success: true, profile: serializeProfileRow(profile) });
  } catch (error) {
    console.error('[Auth Center] Host snapshot error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to create host snapshot profile') });
  }
});

router.post('/profiles/import-path', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim();
    const targetPath = String(req.body?.path || '').trim();
    assertProvider(provider);

    if (!targetPath) {
      return res.status(400).json({ success: false, error: 'path is required' });
    }

    const resources = await resolveE2BCustomResourcesForProvider(provider, targetPath);
    const profile = await createProfileFromResources(req.user.id, provider, {
      profileName: resolveProfileName(provider, req.body?.name, 'Imported Path'),
      source: 'path_import',
      summary: `Imported from ${targetPath}`,
      resources,
      metadata: { importPath: targetPath },
    });

    res.json({ success: true, profile: serializeProfileRow(profile) });
  } catch (error) {
    console.error('[Auth Center] Import path error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to import auth path') });
  }
});

router.post('/profiles/api-key', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim();
    assertProvider(provider);

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'apiKey is required' });
    }

    const resources = buildApiKeyResources(provider, apiKey);
    const profile = await createProfileFromResources(req.user.id, provider, {
      profileName: resolveProfileName(provider, req.body?.name, 'API Key'),
      source: 'api_key',
      email: provider === 'codex' ? resources.email : 'API Key Auth',
      summary: `${provider} API key`,
      resources,
    });

    res.json({ success: true, profile: serializeProfileRow(profile) });
  } catch (error) {
    console.error('[Auth Center] API key profile error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to save API key profile') });
  }
});

router.post('/login/start', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim();
    const flow = String(req.body?.flow || 'callback').trim();
    assertProvider(provider);

    if (provider === 'codex' && flow === 'device') {
      const deviceInfo = await requestCodexDeviceCode();
      const draftId = crypto.randomUUID();
      const userCode = String(deviceInfo.user_code || deviceInfo.usercode || '').trim();
      const deviceAuthId = String(deviceInfo.device_auth_id || '').trim();
      const intervalSeconds = Number(deviceInfo.interval || 5) || 5;

      loginDrafts.set(draftId, {
        id: draftId,
        provider,
        flow,
        profileName: resolveProfileName(provider, req.body?.name, 'Device Login'),
        createdAt: Date.now(),
        userCode,
        deviceAuthId,
        intervalSeconds,
      });

      return res.json({
        success: true,
        draftId,
        provider,
        flow,
        userCode,
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        instructions: 'Open the verification URL, enter the code, then click Complete.',
      });
    }

    const draft = buildStartLoginDraft(
      provider,
      flow,
      resolveProfileName(
        provider,
        req.body?.name,
        flow === 'callback' ? 'Callback Login' : 'Login',
      ),
    );

    res.json({ success: true, ...draft });
  } catch (error) {
    console.error('[Auth Center] Login start error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Could not start login flow') });
  }
});

router.post('/login/complete', async (req, res) => {
  try {
    cleanupExpiredDrafts();
    const draftId = String(req.body?.draftId || '').trim();
    if (!draftId) {
      return res.status(400).json({ success: false, error: 'draftId is required' });
    }

    const draft = loginDrafts.get(draftId);
    if (!draft) {
      return res.status(404).json({ success: false, error: 'Login draft not found or expired' });
    }

    let provider = draft.provider;
    let email = null;
    let resources = null;
    let source = draft.flow === 'device' ? 'device' : 'callback';

    if (provider === 'claude') {
      const callback = parseCallbackUrl(req.body?.callbackUrl);
      if (callback.error) {
        throw new Error(callback.errorDescription || callback.error);
      }
      if (callback.state !== draft.state) {
        throw new Error('Claude callback state mismatch');
      }

      const tokenResponse = await exchangeClaudeTokens({
        code: callback.code,
        state: draft.state,
        codeVerifier: draft.codeVerifier,
      });
      email = tokenResponse.account?.email_address || null;
      resources = buildClaudeOauthResources(tokenResponse);
    } else if (provider === 'codex' && draft.flow === 'callback') {
      const callback = parseCallbackUrl(req.body?.callbackUrl);
      if (callback.error) {
        throw new Error(callback.errorDescription || callback.error);
      }
      if (callback.state !== draft.state) {
        throw new Error('Codex callback state mismatch');
      }

      const tokenResponse = await exchangeCodexTokens({
        code: callback.code,
        codeVerifier: draft.codeVerifier,
      });
      resources = buildCodexOauthResources(tokenResponse);
      email = resources.email || null;
    } else if (provider === 'codex' && draft.flow === 'device') {
      const deviceResult = await pollCodexDeviceToken(draft);
      const tokenResponse = await exchangeCodexTokens({
        code: deviceResult.authorization_code,
        codeVerifier: deviceResult.code_verifier,
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
      });
      resources = buildCodexOauthResources(tokenResponse);
      email = resources.email || null;
    } else if (provider === 'gemini') {
      const callback = parseCallbackUrl(req.body?.callbackUrl);
      if (callback.error) {
        throw new Error(callback.errorDescription || callback.error);
      }
      if (callback.state !== draft.state) {
        throw new Error('Gemini callback state mismatch');
      }

      const tokenResponse = await exchangeGeminiTokens({ code: callback.code });
      email = await fetchGeminiUserEmail(tokenResponse.access_token);
      resources = buildGeminiOauthResources(tokenResponse, email);
    } else {
      throw new Error(`Unsupported completion flow for ${provider}`);
    }

    const profile = await createProfileFromResources(req.user.id, provider, {
      profileName: draft.profileName,
      source,
      email,
      summary: `${provider} ${source} login`,
      resources,
    });

    loginDrafts.delete(draftId);
    res.json({ success: true, profile: serializeProfileRow(profile) });
  } catch (error) {
    console.error('[Auth Center] Login complete error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Could not complete login flow') });
  }
});

router.put('/profiles/:id', (req, res) => {
  try {
    const profileId = Number.parseInt(req.params.id, 10);
    const nextName = String(req.body?.name || '').trim();
    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ success: false, error: 'Invalid profile id' });
    }
    if (!nextName) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const updated = authProfilesDb.updateName(req.user.id, profileId, nextName);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const profile = authProfilesDb.getById(req.user.id, profileId);
    res.json({ success: true, profile: serializeProfileRow(profile) });
  } catch (error) {
    console.error('[Auth Center] Rename profile error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to rename auth profile') });
  }
});

router.delete('/profiles/:id', (req, res) => {
  try {
    const profileId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ success: false, error: 'Invalid profile id' });
    }

    const deleted = authProfilesDb.delete(req.user.id, profileId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Auth Center] Delete profile error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to delete auth profile') });
  }
});

router.put('/projects/:projectName/selections', async (req, res) => {
  try {
    const projectName = String(req.params.projectName || '').trim();
    if (!projectName) {
      return res.status(400).json({ success: false, error: 'projectName is required' });
    }

    const hostOverview = await getE2BAuthOverview();
    const nextSelections = sanitizeE2BAuthSelections(
      normalizeE2BAuthSelections(req.body?.authSelections || {}, hostOverview),
      hostOverview,
    );

    if (isE2BProjectName(projectName)) {
      const sandboxId = extractSandboxIdFromProjectName(projectName);
      const sandboxRecord = sandboxId ? e2bSandboxDb.getBySandboxId(sandboxId) : null;
      if (!sandboxId || !sandboxRecord) {
        return res.status(404).json({ success: false, error: 'Cloud project not found' });
      }

      const metadata = parseJsonOrNull(sandboxRecord.metadata_json) || {};
      metadata.authSelections = nextSelections;
      const sandboxConnectHost = resolveSandboxConnectHostFromRequest(req, sandboxRecord);
      if (sandboxConnectHost) {
        metadata.sandboxConnectHost = sandboxConnectHost;
      }
      e2bSandboxDb.updateMetadata(sandboxId, metadata);
    } else {
      const config = await loadProjectConfig();
      config[projectName] = {
        ...(config[projectName] || {}),
        authSelections: nextSelections,
      };
      await saveProjectConfig(config);
    }

    await maybeApplySelectionsToRunningSandbox(req.user.id, projectName, nextSelections, {
      sandboxConnectHost: isE2BProjectName(projectName) ? resolveSandboxConnectHostFromRequest(req) : '',
    });

    res.json({
      success: true,
      authSelections: nextSelections,
    });
  } catch (error) {
    console.error('[Auth Center] Save project selections error:', error);
    res.status(500).json({ success: false, error: toResponseErrorMessage(error, 'Failed to save project auth selections') });
  }
});

export default router;
