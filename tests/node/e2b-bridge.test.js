import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempDbPath = path.join(
  os.tmpdir(),
  `claudecodeui-e2b-test-${process.pid}-${Date.now()}.sqlite`,
);

process.env.DATABASE_PATH = tempDbPath;
fs.closeSync(fs.openSync(tempDbPath, 'w'));

const {
  CLAUDE_CODE_OAUTH_SCOPES,
  DEFAULT_CLAUDE_PERMISSION_SETTINGS,
  applyClaudePermissionSettingsToBundle,
  normalizeClaudePermissionSettings,
  resolveE2BAuthBundle,
  rewriteClaudeCredentialsForSandbox,
  syncClaudeProfileFromSandbox,
  rewriteCodexAuthForSandbox,
  rewriteCodexConfigForSandbox,
  rewriteStoredAuthBundleForSandbox,
  syncE2BAuthToSandbox,
} = await import('../../server/providers/e2b/auth-sync.js');
const {
  resolveSandboxConnectHostFromRequest,
} = await import('../../server/providers/e2b/connect-host.js');
const {
  CLI_AUTH_PATHS,
} = await import('../../server/lib/cli-auth-status.js');
const {
  summarizeE2BBridgeError,
  __internal__runE2BAcpPromptWithTimeout,
} = await import('../../server/providers/e2b/session-bridge.js');
const {
  buildNativeClaudeLaunchScript,
  buildNativeClaudePermissionResponse,
  buildNativeClaudeUserMessage,
  normalizeNativeClaudePermissionRequest,
  parseNativeClaudeProtocolLine,
} = await import('../../server/providers/e2b/native-claude-runner.js');
const {
  resolveE2BTemplate,
  ensureNativeCliInstalled,
  getNativeCliRuntimeStatus,
} = await import('../../server/providers/e2b/sandbox-manager.js');
const {
  coalesceHistoryMessages,
  fetchHistory,
  mergeE2BHistoryMessages,
  normalizeEvent,
} = await import('../../server/providers/e2b/adapter.js');
const {
  authProfilesDb,
  initializeDatabase,
  e2bSessionMessagesDb,
  userClaudeSettingsDb,
  userDb,
} = await import('../../server/database/db.js');

await initializeDatabase();

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCodexApiKey = process.env.CODEX_API_KEY;
const originalCliproxyApiKey = process.env.CLIPROXY_API_KEY;
const originalGithubRedirectUri = process.env.GITHUB_REDIRECT_URI;
const originalE2BTemplate = process.env.E2B_TEMPLATE;
const originalE2BTemplateName = process.env.E2B_TEMPLATE_NAME;

after(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }

  if (originalCodexApiKey === undefined) {
    delete process.env.CODEX_API_KEY;
  } else {
    process.env.CODEX_API_KEY = originalCodexApiKey;
  }

  if (originalCliproxyApiKey === undefined) {
    delete process.env.CLIPROXY_API_KEY;
  } else {
    process.env.CLIPROXY_API_KEY = originalCliproxyApiKey;
  }

  if (originalGithubRedirectUri === undefined) {
    delete process.env.GITHUB_REDIRECT_URI;
  } else {
    process.env.GITHUB_REDIRECT_URI = originalGithubRedirectUri;
  }

  if (originalE2BTemplate === undefined) {
    delete process.env.E2B_TEMPLATE;
  } else {
    process.env.E2B_TEMPLATE = originalE2BTemplate;
  }

  if (originalE2BTemplateName === undefined) {
    delete process.env.E2B_TEMPLATE_NAME;
  } else {
    process.env.E2B_TEMPLATE_NAME = originalE2BTemplateName;
  }
});

test('resolveE2BTemplate maps legacy cloudagent to the project template', () => {
  process.env.E2B_TEMPLATE = 'cloudagent';
  delete process.env.E2B_TEMPLATE_NAME;

  assert.equal(resolveE2BTemplate(), 'claudecodeui-cloud-agent:latest');
});

test('runE2BAcpPromptWithTimeout resolves prompt responses before the timeout', async () => {
  const result = await __internal__runE2BAcpPromptWithTimeout(
    async () => 'ok',
    {
      sessionId: 'e2b_timeout_ok',
      timeoutMs: 50,
    },
  );

  assert.equal(result, 'ok');
});

test('runE2BAcpPromptWithTimeout rejects hung prompt requests with a transport timeout error', async () => {
  await assert.rejects(
    __internal__runE2BAcpPromptWithTimeout(
      () => new Promise(() => {}),
      {
        sessionId: 'e2b_timeout_hang',
        timeoutMs: 20,
      },
    ),
    (error) => {
      assert.equal(error?.code, 'E2B_ACP_PROMPT_TIMEOUT');
      assert.match(error?.message || '', /sandbox acknowledged the request/i);
      assert.equal(error?.sessionId, 'e2b_timeout_hang');
      return true;
    },
  );
});

test('resolveE2BTemplate falls back to E2B_TEMPLATE_NAME when E2B_TEMPLATE is unset', () => {
  delete process.env.E2B_TEMPLATE;
  process.env.E2B_TEMPLATE_NAME = 'custom-cloud-agent';

  assert.equal(resolveE2BTemplate(), 'custom-cloud-agent:latest');
});

test('getNativeCliRuntimeStatus inspects native Claude and Codex binaries via the sandbox client', async () => {
  const fakeClient = {
    sandboxId: 'e2b/fake-native-runtime',
    async runProcess({ command, args }) {
      const joined = [command, ...(args || [])].join(' ');

      if (joined.includes('command -v claude')) {
        return { exitCode: 0, stdout: '/usr/local/bin/claude\n', stderr: '' };
      }

      if (joined.includes('command -v codex')) {
        return { exitCode: 0, stdout: '/usr/local/bin/codex\n', stderr: '' };
      }

      if (command === 'claude') {
        return { exitCode: 0, stdout: '2.1.87 (Claude Code)\n', stderr: '' };
      }

      if (command === 'codex') {
        return { exitCode: 0, stdout: 'codex-cli 0.118.0\n', stderr: '' };
      }

      throw new Error(`Unexpected command: ${joined}`);
    },
  };

  const status = await getNativeCliRuntimeStatus(fakeClient);
  assert.equal(status.available, true);
  assert.equal(status.sandboxId, 'e2b/fake-native-runtime');
  assert.deepEqual(status.providers.claude, {
    installed: true,
    path: '/usr/local/bin/claude',
    version: '2.1.87 (Claude Code)',
    exitCode: 0,
    error: '',
  });
  assert.deepEqual(status.providers.codex, {
    installed: true,
    path: '/usr/local/bin/codex',
    version: 'codex-cli 0.118.0',
    exitCode: 0,
    error: '',
  });
});

test('ensureNativeCliInstalled can refresh an already-installed CLI to the configured package spec', async () => {
  let codexVersion = 'codex-cli 0.101.0';
  const commands = [];
  const fakeClient = {
    sandboxId: 'e2b/fake-refresh-runtime',
    async runProcess({ command, args }) {
      const joined = [command, ...(args || [])].join(' ');
      commands.push(joined);

      if (joined.includes('command -v codex')) {
        return { exitCode: 0, stdout: '/usr/local/bin/codex\n', stderr: '' };
      }

      if (command === 'codex') {
        return { exitCode: 0, stdout: codexVersion + '\n', stderr: '' };
      }

      if (joined.includes('npm install -g @openai/codex@latest')) {
        codexVersion = 'codex-cli 0.118.0';
        return { exitCode: 0, stdout: 'updated\n', stderr: '' };
      }

      throw new Error(`Unexpected command: ${joined}`);
    },
  };

  const status = await ensureNativeCliInstalled(fakeClient, 'codex', { forceReinstall: true });
  assert.equal(commands.some((entry) => entry.includes('npm install -g @openai/codex@latest')), true);
  assert.equal(status.version, 'codex-cli 0.118.0');
});

test('rewriteCodexAuthForSandbox converts chatgpt auth into api_key auth', () => {
  const rewritten = rewriteCodexAuthForSandbox(
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: 'sk-inline',
        tokens: {
          refresh_token: 'refresh-token',
        },
      },
      null,
      2,
    ),
  );

  assert.equal(rewritten.omitted, false);
  assert.deepEqual(rewritten.envs, {
    OPENAI_API_KEY: 'sk-inline',
    CODEX_API_KEY: 'sk-inline',
  });
  assert.match(rewritten.warnings.join(' '), /not mirrored/i);

  const parsed = JSON.parse(rewritten.content);
  assert.equal(parsed.auth_mode, 'api_key');
  assert.equal(parsed.OPENAI_API_KEY, 'sk-inline');
  assert.equal('tokens' in parsed, false);
});

test('rewriteCodexAuthForSandbox preserves chatgpt auth when no API key is available', () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.CLIPROXY_API_KEY;

  const rewritten = rewriteCodexAuthForSandbox(
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          refresh_token: 'refresh-token',
        },
      },
      null,
      2,
    ),
    { openaiApiKey: '' },
  );

  assert.equal(rewritten.omitted, false);
  assert.deepEqual(rewritten.envs, {});
  assert.match(rewritten.warnings.join(' '), /synced directly/i);

  const parsed = JSON.parse(rewritten.content);
  assert.equal(parsed.auth_mode, 'chatgpt');
  assert.equal(parsed.tokens.refresh_token, 'refresh-token');
});

test('rewriteCodexAuthForSandbox can fall back to a custom provider key when OpenAI API key is absent', () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  process.env.CLIPROXY_API_KEY = 'clip-only-key';

  const rewritten = rewriteCodexAuthForSandbox(
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          refresh_token: 'refresh-token',
        },
      },
      null,
      2,
    ),
    {
      envs: {
        CLIPROXY_API_KEY: 'clip-only-key',
      },
    },
  );

  assert.equal(rewritten.omitted, false);
  assert.deepEqual(rewritten.envs, {
    OPENAI_API_KEY: 'clip-only-key',
    CODEX_API_KEY: 'clip-only-key',
  });
  assert.equal(JSON.parse(rewritten.content).OPENAI_API_KEY, 'clip-only-key');
});

test('rewriteClaudeCredentialsForSandbox normalizes Claude OAuth credentials for native Claude Code', () => {
  const rewritten = rewriteClaudeCredentialsForSandbox(
    JSON.stringify({
      email: 'brund768@gmail.com',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '1775167584049',
    }),
  );

  assert.equal(rewritten.omitted, false);
  const parsed = JSON.parse(rewritten.content);
  assert.deepEqual(parsed, {
    claudeAiOauth: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1775167584049,
      scopes: CLAUDE_CODE_OAUTH_SCOPES,
      subscriptionType: null,
      rateLimitTier: null,
    },
  });
});

test('normalizeClaudePermissionSettings dedupes entries and removes deny overlaps', () => {
  assert.deepEqual(
    normalizeClaudePermissionSettings({
      allowedTools: ['bash:pwd', ' bash:pwd ', '', 'read:file'],
      disallowedTools: ['read:file', ' edit:file ', 'edit:file', null],
      skipPermissions: true,
    }),
    {
      allowedTools: ['bash:pwd', 'read:file'],
      disallowedTools: ['edit:file'],
      skipPermissions: true,
    },
  );

  assert.deepEqual(normalizeClaudePermissionSettings(null), DEFAULT_CLAUDE_PERMISSION_SETTINGS);
});

test('applyClaudePermissionSettingsToBundle preserves host env while injecting Claude permissions', () => {
  const bundle = {
    envs: {
      ANTHROPIC_AUTH_TOKEN: 'oauth-token',
    },
    files: [
      {
        sourcePath: 'profile',
        targetPath: '/home/user/.claude/settings.json',
        content: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://proxy.example.com',
          },
          ui: {
            theme: 'dark',
          },
        }, null, 2),
      },
    ],
    providers: {
      claude: {
        mode: 'profile',
        synced: false,
        files: [],
      },
    },
  };

  const updated = applyClaudePermissionSettingsToBundle(bundle, {
    allowedTools: ['bash:pwd'],
    disallowedTools: ['edit:file'],
    skipPermissions: true,
  });

  assert.notEqual(updated, bundle);
  assert.deepEqual(updated.envs, bundle.envs);

  const settingsFile = updated.files.find((file) => file.targetPath === '/home/user/.claude/settings.json');
  assert.ok(settingsFile);

  const parsed = JSON.parse(settingsFile.content);
  assert.deepEqual(parsed.env, { ANTHROPIC_BASE_URL: 'https://proxy.example.com' });
  assert.deepEqual(parsed.ui, { theme: 'dark' });
  assert.deepEqual(parsed.permissions, {
    allow: ['bash:pwd'],
    deny: ['edit:file'],
    defaultMode: 'bypassPermissions',
  });

  assert.deepEqual(updated.providers.claude.files, ['/home/user/.claude/settings.json']);
  assert.equal(updated.providers.claude.synced, true);
});

test('userClaudeSettingsDb persists normalized settings and returns defaults', () => {
  const user = userDb.createUser(`claude-settings-${Date.now()}`, 'hash');

  assert.deepEqual(
    userClaudeSettingsDb.getSettings(user.id),
    DEFAULT_CLAUDE_PERMISSION_SETTINGS,
  );

  const saved = userClaudeSettingsDb.updateSettings(user.id, {
    allowedTools: ['bash:pwd', 'bash:pwd', 'read:file'],
    disallowedTools: ['read:file', 'edit:file', ' edit:file '],
    skipPermissions: true,
  });

  assert.deepEqual(saved, {
    allowedTools: ['bash:pwd', 'read:file'],
    disallowedTools: ['edit:file'],
    skipPermissions: true,
  });

  assert.deepEqual(userClaudeSettingsDb.getSettings(user.id), saved);
});

test('syncE2BAuthToSandbox only writes changed managed auth files', async () => {
  const writes = [];
  const commands = [];
  const bundle = {
    files: [
      {
        targetPath: '/home/user/.claude/settings.json',
        content: '{"permissions":{"allow":["bash:pwd"]}}',
      },
      {
        targetPath: '/home/user/.claude/.credentials.json',
        content: '{"claudeAiOauth":{"accessToken":"fresh"}}',
      },
    ],
  };

  await syncE2BAuthToSandbox(
    {
      async runProcess(payload) {
        commands.push([payload.command, ...(payload.args || [])].join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async readFsFile({ path: targetPath }) {
        if (targetPath === '/home/user/.claude/settings.json') {
          return Buffer.from('{"permissions":{"allow":["bash:pwd"]}}', 'utf8');
        }

        if (targetPath === '/home/user/.claude/.credentials.json') {
          return Buffer.from('{"claudeAiOauth":{"accessToken":"stale"}}', 'utf8');
        }

        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      async writeFsFile({ path: targetPath }, content) {
        writes.push({ path: targetPath, content });
      },
    },
    bundle,
  );

  assert.deepEqual(writes, [
    {
      path: '/home/user/.claude/.credentials.json',
      content: '{"claudeAiOauth":{"accessToken":"fresh"}}',
    },
  ]);
  assert.ok(commands.some((command) => command.includes("mkdir -p '/home/user/.claude'")));
  assert.ok(commands.some((command) => command.includes("chmod 600 '/home/user/.claude/.credentials.json'")));
  assert.ok(commands.every((command) => !command.includes("chmod 600 '/home/user/.claude/settings.json'")));
});

test('syncE2BAuthToSandbox treats sandbox-agent 400 path not found as a missing file', async () => {
  const writes = [];

  await syncE2BAuthToSandbox(
    {
      async runProcess() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async readFsFile() {
        const error = new Error('Invalid Request');
        error.status = 400;
        error.problem = {
          detail: 'invalid request: path not found: /home/user/.claude/.credentials.json',
        };
        throw error;
      },
      async writeFsFile({ path: targetPath }, content) {
        writes.push({ path: targetPath, content });
      },
    },
    {
      files: [
        {
          targetPath: '/home/user/.claude/.credentials.json',
          content: '{"claudeAiOauth":{"accessToken":"fresh"}}',
        },
      ],
    },
  );

  assert.deepEqual(writes, [
    {
      path: '/home/user/.claude/.credentials.json',
      content: '{"claudeAiOauth":{"accessToken":"fresh"}}',
    },
  ]);
});

test('resolveE2BAuthBundle refreshes expired Claude profile tokens before syncing to E2B', async () => {
  const user = userDb.createUser(`claude-refresh-${Date.now()}`, 'hash');
  const profileId = authProfilesDb.create(user.id, {
    provider: 'claude',
    profileName: 'Expired Claude OAuth',
    source: 'callback',
    email: 'stale@example.com',
    payload: {
      version: 1,
      provider: 'claude',
      summary: 'Stored expired Claude OAuth profile',
      files: [
        {
          sourcePath: 'auth-center',
          targetPath: '/home/user/.claude/.credentials.json',
          content: JSON.stringify(
            {
              claudeAiOauth: {
                accessToken: 'stale-access',
                refreshToken: 'refresh-token',
                expiresAt: 1,
                scopes: ['user:profile'],
              },
            },
            null,
            2,
          ),
        },
      ],
      envs: {},
      warnings: [],
      metadata: {},
    },
  });

  let refreshRequest = null;
  const bundle = await resolveE2BAuthBundle(
    {
      claude: { mode: 'profile', profileId },
      codex: { mode: 'disabled' },
      cursor: { mode: 'disabled' },
      gemini: { mode: 'disabled' },
    },
    {
      strict: true,
      userId: user.id,
      now: 2_000,
      fetchImpl: async (url, options = {}) => {
        refreshRequest = { url, options };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
            scope: CLAUDE_CODE_OAUTH_SCOPES.join(' '),
            account: {
              email_address: 'fresh@example.com',
            },
          }),
        };
      },
    },
  );

  assert.ok(refreshRequest);
  assert.equal(refreshRequest.url, 'https://platform.claude.com/v1/oauth/token');

  const refreshBody = JSON.parse(refreshRequest.options.body);
  assert.equal(refreshBody.grant_type, 'refresh_token');
  assert.equal(refreshBody.refresh_token, 'refresh-token');
  assert.equal(refreshBody.scope, 'user:profile');

  const credentialsFile = bundle.files.find((file) => file.targetPath === '/home/user/.claude/.credentials.json');
  assert.ok(credentialsFile);

  const syncedCredentials = JSON.parse(credentialsFile.content);
  assert.equal(syncedCredentials.claudeAiOauth.accessToken, 'fresh-access');
  assert.equal(syncedCredentials.claudeAiOauth.refreshToken, 'fresh-refresh');
  assert.deepEqual(syncedCredentials.claudeAiOauth.scopes, CLAUDE_CODE_OAUTH_SCOPES);
  assert.equal(syncedCredentials.claudeAiOauth.expiresAt, 3_602_000);

  const storedProfile = authProfilesDb.getById(user.id, profileId);
  assert.equal(storedProfile.email, 'fresh@example.com');

  const storedPayload = JSON.parse(storedProfile.payload_json);
  const storedCredentials = JSON.parse(
    storedPayload.files.find((file) => file.targetPath === '/home/user/.claude/.credentials.json').content,
  );
  assert.equal(storedCredentials.claudeAiOauth.accessToken, 'fresh-access');
  assert.equal(storedCredentials.claudeAiOauth.refreshToken, 'fresh-refresh');
  assert.deepEqual(storedCredentials.claudeAiOauth.scopes, CLAUDE_CODE_OAUTH_SCOPES);
  assert.match(storedPayload.metadata.claudeOauthRefreshedAt, /^1970-01-01T00:00:02\.000Z$/);
});

test('resolveE2BAuthBundle can defer Claude OAuth refresh to the sandbox', async () => {
  const user = userDb.createUser(`claude-sandbox-refresh-${Date.now()}`, 'hash');
  const profileId = authProfilesDb.create(user.id, {
    provider: 'claude',
    profileName: 'Expired Claude OAuth For Sandbox',
    source: 'callback',
    email: 'stale@example.com',
    payload: {
      version: 1,
      provider: 'claude',
      summary: 'Stored expired Claude OAuth profile',
      files: [
        {
          sourcePath: 'auth-center',
          targetPath: '/home/user/.claude/.credentials.json',
          content: JSON.stringify(
            {
              claudeAiOauth: {
                accessToken: 'stale-access',
                refreshToken: 'refresh-token',
                expiresAt: 1,
                scopes: ['user:profile'],
              },
            },
            null,
            2,
          ),
        },
      ],
      envs: {},
      warnings: [],
      metadata: {},
    },
  });

  const bundle = await resolveE2BAuthBundle(
    {
      claude: { mode: 'profile', profileId },
      codex: { mode: 'disabled' },
      cursor: { mode: 'disabled' },
      gemini: { mode: 'disabled' },
    },
    {
      strict: true,
      userId: user.id,
      refreshClaudeProfiles: false,
      fetchImpl: async () => {
        throw new Error('host refresh should not run when sandbox refresh is enabled');
      },
    },
  );

  const credentialsFile = bundle.files.find((file) => file.targetPath === '/home/user/.claude/.credentials.json');
  assert.ok(credentialsFile);
  const syncedCredentials = JSON.parse(credentialsFile.content);
  assert.equal(syncedCredentials.claudeAiOauth.accessToken, 'stale-access');
  assert.equal(syncedCredentials.claudeAiOauth.refreshToken, 'refresh-token');

  const storedProfile = authProfilesDb.getById(user.id, profileId);
  const storedCredentials = JSON.parse(JSON.parse(storedProfile.payload_json).files[0].content);
  assert.equal(storedCredentials.claudeAiOauth.accessToken, 'stale-access');
});

test('resolveE2BAuthBundle mirrors host Claude preferences into OAuth profiles without host auth envs', async () => {
  const user = userDb.createUser(`claude-profile-settings-${Date.now()}`, 'hash');
  const tempClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-settings-'));
  const tempSettingsPath = path.join(tempClaudeDir, 'settings.json');
  const originalClaudePaths = { ...CLI_AUTH_PATHS.claude };

  fs.writeFileSync(
    tempSettingsPath,
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://proxy.example.com',
          ANTHROPIC_API_KEY: 'sk-ant-test',
          ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-20250514',
          API_TIMEOUT_MS: '600000',
        },
        language: 'zh-CN',
        model: 'sonnet',
      },
      null,
      2,
    ),
    'utf8',
  );

  Object.assign(CLI_AUTH_PATHS.claude, {
    ...CLI_AUTH_PATHS.claude,
    directory: tempClaudeDir,
    settings: tempSettingsPath,
  });

  try {
    const profileId = authProfilesDb.create(user.id, {
      provider: 'claude',
      profileName: 'Claude OAuth Profile',
      source: 'callback',
      email: 'oauth@example.com',
      payload: {
        version: 1,
        provider: 'claude',
        summary: 'Stored Claude OAuth profile',
        files: [
          {
            sourcePath: 'auth-center',
            targetPath: '/home/user/.claude/.credentials.json',
            content: JSON.stringify(
              {
                claudeAiOauth: {
                  accessToken: 'oauth-access',
                  refreshToken: 'oauth-refresh',
                  expiresAt: Date.now() + 60_000,
                  scopes: CLAUDE_CODE_OAUTH_SCOPES,
                },
              },
              null,
              2,
            ),
          },
        ],
        envs: {},
        warnings: [],
        metadata: {},
      },
    });

    const bundle = await resolveE2BAuthBundle(
      {
        claude: { mode: 'profile', profileId },
        codex: { mode: 'disabled' },
        cursor: { mode: 'disabled' },
        gemini: { mode: 'disabled' },
      },
      {
        strict: true,
        userId: user.id,
        refreshClaudeProfiles: false,
      },
    );

    const settingsFile = bundle.files.find((file) => file.targetPath === '/home/user/.claude/settings.json');
    assert.ok(settingsFile);

    const parsedSettings = JSON.parse(settingsFile.content);
    assert.equal(parsedSettings.language, 'zh-CN');
    assert.equal(parsedSettings.model, 'sonnet');
    assert.equal(parsedSettings.env.ANTHROPIC_MODEL, 'claude-sonnet-4-20250514');
    assert.equal(parsedSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-20250514');
    assert.equal(parsedSettings.env.API_TIMEOUT_MS, '600000');
    assert.equal('ANTHROPIC_BASE_URL' in parsedSettings.env, false);
    assert.equal('ANTHROPIC_API_KEY' in parsedSettings.env, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in parsedSettings.env, false);

    assert.equal(bundle.envs.ANTHROPIC_MODEL, 'claude-sonnet-4-20250514');
    assert.equal(bundle.envs.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-20250514');
    assert.equal(bundle.envs.API_TIMEOUT_MS, '600000');
    assert.equal(bundle.envs.ANTHROPIC_BASE_URL, undefined);
    assert.equal(bundle.envs.ANTHROPIC_API_KEY, null);
    assert.equal(bundle.envs.ANTHROPIC_AUTH_TOKEN, null);

    assert.ok(
      bundle.providers.claude.warnings.includes(
        'Claude profile did not include settings.json; using the current host Claude settings as a sandbox preferences template without host auth envs.',
      ),
    );
  } finally {
    Object.assign(CLI_AUTH_PATHS.claude, originalClaudePaths);
    fs.rmSync(tempClaudeDir, { recursive: true, force: true });
  }
});

test('syncClaudeProfileFromSandbox writes back newer sandbox Claude OAuth credentials', async () => {
  const user = userDb.createUser(`claude-sandbox-writeback-${Date.now()}`, 'hash');
  const profileId = authProfilesDb.create(user.id, {
    provider: 'claude',
    profileName: 'Claude OAuth To Update',
    source: 'callback',
    email: 'user@example.com',
    payload: {
      version: 1,
      provider: 'claude',
      summary: 'Stored Claude OAuth profile',
      files: [
        {
          sourcePath: 'auth-center',
          targetPath: '/home/user/.claude/.credentials.json',
          content: JSON.stringify(
            {
              claudeAiOauth: {
                accessToken: 'old-access',
                refreshToken: 'old-refresh',
                expiresAt: 1000,
                scopes: ['user:profile'],
              },
            },
            null,
            2,
          ),
        },
      ],
      envs: {
        ANTHROPIC_AUTH_TOKEN: 'old-access',
      },
      warnings: [],
      metadata: {},
    },
  });

  const result = await syncClaudeProfileFromSandbox(
    {
      readFsFile: async ({ path }) => {
        assert.equal(path, '/home/user/.claude/.credentials.json');
        return Buffer.from(
          JSON.stringify(
            {
              claudeAiOauth: {
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                expiresAt: 5000,
                scopes: CLAUDE_CODE_OAUTH_SCOPES,
              },
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    },
    {
      userId: user.id,
      profileId,
      sandboxId: 'e2b/test-writeback',
      now: 1234,
    },
  );

  assert.equal(result.synced, true);
  assert.equal(result.expiresAt, 5000);

  const storedProfile = authProfilesDb.getById(user.id, profileId);
  const storedPayload = JSON.parse(storedProfile.payload_json);
  const storedCredentials = JSON.parse(
    storedPayload.files.find((file) => file.targetPath === '/home/user/.claude/.credentials.json').content,
  );
  assert.equal(storedCredentials.claudeAiOauth.accessToken, 'new-access');
  assert.equal(storedCredentials.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(storedCredentials.claudeAiOauth.expiresAt, 5000);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in storedPayload.envs, false);
  assert.equal(storedPayload.metadata.lastClaudeOauthSandboxId, 'e2b/test-writeback');
  assert.match(storedPayload.metadata.claudeOauthPulledFromSandboxAt, /^1970-01-01T00:00:01\.234Z$/);
});

test('rewriteStoredAuthBundleForSandbox removes direct Claude auth token env when credentials file is present', () => {
  const payload = {
    provider: 'claude',
    files: [
      {
        sourcePath: 'profile',
        targetPath: '/home/user/.claude/.credentials.json',
        content: JSON.stringify({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1775167584049,
        }),
      },
    ],
    envs: {
      ANTHROPIC_AUTH_TOKEN: 'access-token',
    },
    warnings: [],
  };

  const rewritten = rewriteStoredAuthBundleForSandbox('claude', payload);
  const credentialsFile = rewritten.files.find((file) => file.targetPath.endsWith('/.credentials.json'));

  assert.ok(credentialsFile);
  assert.equal(rewritten.envs.ANTHROPIC_AUTH_TOKEN, null);
  assert.deepEqual(JSON.parse(credentialsFile.content), {
    claudeAiOauth: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1775167584049,
      scopes: CLAUDE_CODE_OAUTH_SCOPES,
      subscriptionType: null,
      rateLimitTier: null,
    },
  });
});

test('buildNativeClaudeLaunchScript enables stream-json Claude CLI mode', () => {
  const script = buildNativeClaudeLaunchScript({ model: 'haiku' });

  assert.match(script, /stty -echo/);
  assert.match(script, /--input-format' 'stream-json'/);
  assert.match(script, /--output-format' 'stream-json'/);
  assert.match(script, /--replay-user-messages/);
  assert.match(script, /--permission-prompt-tool' 'stdio'/);
  assert.match(script, /--model' 'haiku'/);
});

test('buildNativeClaudeUserMessage includes the native session id and prompt text', () => {
  assert.deepEqual(
    buildNativeClaudeUserMessage('Reply with 4', 'native-session-id'),
    {
      type: 'user',
      session_id: 'native-session-id',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply with 4' }],
      },
      parent_tool_use_id: null,
    },
  );
});

test('normalizeNativeClaudePermissionRequest maps can_use_tool control frames to UI permissions', () => {
  const normalized = normalizeNativeClaudePermissionRequest({
    request_id: 'perm_123',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'pwd' },
      tool_use_id: 'tool_456',
      description: 'Run pwd',
      blocked_path: '/tmp',
      permission_suggestions: [{ permissionRule: 'bash:pwd' }],
    },
  });

  assert.equal(normalized.requestId, 'perm_123');
  assert.equal(normalized.toolName, 'Bash');
  assert.deepEqual(normalized.input, { command: 'pwd' });
  assert.equal(normalized.context.toolCallId, 'tool_456');
  assert.equal(normalized.context.blockedPath, '/tmp');
  assert.deepEqual(normalized.context.availableReplies, ['once', 'always', 'reject']);
});

test('buildNativeClaudePermissionResponse returns updatedInput for allow replies', () => {
  const payload = buildNativeClaudePermissionResponse('perm_123', 'always', {
    tool_use_id: 'tool_456',
    input: { command: 'pwd' },
    permission_suggestions: [{ permissionRule: 'bash:pwd' }],
  });

  assert.deepEqual(payload, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'perm_123',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'pwd' },
      },
    },
  });
});

test('buildNativeClaudePermissionResponse returns deny messages for rejects', () => {
  const payload = buildNativeClaudePermissionResponse('perm_123', 'reject', {
    tool_use_id: 'tool_456',
    input: { command: 'pwd' },
  });

  assert.deepEqual(payload, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'perm_123',
      response: {
        behavior: 'deny',
        message: 'User denied tool use',
      },
    },
  });
});

test('parseNativeClaudeProtocolLine ignores ANSI-wrapped non-protocol noise and parses JSON frames', () => {
  const parsed = parseNativeClaudeProtocolLine('\u001b[32m{"type":"system","subtype":"init","session_id":"claude-native"}\u001b[0m');

  assert.deepEqual(parsed, {
    type: 'system',
    subtype: 'init',
    session_id: 'claude-native',
  });
  assert.equal(parseNativeClaudeProtocolLine('npm notice'), null);
});

test('rewriteCodexConfigForSandbox rewrites loopback provider URLs for sandboxes', () => {
  process.env.CLIPROXY_API_KEY = 'clip-key';

  const rewritten = rewriteCodexConfigForSandbox(
    [
      '[model_providers.cliproxyapi]',
      'base_url = "http://127.0.0.1:8317/v1"',
      'env_key = "CLIPROXY_API_KEY"',
      '',
    ].join('\n'),
    {
      sandboxConnectHost: '36.137.180.12',
    },
  );

  assert.equal(rewritten.warnings.length, 0);
  assert.equal(rewritten.envs.CLIPROXY_API_KEY, 'clip-key');
  assert.match(rewritten.content, /36\.137\.180\.12:8317\/v1/);
  assert.doesNotMatch(rewritten.content, /127\.0\.0\.1:8317/);
});

test('rewriteStoredAuthBundleForSandbox rewrites stored Codex profile files at resolve time', () => {
  const payload = {
    provider: 'codex',
    files: [
      {
        sourcePath: 'profile',
        targetPath: '/home/user/.codex/auth.json',
        content: JSON.stringify(
          {
            auth_mode: 'chatgpt',
            tokens: {
              refresh_token: 'refresh-token',
            },
          },
          null,
          2,
        ),
      },
      {
        sourcePath: 'profile',
        targetPath: '/home/user/.codex/config.toml',
        content: [
          '[model_providers.cliproxyapi]',
          'base_url = "http://127.0.0.1:8317/v1"',
          'env_key = "CLIPROXY_API_KEY"',
          '',
        ].join('\n'),
      },
    ],
    envs: {
      OPENAI_API_KEY: 'sk-profile',
      CLIPROXY_API_KEY: 'clip-profile',
    },
    warnings: [],
  };

  const rewritten = rewriteStoredAuthBundleForSandbox('codex', payload, {
    sandboxConnectHost: '36.137.180.12',
  });

  assert.equal(rewritten.files.length, 2);
  assert.equal(rewritten.envs.OPENAI_API_KEY, 'sk-profile');
  assert.equal(rewritten.envs.CODEX_API_KEY, 'sk-profile');
  assert.equal(rewritten.envs.CLIPROXY_API_KEY, 'clip-profile');
  assert.match(rewritten.warnings.join(' '), /not mirrored/i);

  const authFile = rewritten.files.find((file) => file.targetPath.endsWith('/auth.json'));
  const configFile = rewritten.files.find((file) => file.targetPath.endsWith('/config.toml'));

  assert.ok(authFile);
  assert.ok(configFile);
  assert.equal(JSON.parse(authFile.content).auth_mode, 'api_key');
  assert.match(configFile.content, /36\.137\.180\.12:8317\/v1/);
});

test('rewriteStoredAuthBundleForSandbox can backfill missing Codex config from a supplied template', () => {
  process.env.CLIPROXY_API_KEY = 'clip-template-key';

  const payload = {
    provider: 'codex',
    files: [
      {
        sourcePath: 'profile',
        targetPath: '/home/user/.codex/auth.json',
        content: JSON.stringify(
          {
            auth_mode: 'chatgpt',
            tokens: {
              refresh_token: 'refresh-token',
            },
          },
          null,
          2,
        ),
      },
    ],
    envs: {},
    warnings: [],
  };

  const rewritten = rewriteStoredAuthBundleForSandbox('codex', payload, {
    sandboxConnectHost: '36.137.180.12',
    codexConfigTemplateContent: [
      'model = "gpt-5.4"',
      'model_provider = "customproxy"',
      '',
      '[model_providers.customproxy]',
      'base_url = "http://127.0.0.1:8317/v1"',
      'env_key = "CLIPROXY_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  });

  const configFile = rewritten.files.find((file) => file.targetPath.endsWith('/config.toml'));

  assert.ok(configFile);
  assert.match(configFile.content, /model_provider = "customproxy"/);
  assert.match(configFile.content, /36\.137\.180\.12:8317\/v1/);
  assert.equal(rewritten.envs.CLIPROXY_API_KEY, 'clip-template-key');
});

test('resolveSandboxConnectHostFromRequest prefers metadata, then custom headers, then origin', () => {
  const envKeys = [
    'E2B_SANDBOX_CONNECT_HOST',
    'E2B_PUBLIC_HOST',
    'PUBLIC_HOST',
    'EXTERNAL_HOST',
    'APP_URL',
    'PUBLIC_URL',
    'VITE_PUBLIC_URL',
    'GITHUB_REDIRECT_URI',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  try {
    for (const key of envKeys) {
      delete process.env[key];
    }

    assert.equal(
      resolveSandboxConnectHostFromRequest(
        {
          headers: {
            'x-sandbox-connect-host': '36.137.180.12:3111',
            origin: 'http://other-host.example:3111',
          },
        },
        {
          metadata_json: JSON.stringify({
            sandboxConnectHost: 'metadata.example',
          }),
        },
      ),
      'metadata.example',
    );

    assert.equal(
      resolveSandboxConnectHostFromRequest({
        headers: {
          'x-sandbox-connect-host': '36.137.180.12:3111',
          origin: 'http://other-host.example:3111',
        },
      }),
      '36.137.180.12',
    );

    assert.equal(
      resolveSandboxConnectHostFromRequest({
        headers: {
          origin: 'http://origin.example:3111',
        },
      }),
      'origin.example',
    );
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  }
});

test('resolveSandboxConnectHostFromRequest falls back to a public URL env when browser headers are loopback', () => {
  process.env.GITHUB_REDIRECT_URI = 'http://36.137.180.12:3111/api/github/oauth/callback';

  assert.equal(
    resolveSandboxConnectHostFromRequest({
      headers: {
        'x-sandbox-connect-host': '127.0.0.1:5179',
        origin: 'http://127.0.0.1:5179',
        referer: 'http://127.0.0.1:5179/',
        host: '127.0.0.1:3111',
      },
      hostname: '127.0.0.1',
    }),
    '36.137.180.12',
  );
});

test('summarizeE2BBridgeError exposes actionable Codex bridge hints', () => {
  const error = new Error('AcpRpcError: Internal agent error: Internal error');
  error.data = {
    message: 'stream disconnected before completion while requesting http://127.0.0.1:8317/v1/responses',
    agentStderr: 'refresh_token_reused',
  };

  const summary = summarizeE2BBridgeError(error, { agent: 'codex' });

  assert.match(summary, /reused refresh token/i);
  assert.match(summary, /loopback proxy url/i);
});

test('summarizeE2BBridgeError unwraps structured error payloads', () => {
  const error = new Error('[object Object]');
  error.data = {
    message: {
      error: {
        message: 'Country, region, or territory not supported',
      },
    },
  };

  const summary = summarizeE2BBridgeError(error, { agent: 'claude' });

  assert.equal(summary, 'Country, region, or territory not supported');
});

test('normalizeEvent reads nested payload.params.update session updates from sandbox-agent', () => {
  const messages = normalizeEvent(
    {
      id: 'evt_nested_chunk',
      createdAt: Date.now(),
      payload: {
        method: 'session/update',
        params: {
          sessionId: 'nested-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'HELLO_WORLD',
            },
          },
        },
      },
    },
    'nested-session',
    'codex',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, 'HELLO_WORLD');
  assert.equal(messages[0].provider, 'codex');
});

test('coalesceHistoryMessages ignores spurious complete frames inside one assistant response', () => {
  const sessionId = 'coalesce-session';
  const merged = coalesceHistoryMessages(
    [
      {
        id: 'complete_before_stream',
        sessionId,
        timestamp: '2026-03-31T11:10:17.953Z',
        provider: 'codex',
        kind: 'complete',
      },
      {
        id: 'chunk_1',
        sessionId,
        timestamp: '2026-03-31T11:10:22.288Z',
        provider: 'codex',
        kind: 'stream_delta',
        content: 'HEL',
      },
      {
        id: 'spurious_complete',
        sessionId,
        timestamp: '2026-03-31T11:10:22.453Z',
        provider: 'codex',
        kind: 'complete',
      },
      {
        id: 'chunk_2',
        sessionId,
        timestamp: '2026-03-31T11:10:23.058Z',
        provider: 'codex',
        kind: 'stream_delta',
        content: 'LO_WORLD',
      },
      {
        id: 'usage_status',
        sessionId,
        timestamp: '2026-03-31T11:10:23.061Z',
        provider: 'codex',
        kind: 'status',
        text: 'Tokens: {"used":8659}',
      },
    ],
    sessionId,
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].kind, 'text');
  assert.equal(merged[0].role, 'assistant');
  assert.equal(merged[0].content, 'HELLO_WORLD');
  assert.equal(merged[1].kind, 'status');
});

test('fetchHistory falls back to persisted local E2B messages when sandbox history is unavailable', async () => {
  const sessionId = 'e2b_local_history';

  e2bSessionMessagesDb.append(sessionId, {
    id: 'prompt_1',
    sessionId,
    timestamp: '2026-03-31T12:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: 'hello',
  });
  e2bSessionMessagesDb.append(sessionId, {
    id: 'chunk_1',
    sessionId,
    timestamp: '2026-03-31T12:00:01.000Z',
    provider: 'codex',
    kind: 'stream_delta',
    content: 'HELLO',
  });
  e2bSessionMessagesDb.append(sessionId, {
    id: 'chunk_2',
    sessionId,
    timestamp: '2026-03-31T12:00:02.000Z',
    provider: 'codex',
    kind: 'stream_delta',
    content: '_WORLD',
  });

  const history = await fetchHistory(sessionId, { limit: 20, offset: 0 });

  assert.equal(history.total, 2);
  assert.equal(history.hasMore, false);
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].kind, 'text');
  assert.equal(history.messages[0].role, 'user');
  assert.equal(history.messages[0].content, 'hello');
  assert.equal(history.messages[1].kind, 'text');
  assert.equal(history.messages[1].role, 'assistant');
  assert.equal(history.messages[1].content, 'HELLO_WORLD');
});

test('mergeE2BHistoryMessages keeps persisted prompts while taking newer live history', () => {
  const sessionId = 'e2b_live_merge';
  const merged = mergeE2BHistoryMessages(
    [
      {
        id: 'assistant_live',
        sessionId,
        timestamp: '2026-03-31T12:00:03.000Z',
        provider: 'codex',
        kind: 'text',
        role: 'assistant',
        content: 'latest assistant response',
      },
      {
        id: 'tool_live',
        sessionId,
        timestamp: '2026-03-31T12:00:04.000Z',
        provider: 'codex',
        kind: 'tool_result',
        toolId: 'tool-1',
        content: 'done',
        isError: false,
      },
    ],
    [
      {
        id: 'prompt_local',
        sessionId,
        timestamp: '2026-03-31T12:00:00.000Z',
        provider: 'codex',
        kind: 'text',
        role: 'user',
        content: 'latest user prompt',
      },
      {
        id: 'assistant_live_duplicate',
        sessionId,
        timestamp: '2026-03-31T12:00:03.000Z',
        provider: 'codex',
        kind: 'text',
        role: 'assistant',
        content: 'latest assistant response',
      },
    ],
  );

  assert.deepEqual(
    merged.map((message) => ({
      kind: message.kind,
      role: message.role || null,
      content: message.content || '',
      timestamp: message.timestamp,
    })),
    [
      {
        kind: 'text',
        role: 'user',
        content: 'latest user prompt',
        timestamp: '2026-03-31T12:00:00.000Z',
      },
      {
        kind: 'text',
        role: 'assistant',
        content: 'latest assistant response',
        timestamp: '2026-03-31T12:00:03.000Z',
      },
      {
        kind: 'tool_result',
        role: null,
        content: 'done',
        timestamp: '2026-03-31T12:00:04.000Z',
      },
    ],
  );
});

test('summarizeE2BBridgeError explains ACP headers timeouts', () => {
  const cause = Object.assign(new Error('Headers Timeout Error'), {
    code: 'UND_ERR_HEADERS_TIMEOUT',
  });
  const error = new TypeError('fetch failed');
  error.cause = cause;
  error.stack = [
    'TypeError: fetch failed',
    '    at async StreamableHttpAcpTransport.postMessage (acp-http-client/dist/index.js:246:24)',
  ].join('\n');

  const summary = summarizeE2BBridgeError(error, { agent: 'codex' });

  assert.match(summary, /timed out waiting for the sandbox/i);
});

test('summarizeE2BBridgeError explains sandbox-not-found ACP failures', () => {
  const error = Object.assign(new Error('Request failed with status 502'), {
    name: 'AcpHttpError',
    status: 502,
    problem: {
      message: 'The sandbox was not found',
    },
  });

  const summary = summarizeE2BBridgeError(error, { agent: 'codex' });

  assert.match(summary, /sandbox is gone/i);
});
