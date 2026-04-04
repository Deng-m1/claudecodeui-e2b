import fs from 'fs/promises';
import path from 'path';
import TOML from '@iarna/toml';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  CLI_AUTH_PATHS,
  checkClaudeCredentials,
  checkCodexCredentials,
  checkCursorStatus,
  checkGeminiCredentials,
  pathExists,
} from '../../lib/cli-auth-status.js';
import { authProfilesDb } from '../../database/db.js';

const SANDBOX_HOME = '/home/user';
const CODEX_AUTH_TARGET_PATH = toSandboxPath('.codex', 'auth.json');
const CODEX_CONFIG_TARGET_PATH = toSandboxPath('.codex', 'config.toml');
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const CLAUDE_PROFILE_SETTINGS_STRIP_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];

const AUTH_SYNC_PROXY_URL = [
  process.env.AUTH_CENTER_PROXY_URL,
  process.env.OAUTH_PROXY_URL,
  process.env.HTTPS_PROXY,
  process.env.HTTP_PROXY,
  process.env.ALL_PROXY,
]
  .map((value) => (typeof value === 'string' ? value.trim() : ''))
  .find(Boolean) || '';

const AUTH_SYNC_PROXY_AGENT = AUTH_SYNC_PROXY_URL ? new HttpsProxyAgent(AUTH_SYNC_PROXY_URL) : null;

export const E2B_AUTH_PROVIDERS = ['claude', 'cursor', 'codex', 'gemini'];

const CUSTOM_PATH_HINTS = {
  claude: '~/.claude/settings.json or ~/.claude',
  codex: '~/.codex/auth.json or ~/.codex',
  gemini: '~/.gemini/oauth_creds.json or ~/.gemini',
  cursor: 'Set CURSOR_API_KEY on the host to sync Cursor auth into E2B',
};

const OWNED_ENV_KEYS = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'API_TIMEOUT_MS',
  ],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CLIPROXY_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
};

const MANAGED_PROVIDER_FILE_TARGETS = {
  claude: [
    toSandboxPath('.claude', 'settings.json'),
    toSandboxPath('.claude', '.credentials.json'),
  ],
  codex: [
    CODEX_AUTH_TARGET_PATH,
    CODEX_CONFIG_TARGET_PATH,
  ],
  gemini: [
    toSandboxPath('.gemini', 'oauth_creds.json'),
    toSandboxPath('.gemini', 'google_accounts.json'),
  ],
  cursor: [],
};

export const CLAUDE_CODE_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

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

async function authSyncFetch(url, options = {}) {
  if (!AUTH_SYNC_PROXY_AGENT) {
    return fetch(url, options);
  }

  return fetch(url, {
    ...options,
    agent: AUTH_SYNC_PROXY_AGENT,
  });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function expandUserPath(inputPath) {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === '~') {
    return process.env.HOME || '';
  }

  if (trimmed.startsWith('~/')) {
    return path.join(process.env.HOME || '', trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

function normalizeSelection(selection, fallbackMode = 'auto') {
  if (!selection || typeof selection !== 'object') {
    return { mode: fallbackMode, path: '', profileId: null };
  }

  const mode = selection.mode === 'custom' || selection.mode === 'disabled' || selection.mode === 'profile'
    ? selection.mode
    : 'auto';

  const rawProfileId = selection.profileId;
  const parsedProfileId =
    typeof rawProfileId === 'number'
      ? rawProfileId
      : typeof rawProfileId === 'string' && rawProfileId.trim()
        ? Number.parseInt(rawProfileId.trim(), 10)
        : null;

  return {
    mode,
    path: typeof selection.path === 'string' ? selection.path : '',
    profileId: Number.isFinite(parsedProfileId) ? parsedProfileId : null,
  };
}

function sanitizeSelection(selection) {
  const normalized = normalizeSelection(selection);
  return {
    mode: normalized.mode,
    ...(normalized.mode === 'custom' && normalized.path.trim() ? { path: normalized.path.trim() } : {}),
    ...(normalized.mode === 'profile' && normalized.profileId ? { profileId: normalized.profileId } : {}),
  };
}

function mergeEnvRecords(base, next) {
  for (const [key, value] of Object.entries(next || {})) {
    base[key] = value;
  }
  return base;
}

function mergeMissingEnvRecords(base, next) {
  for (const [key, value] of Object.entries(next || {})) {
    if (!hasOwn(base, key) || base[key] === null || base[key] === undefined || base[key] === '') {
      base[key] = value;
    }
  }
  return base;
}

function normalizeEnvRecord(value) {
  const env = {};
  if (!value || typeof value !== 'object') {
    return env;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }

    if (typeof raw === 'string') {
      env[key] = raw;
      continue;
    }

    if (typeof raw === 'number' || typeof raw === 'boolean') {
      env[key] = String(raw);
    }
  }

  return env;
}

function toSandboxPath(...segments) {
  return path.posix.join(SANDBOX_HOME, ...segments);
}

function firstNonEmptyString(values = []) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function extractAuthSyncErrorMessage(value, fallback = 'Unknown error') {
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
      const nested = extractAuthSyncErrorMessage(objectValue[key], '');
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

function getHostCodexEnvRecord() {
  const compatApiKey = firstNonEmptyString([
    process.env.OPENAI_API_KEY,
    process.env.CODEX_API_KEY,
    process.env.CLIPROXY_API_KEY,
  ]);

  return buildCodexCompatEnvRecord(compatApiKey, {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
    CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
  });
}

function pickCodexCompatAuthKey(envs = {}, options = {}) {
  return firstNonEmptyString([
    options.openaiApiKey,
    options.codexApiKey,
    envs.OPENAI_API_KEY,
    envs.CODEX_API_KEY,
    envs.CLIPROXY_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.CODEX_API_KEY,
    process.env.CLIPROXY_API_KEY,
  ]);
}

function buildCodexCompatEnvRecord(apiKey, seed = {}) {
  const envs = normalizeEnvRecord(seed);
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (!normalizedKey) {
    return envs;
  }

  envs.OPENAI_API_KEY = normalizedKey;
  envs.CODEX_API_KEY = normalizedKey;
  return envs;
}

function isLoopbackLikeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function normalizeSandboxConnectHost(input) {
  if (typeof input !== 'string') {
    return '';
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  const firstHost = trimmed.split(',')[0]?.trim() || '';
  if (!firstHost) {
    return '';
  }

  if (firstHost.startsWith('[')) {
    const closingIndex = firstHost.indexOf(']');
    if (closingIndex !== -1) {
      return firstHost.slice(1, closingIndex);
    }
    return firstHost;
  }

  const colonCount = (firstHost.match(/:/g) || []).length;
  if (colonCount === 1 && firstHost.includes(':')) {
    return firstHost.split(':')[0];
  }

  return firstHost;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function hasTargetFile(files = [], targetPath) {
  return Array.isArray(files) && files.some((file) => file?.targetPath === targetPath);
}

function summarizeFileTargets(files) {
  return files.map((file) => file.targetPath.replace(`${SANDBOX_HOME}/`, ''));
}

function summarizeEnvKeys(envs) {
  return Object.entries(envs)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key]) => key);
}

function hasClaudeCredentialsTarget(files = []) {
  return files.some((file) => file?.targetPath === toSandboxPath('.claude', '.credentials.json'));
}

function normalizeClaudeOauthScopes(scopes) {
  if (Array.isArray(scopes)) {
    const normalized = scopes
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);

    if (normalized.length > 0) {
      return unique(normalized);
    }
  }

  if (typeof scopes === 'string' && scopes.trim()) {
    const normalized = scopes
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (normalized.length > 0) {
      return unique(normalized);
    }
  }

  return [...CLAUDE_CODE_OAUTH_SCOPES];
}

function normalizeClaudeOauthExpiresAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsedNumber = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
      return parsedNumber;
    }

    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return parsedDate;
    }
  }

  return null;
}

function normalizeClaudeOauthCredentialsPayload(value) {
  const parsed = typeof value === 'string' ? parseJsonOrNull(value) : value;
  const oauth = parsed?.claudeAiOauth && typeof parsed.claudeAiOauth === 'object'
    ? parsed.claudeAiOauth
    : parsed && typeof parsed === 'object'
      ? parsed
      : {};

  const accessToken = firstNonEmptyString([
    oauth?.accessToken,
    oauth?.access_token,
    parsed?.accessToken,
    parsed?.access_token,
  ]);
  const refreshToken = firstNonEmptyString([
    oauth?.refreshToken,
    oauth?.refresh_token,
    parsed?.refreshToken,
    parsed?.refresh_token,
  ]);
  const expiresAt = normalizeClaudeOauthExpiresAt(
    oauth?.expiresAt ?? oauth?.expires_at ?? parsed?.expiresAt ?? parsed?.expires_at,
  );

  if (!accessToken) {
    return null;
  }

  return {
    claudeAiOauth: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      scopes: normalizeClaudeOauthScopes(oauth?.scopes ?? parsed?.scopes),
      subscriptionType:
        typeof oauth?.subscriptionType === 'string' && oauth.subscriptionType.trim()
          ? oauth.subscriptionType.trim()
          : oauth?.subscriptionType ?? null,
      rateLimitTier:
        typeof oauth?.rateLimitTier === 'string' && oauth.rateLimitTier.trim()
          ? oauth.rateLimitTier.trim()
          : oauth?.rateLimitTier ?? null,
    },
  };
}

function buildClaudeOauthCredentialsContent(oauth = {}) {
  return JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: oauth.accessToken,
        ...(oauth.refreshToken ? { refreshToken: oauth.refreshToken } : {}),
        ...(oauth.expiresAt ? { expiresAt: oauth.expiresAt } : {}),
        scopes: normalizeClaudeOauthScopes(oauth.scopes),
        subscriptionType: oauth.subscriptionType ?? null,
        rateLimitTier: oauth.rateLimitTier ?? null,
      },
    },
    null,
    2,
  );
}

async function refreshClaudeOauthAccessToken(refreshToken, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : authSyncFetch;
  const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: normalizeClaudeOauthScopes(options.scopes).join(' '),
    }),
  });

  const body = await response.text();
  const parsed = parseJsonOrNull(body);
  if (!response.ok || !parsed) {
    throw new Error(extractAuthSyncErrorMessage(parsed, `Claude OAuth refresh failed (${response.status})`));
  }

  return parsed;
}

function normalizeClaudeRefreshResponse(tokenResponse, options = {}) {
  const accessToken = firstNonEmptyString([
    tokenResponse?.access_token,
    tokenResponse?.accessToken,
  ]);

  if (!accessToken) {
    throw new Error('Claude OAuth refresh did not return an access token');
  }

  const refreshToken = firstNonEmptyString([
    tokenResponse?.refresh_token,
    tokenResponse?.refreshToken,
    options.fallbackRefreshToken,
  ]);
  const expiresIn = Number(tokenResponse?.expires_in ?? tokenResponse?.expiresIn ?? 0);
  const fallbackExpiresAt = normalizeClaudeOauthExpiresAt(options.fallbackExpiresAt);
  const expiresAt =
    normalizeClaudeOauthExpiresAt(tokenResponse?.expires_at ?? tokenResponse?.expiresAt) ||
    (Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.trunc((options.now ?? Date.now()) + expiresIn * 1000)
      : fallbackExpiresAt);

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes: normalizeClaudeOauthScopes(tokenResponse?.scope ?? tokenResponse?.scopes ?? options.fallbackScopes),
    subscriptionType: firstNonEmptyString([
      tokenResponse?.subscription_type,
      tokenResponse?.subscriptionType,
      options.fallbackSubscriptionType,
    ]) || null,
    rateLimitTier: firstNonEmptyString([
      tokenResponse?.rate_limit_tier,
      tokenResponse?.rateLimitTier,
      options.fallbackRateLimitTier,
    ]) || null,
  };
}

export async function refreshClaudeProfileBundleIfNeeded(payload, options = {}) {
  const normalized = normalizeStoredBundlePayload(payload);
  const credentialsIndex = normalized.files.findIndex(
    (file) => file.targetPath === toSandboxPath('.claude', '.credentials.json'),
  );

  if (credentialsIndex === -1) {
    return {
      payload: createStoredAuthBundlePayload('claude', normalized, { summary: normalized.summary, metadata: normalized.metadata }),
      refreshed: false,
      email: null,
    };
  }

  const credentials = normalizeClaudeOauthCredentialsPayload(normalized.files[credentialsIndex].content);
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return {
      payload: createStoredAuthBundlePayload('claude', normalized, { summary: normalized.summary, metadata: normalized.metadata }),
      refreshed: false,
      email: null,
    };
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const refreshWindowMs = Number.isFinite(options.refreshWindowMs)
    ? Math.max(0, Math.trunc(options.refreshWindowMs))
    : CLAUDE_OAUTH_REFRESH_WINDOW_MS;
  const expiresAt = oauth.expiresAt || null;
  const shouldRefresh = Boolean(oauth.refreshToken) && (!expiresAt || expiresAt - now <= refreshWindowMs);

  if (!shouldRefresh) {
    if (expiresAt && expiresAt <= now) {
      throw new Error('Claude auth profile token has expired and cannot be refreshed. Sign in again to save a new profile.');
    }

    return {
      payload: createStoredAuthBundlePayload('claude', normalized, { summary: normalized.summary, metadata: normalized.metadata }),
      refreshed: false,
      email: null,
    };
  }

  const tokenResponse = await refreshClaudeOauthAccessToken(oauth.refreshToken, {
    scopes: oauth.scopes,
    fetchImpl: options.fetchImpl,
  });
  const refreshedOauth = normalizeClaudeRefreshResponse(tokenResponse, {
    now,
    fallbackRefreshToken: oauth.refreshToken,
    fallbackExpiresAt: oauth.expiresAt,
    fallbackScopes: oauth.scopes,
    fallbackSubscriptionType: oauth.subscriptionType,
    fallbackRateLimitTier: oauth.rateLimitTier,
  });

  const files = [...normalized.files];
  files[credentialsIndex] = {
    ...files[credentialsIndex],
    content: buildClaudeOauthCredentialsContent(refreshedOauth),
  };

  const metadata = {
    ...(normalized.metadata && typeof normalized.metadata === 'object' ? normalized.metadata : {}),
    claudeOauthRefreshedAt: new Date(now).toISOString(),
  };
  const refreshedPayload = createStoredAuthBundlePayload(
    'claude',
    {
      files,
      envs: normalized.envs,
      warnings: normalized.warnings,
      metadata,
    },
    {
      summary: normalized.summary,
      metadata,
    },
  );

  return {
    payload: refreshedPayload,
    refreshed: true,
    email: firstNonEmptyString([
      tokenResponse?.account?.email_address,
      tokenResponse?.account?.emailAddress,
    ]) || null,
  };
}

async function maybeRefreshClaudeProfileRecord(profileRecord, options = {}) {
  if (!profileRecord || profileRecord.provider !== 'claude' || !options.userId || options.refreshClaudeProfiles === false) {
    return profileRecord;
  }

  const refreshResult = await refreshClaudeProfileBundleIfNeeded(profileRecord.payload_json, options);
  if (!refreshResult.refreshed) {
    return profileRecord;
  }

  authProfilesDb.updatePayload(options.userId, profileRecord.id, {
    payload: refreshResult.payload,
    email: refreshResult.email ?? profileRecord.email,
    summary: refreshResult.payload.summary,
    metadata: refreshResult.payload.metadata,
  });

  return {
    ...profileRecord,
    payload_json: JSON.stringify(refreshResult.payload),
    email: refreshResult.email ?? profileRecord.email,
    summary: refreshResult.payload.summary,
    metadata_json: JSON.stringify(refreshResult.payload.metadata || {}),
  };
}

export function rewriteClaudeCredentialsForSandbox(content) {
  const normalized = normalizeClaudeOauthCredentialsPayload(content);

  if (!normalized) {
    return {
      omitted: true,
      content: '',
      warnings: ['Claude OAuth credentials file did not include a usable access token.'],
    };
  }

  return {
    omitted: false,
    content: JSON.stringify(normalized, null, 2),
    warnings: [],
  };
}

function shouldUseClaudeAuthTokenEnv(envs = {}) {
  const baseUrl = typeof envs.ANTHROPIC_BASE_URL === 'string' ? envs.ANTHROPIC_BASE_URL.trim() : '';
  return Boolean(baseUrl);
}

function pinClaudeToNonApiKeyAuth(resources = {}) {
  const envs = { ...(resources.envs || {}) };
  const hasAuthToken = hasOwn(envs, 'ANTHROPIC_AUTH_TOKEN') && typeof envs.ANTHROPIC_AUTH_TOKEN === 'string' && envs.ANTHROPIC_AUTH_TOKEN.trim();
  const hasApiKey = hasOwn(envs, 'ANTHROPIC_API_KEY') && typeof envs.ANTHROPIC_API_KEY === 'string' && envs.ANTHROPIC_API_KEY.trim();

  if (!hasApiKey && (hasAuthToken || hasClaudeCredentialsTarget(resources.files))) {
    envs.ANTHROPIC_API_KEY = null;
  }

  if (hasClaudeCredentialsTarget(resources.files) && !shouldUseClaudeAuthTokenEnv(envs)) {
    envs.ANTHROPIC_AUTH_TOKEN = null;
  }

  return {
    ...resources,
    envs,
  };
}

function buildAutoSummary({ files = [], envs = {}, warnings = [] } = {}) {
  const parts = [];
  const fileTargets = summarizeFileTargets(files);
  const envKeys = summarizeEnvKeys(envs);

  if (fileTargets.length > 0) {
    parts.push(`Copy ${fileTargets.join(', ')}`);
  }

  if (envKeys.length > 0) {
    parts.push(`Inject ${envKeys.join(', ')}`);
  }

  if (parts.length === 0) {
    parts.push('No syncable local auth detected');
  }

  if (warnings.length > 0) {
    parts.push(warnings[0]);
  }

  return parts.join(' • ');
}

async function buildFileResource(sourcePath, targetPath, options = {}) {
  const content = await fs.readFile(sourcePath, 'utf8');
  const envs = typeof options.extractEnvs === 'function'
    ? options.extractEnvs(content)
    : {};

  return {
    sourcePath,
    targetPath,
    content,
    envs,
  };
}

function extractClaudeEnvFromSettingsContent(content) {
  try {
    const parsed = JSON.parse(content);
    return normalizeEnvRecord(parsed?.env);
  } catch {
    return {};
  }
}

function sanitizeClaudeProfileSettingsContent(content = '') {
  const parsed = parseJsonOrNull(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '';
  }

  const next = { ...parsed };
  if (next.env && typeof next.env === 'object' && !Array.isArray(next.env)) {
    const env = { ...next.env };

    for (const key of CLAUDE_PROFILE_SETTINGS_STRIP_ENV_KEYS) {
      delete env[key];
    }

    if (Object.keys(env).length > 0) {
      next.env = env;
    } else {
      delete next.env;
    }
  }

  return JSON.stringify(next, null, 2);
}

async function maybeBuildClaudeHostSettingsTemplateResource() {
  if (!(await pathExists(CLI_AUTH_PATHS.claude.settings))) {
    return { resource: null, warning: '' };
  }

  const resource = await buildFileResource(
    CLI_AUTH_PATHS.claude.settings,
    toSandboxPath('.claude', 'settings.json'),
  );
  const sanitizedContent = sanitizeClaudeProfileSettingsContent(resource.content);
  if (!sanitizedContent) {
    return {
      resource: null,
      warning: 'Claude host settings.json is invalid JSON; skipping host preference sync for the sandbox profile.',
    };
  }

  return {
    resource: {
      sourcePath: resource.sourcePath,
      targetPath: resource.targetPath,
      content: sanitizedContent,
      envs: extractClaudeEnvFromSettingsContent(sanitizedContent),
    },
    warning:
      'Claude profile did not include settings.json; using the current host Claude settings as a sandbox preferences template without host auth envs.',
  };
}

export const DEFAULT_CLAUDE_PERMISSION_SETTINGS = {
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
};

export function normalizeClaudePermissionSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalizeList = (items) => {
    if (!Array.isArray(items)) {
      return [];
    }

    return [...new Set(
      items
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )];
  };

  const allowedTools = normalizeList(source.allowedTools);
  const disallowedTools = normalizeList(source.disallowedTools)
    .filter((tool) => !allowedTools.includes(tool));

  return {
    allowedTools,
    disallowedTools,
    skipPermissions: source.skipPermissions === true,
  };
}

function buildClaudePermissionSettingsOverride(settings = {}) {
  const normalized = normalizeClaudePermissionSettings(settings);
  return {
    allow: [...normalized.allowedTools],
    deny: [...normalized.disallowedTools],
    defaultMode: normalized.skipPermissions ? 'bypassPermissions' : 'default',
  };
}

export function mergeClaudePermissionSettingsIntoContent(content = '', settings = {}) {
  const parsed = parseJsonOrNull(content);
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  return JSON.stringify(
    {
      ...base,
      permissions: buildClaudePermissionSettingsOverride(settings),
    },
    null,
    2,
  );
}

export function applyClaudePermissionSettingsToBundle(bundle, settings = {}) {
  if (!bundle || bundle.providers?.claude?.mode === 'disabled') {
    return bundle;
  }

  const targetPath = toSandboxPath('.claude', 'settings.json');
  const files = Array.isArray(bundle.files) ? bundle.files.map((file) => ({ ...file })) : [];
  const existingIndex = files.findIndex((file) => file?.targetPath === targetPath);
  const existingFile = existingIndex === -1 ? null : files[existingIndex];
  const mergedFile = {
    sourcePath: existingFile?.sourcePath || CLI_AUTH_PATHS.claude.settings || 'claude-managed-settings',
    targetPath,
    content: mergeClaudePermissionSettingsIntoContent(existingFile?.content || '', settings),
  };

  if (existingIndex === -1) {
    files.push(mergedFile);
  } else {
    files[existingIndex] = mergedFile;
  }

  const nextProviders = bundle.providers?.claude
    ? {
        ...bundle.providers,
        claude: {
          ...bundle.providers.claude,
          synced: true,
          files: unique([...(bundle.providers.claude.files || []), targetPath]),
        },
      }
    : bundle.providers;

  return {
    ...bundle,
    files,
    providers: nextProviders,
  };
}

export async function writeClaudePermissionSettingsToHost(settings = {}) {
  const settingsPath = CLI_AUTH_PATHS.claude.settings || path.join(process.env.HOME || '', '.claude', 'settings.json');
  let existingContent = '';

  try {
    existingContent = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const nextContent = mergeClaudePermissionSettingsIntoContent(existingContent, settings);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, nextContent, 'utf8');

  return {
    path: settingsPath,
    content: nextContent,
    settings: normalizeClaudePermissionSettings(settings),
  };
}

function extractCodexEnvFromAuthContent(content) {
  return rewriteCodexAuthForSandbox(content).envs;
}

function buildCodexApiKeyAuthContent(apiKey) {
  return JSON.stringify(
    {
      auth_mode: 'api_key',
      OPENAI_API_KEY: apiKey,
    },
    null,
    2,
  );
}

export function rewriteCodexAuthForSandbox(content, options = {}) {
  const warnings = [];
  const fallbackApiKey = pickCodexCompatAuthKey(options.envs || {}, options);

  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      content,
      envs: buildCodexCompatEnvRecord(fallbackApiKey),
      warnings,
      omitted: false,
    };
  }

  const authMode = typeof parsed?.auth_mode === 'string' ? parsed.auth_mode.trim().toLowerCase() : '';
  const inlineApiKey =
    typeof parsed?.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim()
      ? parsed.OPENAI_API_KEY.trim()
      : '';
  const apiKey = inlineApiKey || fallbackApiKey;
  const usesChatGptAuth =
    authMode === 'chatgpt' ||
    Boolean(
      parsed?.tokens &&
      typeof parsed.tokens === 'object' &&
      (parsed.tokens.id_token || parsed.tokens.access_token || parsed.tokens.refresh_token),
    );

  if (usesChatGptAuth) {
    if (apiKey) {
      warnings.push('Codex browser refresh tokens are not mirrored into E2B; using API key auth instead.');
      return {
        content: buildCodexApiKeyAuthContent(apiKey),
        envs: buildCodexCompatEnvRecord(apiKey),
        warnings,
        omitted: false,
      };
    }

    warnings.push('Codex callback login will be synced directly into E2B and authenticated with the ChatGPT method.');
    return {
      content: JSON.stringify(parsed, null, 2),
      envs: {},
      warnings,
      omitted: false,
    };
  }

  if (apiKey) {
    return {
      content: buildCodexApiKeyAuthContent(apiKey),
      envs: buildCodexCompatEnvRecord(apiKey),
      warnings,
      omitted: false,
    };
  }

  return {
    content: JSON.stringify(parsed, null, 2),
    envs: {},
    warnings,
    omitted: false,
  };
}

export function rewriteCodexConfigForSandbox(content, options = {}) {
  const sandboxConnectHost = normalizeSandboxConnectHost(options.sandboxConnectHost);
  let parsed;
  const warnings = [];

  try {
    parsed = TOML.parse(content);
  } catch {
    return { content, envs: {}, warnings };
  }

  const envs = {};
  const providers = parsed?.model_providers && typeof parsed.model_providers === 'object'
    ? parsed.model_providers
    : {};
  let sawLoopbackBaseUrl = false;

  for (const providerConfig of Object.values(providers)) {
    if (!providerConfig || typeof providerConfig !== 'object') {
      continue;
    }

    const envKey =
      typeof providerConfig.env_key === 'string' && providerConfig.env_key.trim()
        ? providerConfig.env_key.trim()
        : '';

    if (envKey && process.env[envKey]) {
      envs[envKey] = process.env[envKey];
    }

    if (typeof providerConfig.base_url !== 'string' || !providerConfig.base_url.trim()) {
      continue;
    }

    try {
      const parsedUrl = new URL(providerConfig.base_url);
      if (isLoopbackLikeHost(parsedUrl.hostname)) {
        sawLoopbackBaseUrl = true;
        if (sandboxConnectHost) {
          parsedUrl.hostname = sandboxConnectHost;
          providerConfig.base_url = parsedUrl.toString();
        }
      }
    } catch {
      // Leave non-URL values untouched.
    }
  }

  if (sawLoopbackBaseUrl && !sandboxConnectHost) {
    warnings.push('Codex config references a loopback model provider URL, but no sandbox connect host was available for E2B.');
  }

  return {
    content: TOML.stringify(parsed),
    envs,
    warnings,
  };
}

async function buildCodexAuthResource(sourcePath, options = {}) {
  const content = await fs.readFile(sourcePath, 'utf8');
  const rewritten = rewriteCodexAuthForSandbox(content, options);

  return {
    sourcePath,
    targetPath: CODEX_AUTH_TARGET_PATH,
    content: rewritten.content,
    envs: rewritten.envs,
    warnings: rewritten.warnings,
    omitted: rewritten.omitted,
  };
}

async function buildCodexConfigResource(sourcePath, options = {}) {
  const content = await fs.readFile(sourcePath, 'utf8');
  const rewritten = rewriteCodexConfigForSandbox(content, options);

  return {
    sourcePath,
    targetPath: CODEX_CONFIG_TARGET_PATH,
    content: rewritten.content,
    envs: rewritten.envs,
    warnings: rewritten.warnings,
  };
}

function shouldMirrorHostCodexConfigForProfile(source) {
  const normalized = typeof source === 'string' ? source.trim().toLowerCase() : '';
  return normalized === 'callback' || normalized === 'device' || normalized === 'api_key';
}

export async function loadHostCodexConfigTemplateContent() {
  if (!(await pathExists(CLI_AUTH_PATHS.codex.config))) {
    return '';
  }

  try {
    const content = await fs.readFile(CLI_AUTH_PATHS.codex.config, 'utf8');
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

export async function maybeAttachHostCodexConfigToProfileResources(resources = {}, options = {}) {
  const files = normalizeStoredBundleFiles(resources.files);
  const envs = normalizeEnvRecord(resources.envs);
  const warnings = Array.isArray(resources.warnings)
    ? resources.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
    : [];

  if (!shouldMirrorHostCodexConfigForProfile(options.source) || hasTargetFile(files, CODEX_CONFIG_TARGET_PATH)) {
    return { files, envs, warnings };
  }

  const configContent = await loadHostCodexConfigTemplateContent();
  if (!configContent) {
    return { files, envs, warnings };
  }

  return {
    files: [
      ...files,
      {
        sourcePath: CLI_AUTH_PATHS.codex.config,
        targetPath: CODEX_CONFIG_TARGET_PATH,
        content: configContent,
        envs: {},
      },
    ],
    envs,
    warnings,
  };
}

function shouldPreferSandboxClaudeOauth(currentOauth, sandboxOauth) {
  if (!sandboxOauth?.accessToken) {
    return false;
  }

  if (!currentOauth?.accessToken) {
    return true;
  }

  const currentExpiresAt = normalizeClaudeOauthExpiresAt(currentOauth.expiresAt) || 0;
  const sandboxExpiresAt = normalizeClaudeOauthExpiresAt(sandboxOauth.expiresAt) || 0;

  if (sandboxExpiresAt > currentExpiresAt) {
    return true;
  }

  if (sandboxExpiresAt < currentExpiresAt) {
    return false;
  }

  if (sandboxOauth.accessToken !== currentOauth.accessToken) {
    return true;
  }

  if (
    sandboxOauth.refreshToken &&
    sandboxOauth.refreshToken !== currentOauth.refreshToken &&
    sandboxExpiresAt >= currentExpiresAt
  ) {
    return true;
  }

  return false;
}

function isSandboxMissingFileError(error) {
  const status = error?.status || error?.response?.status || null;
  const detail = [
    error?.message,
    error?.detail,
    error?.problem?.detail,
    error?.problem?.title,
    error?.response?.statusText,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .toLowerCase();

  if (status === 404) {
    return true;
  }

  if (status === 400 && detail.includes('path not found')) {
    return true;
  }

  return detail.includes('not found') || detail.includes('no such file') || detail.includes('path not found');
}

export async function syncClaudeProfileFromSandbox(client, options = {}) {
  const userId = Number(options.userId || 0);
  const profileId = Number(options.profileId || 0);

  if (!client || !userId || !profileId) {
    return { synced: false, reason: 'missing_context' };
  }

  const profileRecord = options.profileRecord || authProfilesDb.getById(userId, profileId);
  if (!profileRecord || profileRecord.provider !== 'claude') {
    return { synced: false, reason: 'profile_unavailable' };
  }

  let sandboxContent = '';
  try {
    const fileBuffer = await client.readFsFile({ path: toSandboxPath('.claude', '.credentials.json') });
    sandboxContent = Buffer.from(fileBuffer).toString('utf8');
  } catch (error) {
    if (isSandboxMissingFileError(error)) {
      return { synced: false, reason: 'missing_credentials_file' };
    }
    throw error;
  }

  const normalizedSandbox = normalizeClaudeOauthCredentialsPayload(sandboxContent);
  if (!normalizedSandbox?.claudeAiOauth?.accessToken) {
    return { synced: false, reason: 'invalid_sandbox_credentials' };
  }

  const currentPayload = normalizeStoredBundlePayload(profileRecord.payload_json);
  const credentialsTargetPath = toSandboxPath('.claude', '.credentials.json');
  const currentIndex = currentPayload.files.findIndex((file) => file.targetPath === credentialsTargetPath);
  const currentCredentials = currentIndex === -1
    ? null
    : normalizeClaudeOauthCredentialsPayload(currentPayload.files[currentIndex].content);

  if (!shouldPreferSandboxClaudeOauth(currentCredentials?.claudeAiOauth, normalizedSandbox.claudeAiOauth)) {
    return { synced: false, reason: 'sandbox_not_newer' };
  }

  const rewrittenSandbox = rewriteClaudeCredentialsForSandbox(sandboxContent);
  if (rewrittenSandbox.omitted || !rewrittenSandbox.content) {
    return { synced: false, reason: 'sandbox_credentials_not_reusable' };
  }

  const files = [...currentPayload.files];
  const nextFile = {
    sourcePath:
      typeof options.sourcePath === 'string' && options.sourcePath.trim()
        ? options.sourcePath.trim()
        : options.sandboxId
          ? `e2b:${options.sandboxId}`
          : 'e2b-sandbox',
    targetPath: credentialsTargetPath,
    content: rewrittenSandbox.content,
    envs: {},
  };

  if (currentIndex === -1) {
    files.push(nextFile);
  } else {
    files[currentIndex] = nextFile;
  }

  const envs = { ...currentPayload.envs };
  if (!shouldUseClaudeAuthTokenEnv(envs)) {
    delete envs.ANTHROPIC_AUTH_TOKEN;
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const metadata = {
    ...(currentPayload.metadata && typeof currentPayload.metadata === 'object' ? currentPayload.metadata : {}),
    claudeOauthPulledFromSandboxAt: new Date(now).toISOString(),
    ...(typeof options.sandboxId === 'string' && options.sandboxId.trim()
      ? { lastClaudeOauthSandboxId: options.sandboxId.trim() }
      : {}),
  };

  const nextPayload = createStoredAuthBundlePayload(
    'claude',
    {
      files,
      envs,
      warnings: currentPayload.warnings,
      metadata,
    },
    {
      summary: currentPayload.summary,
      metadata,
    },
  );

  const sandboxOauth = normalizedSandbox.claudeAiOauth;
  authProfilesDb.updatePayload(userId, profileId, {
    payload: nextPayload,
    summary: nextPayload.summary,
    metadata: nextPayload.metadata,
    email: firstNonEmptyString([
      options.email,
      profileRecord.email,
    ]) || null,
  });

  return {
    synced: true,
    reason: 'updated_from_sandbox',
    expiresAt: sandboxOauth.expiresAt || null,
    accessToken: sandboxOauth.accessToken,
    refreshToken: sandboxOauth.refreshToken || null,
    payload: nextPayload,
  };
}

async function detectClaudeAutoResources() {
  const files = [];
  const warnings = [];
  let envs = {};

  if (await pathExists(CLI_AUTH_PATHS.claude.settings)) {
    const resource = await buildFileResource(
      CLI_AUTH_PATHS.claude.settings,
      toSandboxPath('.claude', 'settings.json'),
      { extractEnvs: extractClaudeEnvFromSettingsContent },
    );
    files.push(resource);
    envs = mergeEnvRecords(envs, resource.envs);
  }

  if (await pathExists(CLI_AUTH_PATHS.claude.credentials)) {
    files.push(
      await buildFileResource(
        CLI_AUTH_PATHS.claude.credentials,
        toSandboxPath('.claude', '.credentials.json'),
      ),
    );
  }

  if (!hasOwn(envs, 'ANTHROPIC_API_KEY') && process.env.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  return { files, envs, warnings };
}

async function detectCodexAutoResources(options = {}) {
  const files = [];
  let envs = {};
  const warnings = [];
  const hostCodexEnv = getHostCodexEnvRecord();
  let configResource = null;

  if (await pathExists(CLI_AUTH_PATHS.codex.config)) {
    configResource = await buildCodexConfigResource(CLI_AUTH_PATHS.codex.config, options);
    files.push(configResource);
    envs = mergeEnvRecords(envs, configResource.envs);
    warnings.push(...(configResource.warnings || []));
  }

  if (await pathExists(CLI_AUTH_PATHS.codex.auth)) {
    const resource = await buildCodexAuthResource(CLI_AUTH_PATHS.codex.auth, {
      openaiApiKey: pickCodexCompatAuthKey(
        {
          ...hostCodexEnv,
          ...(configResource?.envs || {}),
        },
        options,
      ),
      envs: {
        ...hostCodexEnv,
        ...(configResource?.envs || {}),
      },
    });
    warnings.push(...(resource.warnings || []));
    if (!resource.omitted) {
      files.push(resource);
    }
    envs = mergeEnvRecords(envs, resource.envs);
  }

  mergeMissingEnvRecords(
    envs,
    buildCodexCompatEnvRecord(
      pickCodexCompatAuthKey(
        {
          ...hostCodexEnv,
          ...envs,
        },
        options,
      ),
      hostCodexEnv,
    ),
  );

  return { files, envs, warnings };
}

async function detectGeminiAutoResources() {
  const files = [];
  const envs = {};

  if (await pathExists(CLI_AUTH_PATHS.gemini.oauth)) {
    files.push(
      await buildFileResource(
        CLI_AUTH_PATHS.gemini.oauth,
        toSandboxPath('.gemini', 'oauth_creds.json'),
      ),
    );
  }

  if (await pathExists(CLI_AUTH_PATHS.gemini.accounts)) {
    files.push(
      await buildFileResource(
        CLI_AUTH_PATHS.gemini.accounts,
        toSandboxPath('.gemini', 'google_accounts.json'),
      ),
    );
  }

  if (process.env.GEMINI_API_KEY) {
    envs.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  return { files, envs, warnings: [] };
}

async function detectCursorAutoResources() {
  const envs = {};
  const warnings = [];

  if (process.env.CURSOR_API_KEY) {
    envs.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
  } else {
    warnings.push('Cursor browser login cannot be mirrored automatically yet; use CURSOR_API_KEY on the host.');
  }

  return {
    files: [],
    envs,
    warnings,
  };
}

async function detectAutoResources(provider, options = {}) {
  if (provider === 'claude') {
    return detectClaudeAutoResources();
  }

  if (provider === 'codex') {
    return detectCodexAutoResources(options);
  }

  if (provider === 'gemini') {
    return detectGeminiAutoResources();
  }

  return detectCursorAutoResources();
}

export async function detectE2BAutoResourcesForProvider(provider, options = {}) {
  return detectAutoResources(provider, options);
}

async function resolveClaudeCustomResources(inputPath) {
  const expandedPath = expandUserPath(inputPath);
  if (!expandedPath) {
    throw new Error('Claude custom auth path is required');
  }

  const stats = await fs.stat(expandedPath);
  const files = [];
  let envs = {};

  if (stats.isDirectory()) {
    const settingsPath = path.join(expandedPath, 'settings.json');
    const credentialsPath = path.join(expandedPath, '.credentials.json');

    if (await pathExists(settingsPath)) {
      const resource = await buildFileResource(
        settingsPath,
        toSandboxPath('.claude', 'settings.json'),
        { extractEnvs: extractClaudeEnvFromSettingsContent },
      );
      files.push(resource);
      envs = mergeEnvRecords(envs, resource.envs);
    }

    if (await pathExists(credentialsPath)) {
      files.push(await buildFileResource(credentialsPath, toSandboxPath('.claude', '.credentials.json')));
    }

    if (files.length === 0) {
      throw new Error('Claude custom directory must contain settings.json or .credentials.json');
    }

    return { files, envs, warnings: [] };
  }

  const basename = path.basename(expandedPath);
  const content = await fs.readFile(expandedPath, 'utf8');
  let targetPath = null;

  if (basename === 'settings.json') {
    targetPath = toSandboxPath('.claude', 'settings.json');
    envs = mergeEnvRecords(envs, extractClaudeEnvFromSettingsContent(content));
  } else if (basename === '.credentials.json') {
    targetPath = toSandboxPath('.claude', '.credentials.json');
  } else {
    const parsed = parseJsonOrNull(content);
    if (parsed?.env) {
      targetPath = toSandboxPath('.claude', 'settings.json');
      envs = mergeEnvRecords(envs, extractClaudeEnvFromSettingsContent(content));
    } else if (parsed?.claudeAiOauth) {
      targetPath = toSandboxPath('.claude', '.credentials.json');
    }
  }

  if (!targetPath) {
    throw new Error('Claude custom auth file must be settings.json or .credentials.json');
  }

  files.push({ sourcePath: expandedPath, targetPath, content, envs: { ...envs } });
  return { files, envs, warnings: [] };
}

async function resolveCodexCustomResources(inputPath, options = {}) {
  const expandedPath = expandUserPath(inputPath);
  if (!expandedPath) {
    throw new Error('Codex custom auth path is required');
  }

  const stats = await fs.stat(expandedPath);
  if (stats.isDirectory()) {
    const authPath = path.join(expandedPath, 'auth.json');
    const configPath = path.join(expandedPath, 'config.toml');
    if (!(await pathExists(authPath))) {
      throw new Error('Codex custom directory must contain auth.json');
    }
    const hostCodexEnv = getHostCodexEnvRecord();
    const files = [];
    const envs = { ...hostCodexEnv };
    const warnings = [];

    let configResource = null;

    if (await pathExists(configPath)) {
      configResource = await buildCodexConfigResource(configPath, options);
      files.push(configResource);
      mergeEnvRecords(envs, configResource.envs);
      warnings.push(...(configResource.warnings || []));
    }

    const resource = await buildCodexAuthResource(authPath, {
      openaiApiKey: pickCodexCompatAuthKey(
        {
          ...hostCodexEnv,
          ...(configResource?.envs || {}),
        },
        options,
      ),
      envs: {
        ...hostCodexEnv,
        ...(configResource?.envs || {}),
      },
    });
    if (!resource.omitted) {
      files.push(resource);
    }
    mergeEnvRecords(envs, resource.envs);
    warnings.push(...(resource.warnings || []));

    if (files.length === 0 && Object.keys(envs).length === 0 && warnings.length > 0) {
      throw new Error(warnings[0]);
    }

    return { files, envs, warnings };
  }

  const content = await fs.readFile(expandedPath, 'utf8');
  const parsed = parseJsonOrNull(content);
  if (path.basename(expandedPath) !== 'auth.json' && !parsed?.tokens && !parsed?.OPENAI_API_KEY) {
    throw new Error('Codex custom auth file must look like auth.json');
  }

  const rewritten = rewriteCodexAuthForSandbox(content, {
    openaiApiKey: pickCodexCompatAuthKey(getHostCodexEnvRecord(), options),
    envs: getHostCodexEnvRecord(),
  });

  if (rewritten.omitted && Object.keys(rewritten.envs || {}).length === 0) {
    throw new Error(
      rewritten.warnings[0] || 'Codex custom auth file does not contain reusable sandbox credentials.',
    );
  }

  return {
    files: rewritten.omitted
      ? []
      : [{
          sourcePath: expandedPath,
          targetPath: toSandboxPath('.codex', 'auth.json'),
          content: rewritten.content,
          envs: rewritten.envs,
        }],
    envs: rewritten.envs,
    warnings: rewritten.warnings,
  };
}

async function resolveGeminiCustomResources(inputPath) {
  const expandedPath = expandUserPath(inputPath);
  if (!expandedPath) {
    throw new Error('Gemini custom auth path is required');
  }

  const stats = await fs.stat(expandedPath);
  const files = [];

  if (stats.isDirectory()) {
    const oauthPath = path.join(expandedPath, 'oauth_creds.json');
    const accountsPath = path.join(expandedPath, 'google_accounts.json');

    if (await pathExists(oauthPath)) {
      files.push(await buildFileResource(oauthPath, toSandboxPath('.gemini', 'oauth_creds.json')));
    }

    if (await pathExists(accountsPath)) {
      files.push(await buildFileResource(accountsPath, toSandboxPath('.gemini', 'google_accounts.json')));
    }

    if (files.length === 0) {
      throw new Error('Gemini custom directory must contain oauth_creds.json or google_accounts.json');
    }

    return { files, envs: {}, warnings: [] };
  }

  const content = await fs.readFile(expandedPath, 'utf8');
  const parsed = parseJsonOrNull(content);
  let targetPath = null;

  if (path.basename(expandedPath) === 'oauth_creds.json' || parsed?.access_token || parsed?.refresh_token) {
    targetPath = toSandboxPath('.gemini', 'oauth_creds.json');
  } else if (path.basename(expandedPath) === 'google_accounts.json' || parsed?.active) {
    targetPath = toSandboxPath('.gemini', 'google_accounts.json');
  }

  if (!targetPath) {
    throw new Error('Gemini custom auth file must be oauth_creds.json or google_accounts.json');
  }

  return {
    files: [{
      sourcePath: expandedPath,
      targetPath,
      content,
      envs: {},
    }],
    envs: {},
    warnings: [],
  };
}

async function resolveCustomResources(provider, inputPath, options = {}) {
  if (provider === 'claude') {
    return resolveClaudeCustomResources(inputPath);
  }

  if (provider === 'codex') {
    return resolveCodexCustomResources(inputPath, options);
  }

  if (provider === 'gemini') {
    return resolveGeminiCustomResources(inputPath);
  }

  throw new Error('Cursor custom file auth is not supported yet');
}

export async function resolveE2BCustomResourcesForProvider(provider, inputPath, options = {}) {
  return resolveCustomResources(provider, inputPath, options);
}

function normalizeStoredBundleFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .filter((file) => file && typeof file === 'object')
    .map((file) => ({
      sourcePath: typeof file.sourcePath === 'string' ? file.sourcePath : 'auth-center',
      targetPath: typeof file.targetPath === 'string' ? file.targetPath : '',
      content: typeof file.content === 'string' ? file.content : '',
      envs: {},
    }))
    .filter((file) => file.targetPath && file.content);
}

function normalizeStoredBundlePayload(payload) {
  const parsedPayload =
    typeof payload === 'string'
      ? parseJsonOrNull(payload)
      : payload && typeof payload === 'object'
        ? payload
        : null;

  const files = normalizeStoredBundleFiles(parsedPayload?.files);
  const envs = normalizeEnvRecord(parsedPayload?.envs);
  const warnings = Array.isArray(parsedPayload?.warnings)
    ? parsedPayload.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
    : [];

  return {
    provider: typeof parsedPayload?.provider === 'string' ? parsedPayload.provider : null,
    summary: typeof parsedPayload?.summary === 'string' ? parsedPayload.summary : buildAutoSummary({ files, envs, warnings }),
    files,
    envs,
    warnings,
    metadata: parsedPayload?.metadata && typeof parsedPayload.metadata === 'object' ? parsedPayload.metadata : {},
  };
}

export function createStoredAuthBundlePayload(provider, resources = {}, options = {}) {
  const normalizedFiles = normalizeStoredBundleFiles(resources.files);
  const normalizedEnvs = normalizeEnvRecord(resources.envs);
  const normalizedWarnings = Array.isArray(resources.warnings)
    ? resources.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
    : [];

  return {
    version: 1,
    provider,
    summary:
      typeof options.summary === 'string' && options.summary.trim()
        ? options.summary.trim()
        : buildAutoSummary({ files: normalizedFiles, envs: normalizedEnvs, warnings: normalizedWarnings }),
    files: normalizedFiles.map((file) => ({
      sourcePath: file.sourcePath,
      targetPath: file.targetPath,
      content: file.content,
    })),
    envs: normalizedEnvs,
    warnings: normalizedWarnings,
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
  };
}

export function summarizeStoredAuthBundlePayload(payload) {
  const normalized = normalizeStoredBundlePayload(payload);
  return {
    summary: normalized.summary,
    files: summarizeFileTargets(normalized.files),
    envKeys: summarizeEnvKeys(normalized.envs),
    warnings: normalized.warnings,
  };
}

export function rewriteStoredAuthBundleForSandbox(provider, payload, options = {}) {
  const normalized = normalizeStoredBundlePayload(payload);
  if (provider === 'claude') {
    const files = [];
    const envs = { ...normalized.envs };
    const warnings = [...(normalized.warnings || [])];

    for (const file of normalized.files) {
      if (file.targetPath === toSandboxPath('.claude', '.credentials.json')) {
        const rewritten = rewriteClaudeCredentialsForSandbox(file.content);
        warnings.push(...(rewritten.warnings || []));
        if (!rewritten.omitted && rewritten.content) {
          files.push({
            ...file,
            content: rewritten.content,
          });
        }
        continue;
      }

      files.push(file);
    }

    if (hasTargetFile(files, toSandboxPath('.claude', '.credentials.json')) && !shouldUseClaudeAuthTokenEnv(envs)) {
      envs.ANTHROPIC_AUTH_TOKEN = null;
    }

    return {
      ...normalized,
      files,
      envs,
      warnings: unique(warnings),
    };
  }

  if (provider !== 'codex') {
    return normalized;
  }

  const files = [];
  const envs = { ...normalized.envs };
  const warnings = [...(normalized.warnings || [])];
  const bundledApiKey = pickCodexCompatAuthKey(normalized.envs, options);

  for (const file of normalized.files) {
    if (file.targetPath === CODEX_AUTH_TARGET_PATH) {
      const rewritten = rewriteCodexAuthForSandbox(file.content, {
        ...options,
        openaiApiKey: bundledApiKey,
        envs,
      });
      warnings.push(...(rewritten.warnings || []));
      mergeEnvRecords(envs, rewritten.envs);
      if (!rewritten.omitted && rewritten.content) {
        files.push({
          ...file,
          content: rewritten.content,
        });
      }
      continue;
    }

    if (file.targetPath === CODEX_CONFIG_TARGET_PATH) {
      const rewritten = rewriteCodexConfigForSandbox(file.content, options);
      warnings.push(...(rewritten.warnings || []));
      mergeMissingEnvRecords(envs, rewritten.envs);
      files.push({
        ...file,
        content: rewritten.content,
      });
      continue;
    }

    files.push(file);
  }

  mergeMissingEnvRecords(
    envs,
    buildCodexCompatEnvRecord(
      pickCodexCompatAuthKey(envs, options),
      envs,
    ),
  );

  const configTemplateContent = firstNonEmptyString([
    options.codexConfigTemplateContent,
    normalized.metadata?.codexConfigTemplateContent,
  ]);

  if (configTemplateContent && !hasTargetFile(files, CODEX_CONFIG_TARGET_PATH)) {
    const rewritten = rewriteCodexConfigForSandbox(configTemplateContent, options);
    warnings.push(...(rewritten.warnings || []));
    if (typeof options.codexConfigTemplateWarning === 'string' && options.codexConfigTemplateWarning.trim()) {
      warnings.push(options.codexConfigTemplateWarning.trim());
    }
    mergeMissingEnvRecords(envs, rewritten.envs);
    files.push({
      sourcePath: options.codexConfigTemplateSourcePath || CLI_AUTH_PATHS.codex.config || 'codex-config-template',
      targetPath: CODEX_CONFIG_TARGET_PATH,
      content: rewritten.content,
      envs: {},
    });
  }

  return {
    ...normalized,
    files,
    envs,
    warnings: unique(warnings),
  };
}

async function resolveProfileResources(provider, profileRecord, options = {}) {
  if (!profileRecord) {
    throw new Error(`${provider} auth profile was not found`);
  }

  if (profileRecord.provider !== provider) {
    throw new Error(`Auth profile ${profileRecord.id} does not belong to ${provider}`);
  }

  const effectiveProfileRecord = provider === 'claude'
    ? await maybeRefreshClaudeProfileRecord(profileRecord, options)
    : profileRecord;

  const payload = normalizeStoredBundlePayload(effectiveProfileRecord.payload_json);
  if (payload.provider && payload.provider !== provider) {
    throw new Error(`Stored auth bundle provider mismatch for profile ${effectiveProfileRecord.id}`);
  }

  let codexConfigTemplateContent = '';
  let codexConfigTemplateWarning = '';
  let codexConfigTemplateSourcePath = '';

  if (
    provider === 'codex' &&
    !hasTargetFile(payload.files, CODEX_CONFIG_TARGET_PATH) &&
    shouldMirrorHostCodexConfigForProfile(effectiveProfileRecord.source)
  ) {
    codexConfigTemplateContent = await loadHostCodexConfigTemplateContent();
    if (codexConfigTemplateContent) {
      codexConfigTemplateWarning =
        'Codex profile did not include config.toml; using the current host Codex config as a sandbox template.';
      codexConfigTemplateSourcePath = CLI_AUTH_PATHS.codex.config;
    }
  }

  let resolvedPayload = rewriteStoredAuthBundleForSandbox(provider, payload, {
    ...options,
    codexConfigTemplateContent,
    codexConfigTemplateWarning,
    codexConfigTemplateSourcePath,
  });

  if (
    provider === 'claude' &&
    !hasTargetFile(resolvedPayload.files, toSandboxPath('.claude', 'settings.json'))
  ) {
    const { resource, warning } = await maybeBuildClaudeHostSettingsTemplateResource();
    if (resource) {
      const envs = { ...resolvedPayload.envs };
      mergeMissingEnvRecords(envs, resource.envs);
      resolvedPayload = {
        ...resolvedPayload,
        files: [...resolvedPayload.files, resource],
        envs,
        warnings: unique([...(resolvedPayload.warnings || []), warning]),
      };
    } else if (warning) {
      resolvedPayload = {
        ...resolvedPayload,
        warnings: unique([...(resolvedPayload.warnings || []), warning]),
      };
    }
  }

  if (
    provider === 'codex' &&
    resolvedPayload.files.length === 0 &&
    Object.keys(resolvedPayload.envs).length === 0 &&
    resolvedPayload.warnings.length > 0
  ) {
    throw new Error(resolvedPayload.warnings[0]);
  }

  return {
    files: resolvedPayload.files,
    envs: resolvedPayload.envs,
    warnings: resolvedPayload.warnings,
    summary: resolvedPayload.summary,
  };
}

function buildProviderOverview(provider, status, resources) {
  const autoEnvKeys = summarizeEnvKeys(resources.envs);
  const filePaths = resources.files.map((file) => file.sourcePath);
  const warnings = [...(resources.warnings || [])];

  if (
    provider === 'cursor' &&
    status.authenticated &&
    autoEnvKeys.length === 0
  ) {
    warnings.push('Host Cursor login was detected, but only CURSOR_API_KEY can currently be mirrored into E2B.');
  }

  return {
    authenticated: Boolean(status.authenticated),
    email: status.email || null,
    error: status.error || null,
    method: status.method || null,
    defaultMode: filePaths.length > 0 || autoEnvKeys.length > 0 ? 'auto' : 'disabled',
    supportsCustomPath: provider !== 'cursor',
    customPathHint: CUSTOM_PATH_HINTS[provider],
    auto: {
      available: filePaths.length > 0 || autoEnvKeys.length > 0,
      summary: buildAutoSummary({ files: resources.files, envs: resources.envs, warnings }),
      files: filePaths,
      envKeys: autoEnvKeys,
      warnings,
    },
  };
}

export async function getE2BAuthOverview() {
  const [claudeStatus, cursorStatus, codexStatus, geminiStatus] = await Promise.all([
    checkClaudeCredentials(),
    checkCursorStatus(),
    checkCodexCredentials(),
    checkGeminiCredentials(),
  ]);

  const [claudeResources, cursorResources, codexResources, geminiResources] = await Promise.all([
    detectAutoResources('claude'),
    detectAutoResources('cursor'),
    detectAutoResources('codex'),
    detectAutoResources('gemini'),
  ]);

  return {
    claude: buildProviderOverview('claude', claudeStatus, claudeResources),
    cursor: buildProviderOverview('cursor', cursorStatus, cursorResources),
    codex: buildProviderOverview('codex', codexStatus, codexResources),
    gemini: buildProviderOverview('gemini', geminiStatus, geminiResources),
  };
}

export function getDefaultE2BAuthSelections(overview = null) {
  const defaultSelections = {};

  for (const provider of E2B_AUTH_PROVIDERS) {
    const fallbackMode = overview?.[provider]?.defaultMode || 'auto';
    defaultSelections[provider] = normalizeSelection(null, fallbackMode);
  }

  return defaultSelections;
}

export function normalizeE2BAuthSelections(input = {}, overview = null) {
  const fallbackSelections = getDefaultE2BAuthSelections(overview);
  const normalized = {};

  for (const provider of E2B_AUTH_PROVIDERS) {
    normalized[provider] = normalizeSelection(input?.[provider], fallbackSelections[provider].mode);
  }

  return normalized;
}

export function sanitizeE2BAuthSelections(input = {}, overview = null) {
  const normalized = normalizeE2BAuthSelections(input, overview);
  const sanitized = {};

  for (const provider of E2B_AUTH_PROVIDERS) {
    sanitized[provider] = sanitizeSelection(normalized[provider]);
  }

  return sanitized;
}

export function extractE2BAuthSelectionsFromMetadata(metadataJson, overview = null) {
  const metadata = typeof metadataJson === 'string' ? parseJsonOrNull(metadataJson) : metadataJson;
  if (!metadata?.authSelections) {
    return getDefaultE2BAuthSelections(overview);
  }

  return normalizeE2BAuthSelections(metadata.authSelections, overview);
}

export async function resolveE2BAuthBundle(selections = {}, options = {}) {
  const { strict = true, overview = null, userId = null, sandboxConnectHost = '' } = options;
  const normalizedSelections = normalizeE2BAuthSelections(selections, overview);
  const envs = {};
  const files = [];
  const providers = {};
  const warnings = [];

  for (const provider of E2B_AUTH_PROVIDERS) {
    const selection = normalizedSelections[provider];
    const providerWarnings = [];

    if (selection.mode === 'disabled') {
      const disabledEnvs = {};
      for (const key of OWNED_ENV_KEYS[provider]) {
        disabledEnvs[key] = null;
      }

      mergeEnvRecords(envs, disabledEnvs);
      providers[provider] = {
        mode: 'disabled',
        synced: false,
        files: [],
        envKeys: [],
        warnings: [],
      };
      continue;
    }

    try {
      let resources;

      if (selection.mode === 'custom') {
        resources = await resolveCustomResources(provider, selection.path, { sandboxConnectHost });
      } else if (selection.mode === 'profile') {
        if (!selection.profileId || !userId) {
          throw new Error(`${provider} auth profile is missing or unavailable`);
        }

        const profileRecord = authProfilesDb.getById(userId, selection.profileId);
        resources = await resolveProfileResources(provider, profileRecord, {
          ...options,
          sandboxConnectHost,
        });
      } else {
        resources = await detectAutoResources(provider, { sandboxConnectHost });
      }

      if (provider === 'claude') {
        resources = pinClaudeToNonApiKeyAuth(resources);
      }

      for (const resource of resources.files) {
        files.push({
          sourcePath: resource.sourcePath,
          targetPath: resource.targetPath,
          content: resource.content,
        });
      }

      mergeEnvRecords(envs, resources.envs);
      providerWarnings.push(...(resources.warnings || []));

      providers[provider] = {
        mode: selection.mode,
        synced: resources.files.length > 0 || summarizeEnvKeys(resources.envs).length > 0,
        files: summarizeFileTargets(resources.files),
        envKeys: summarizeEnvKeys(resources.envs),
        ...(selection.mode === 'profile' && selection.profileId ? { profileId: selection.profileId } : {}),
        ...(selection.mode === 'profile' && resources.summary ? { profileSummary: resources.summary } : {}),
        warnings: providerWarnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to resolve ${provider} auth`;
      providerWarnings.push(message);
      warnings.push(`${provider}: ${message}`);

      for (const key of OWNED_ENV_KEYS[provider]) {
        envs[key] = null;
      }

      providers[provider] = {
        mode: selection.mode,
        synced: false,
        files: [],
        envKeys: [],
        warnings: providerWarnings,
      };

      if (strict) {
        throw new Error(message);
      }
    }
  }

  return {
    selections: normalizedSelections,
    envs,
    files,
    providers,
    warnings: unique(warnings),
  };
}

export function summarizeE2BAuthBundle(bundle) {
  const providers = {};

  for (const provider of E2B_AUTH_PROVIDERS) {
    providers[provider] = bundle.providers?.[provider] || {
      mode: 'disabled',
      synced: false,
      files: [],
      envKeys: [],
      warnings: [],
    };
  }

  return {
    providers,
    warnings: unique(bundle.warnings || []),
  };
}

function escapeShell(value) {
  return String(value).replace(/'/g, `'\\''`);
}

export async function syncE2BAuthToSandbox(client, bundle) {
  if (!client) {
    return;
  }

  const desiredTargets = new Set((bundle?.files || []).map((file) => file.targetPath));
  const managedTargets = new Set();

  for (const provider of E2B_AUTH_PROVIDERS) {
    for (const target of MANAGED_PROVIDER_FILE_TARGETS[provider] || []) {
      managedTargets.add(target);
    }
  }

  const staleTargets = [...managedTargets].filter((target) => !desiredTargets.has(target));
  if (staleTargets.length > 0) {
    const cleanupCommand = staleTargets.map((target) => `rm -f '${escapeShell(target)}'`).join(' && ');
    try {
      await client.runProcess({
        command: 'bash',
        args: ['-lc', cleanupCommand],
      });
    } catch (error) {
      console.warn('[E2B Auth] cleanup failed:', error?.message || error);
    }
  }

  if (!bundle?.files?.length) {
    return;
  }

  const directories = unique(bundle.files.map((file) => path.posix.dirname(file.targetPath)));
  const mkdirCommand = directories
    .map((directory) => `mkdir -p '${escapeShell(directory)}'`)
    .join(' && ');

  if (mkdirCommand) {
    await client.runProcess({
      command: 'bash',
      args: ['-lc', mkdirCommand],
    });
  }

  const changedFiles = [];

  for (const file of bundle.files) {
    let existingContent = null;

    try {
      const fileBuffer = await client.readFsFile({ path: file.targetPath });
      existingContent = Buffer.from(fileBuffer).toString('utf8');
    } catch (error) {
      if (!isSandboxMissingFileError(error)) {
        throw error;
      }
    }

    if (existingContent === file.content) {
      continue;
    }

    await client.writeFsFile({ path: file.targetPath }, file.content);
    changedFiles.push(file);
  }

  const chmodCommands = changedFiles.map((file) => `chmod 600 '${escapeShell(file.targetPath)}'`);
  if (chmodCommands.length > 0) {
    try {
      await client.runProcess({
        command: 'bash',
        args: ['-lc', chmodCommands.join(' && ')],
      });
    } catch (error) {
      console.warn('[E2B Auth] chmod failed:', error?.message || error);
    }
  }
}
