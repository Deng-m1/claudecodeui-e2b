import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_claude_settings (
        user_id INTEGER PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Create app_config table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');

    db.exec(`CREATE TABLE IF NOT EXISTS e2b_sandboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sandbox_id TEXT NOT NULL,
      repo_url TEXT,
      branch TEXT,
      workspace_path TEXT,
      status TEXT DEFAULT 'running',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_e2b_sandboxes_user_id ON e2b_sandboxes(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_e2b_sandboxes_status ON e2b_sandboxes(status)');

    db.exec(`CREATE TABLE IF NOT EXISTS e2b_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sandbox_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      agent TEXT NOT NULL,
      model TEXT,
      summary TEXT,
      status TEXT DEFAULT \'active\',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_e2b_sessions_user_id ON e2b_sessions(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_e2b_sessions_sandbox_id ON e2b_sessions(sandbox_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS e2b_session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT,
      message_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, message_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_e2b_session_messages_session_id ON e2b_session_messages(session_id, id)');

    db.exec(`CREATE TABLE IF NOT EXISTS auth_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      profile_type TEXT NOT NULL DEFAULT 'bundle',
      source TEXT,
      email TEXT,
      summary TEXT,
      payload_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_auth_profiles_user_id ON auth_profiles(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_auth_profiles_provider ON auth_profiles(provider)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_auth_profiles_user_provider ON auth_profiles(user_id, provider)');

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

const SQLITE_UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeSqliteUtcTimestamp(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!SQLITE_UTC_DATETIME_RE.test(trimmed)) {
    return value;
  }

  return `${trimmed.replace(' ', 'T')}Z`;
}

function normalizeE2BRowTimestamps(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }

  return {
    ...row,
    created_at: normalizeSqliteUtcTimestamp(row.created_at),
    updated_at: normalizeSqliteUtcTimestamp(row.updated_at),
    last_activity: normalizeSqliteUtcTimestamp(row.last_activity),
  };
}

function normalizeE2BMessageRow(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }

  return {
    ...row,
    created_at: normalizeSqliteUtcTimestamp(row.created_at),
  };
}

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash) => {
    try {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      const result = stmt.run(username, passwordHash);
      return { id: result.lastInsertRowid, username };
    } catch (err) {
      throw err;
    }
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  }
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true
  }
};

const DEFAULT_CLAUDE_PERMISSION_SETTINGS = {
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
};

const normalizeClaudePermissionSettings = (value) => {
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
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false
    }
  };
};

const notificationPreferencesDb = {
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const userClaudeSettingsDb = {
  getSettings: (userId) => {
    try {
      const row = db.prepare('SELECT settings_json FROM user_claude_settings WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeClaudePermissionSettings(DEFAULT_CLAUDE_PERMISSION_SETTINGS);
        db.prepare(
          'INSERT INTO user_claude_settings (user_id, settings_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.settings_json);
      } catch {
        parsed = DEFAULT_CLAUDE_PERMISSION_SETTINGS;
      }

      return normalizeClaudePermissionSettings(parsed);
    } catch (err) {
      throw err;
    }
  },

  updateSettings: (userId, settings) => {
    try {
      const normalized = normalizeClaudePermissionSettings(settings);
      db.prepare(
        `INSERT INTO user_claude_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
  },
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// App config database operations
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

const authProfilesDb = {
  create: (
    userId,
    {
      provider,
      profileName,
      profileType = 'bundle',
      source = null,
      email = null,
      summary = null,
      payload,
      metadata = null,
    } = {},
  ) => {
    const result = db.prepare(`
      INSERT INTO auth_profiles (
        user_id,
        provider,
        profile_name,
        profile_type,
        source,
        email,
        summary,
        payload_json,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      provider,
      profileName,
      profileType,
      source,
      email,
      summary,
      JSON.stringify(payload || {}),
      metadata ? JSON.stringify(metadata) : null,
    );

    return Number(result.lastInsertRowid);
  },

  getByUser: (userId, provider = null) => {
    if (provider) {
      return db.prepare(`
        SELECT *
        FROM auth_profiles
        WHERE user_id = ? AND provider = ?
        ORDER BY updated_at DESC, created_at DESC
      `).all(userId, provider);
    }

    return db.prepare(`
      SELECT *
      FROM auth_profiles
      WHERE user_id = ?
      ORDER BY provider ASC, updated_at DESC, created_at DESC
    `).all(userId);
  },

  getById: (userId, id) => {
    return db.prepare(`
      SELECT *
      FROM auth_profiles
      WHERE user_id = ? AND id = ?
    `).get(userId, id);
  },

  updateName: (userId, id, profileName) => {
    const result = db.prepare(`
      UPDATE auth_profiles
      SET profile_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `).run(profileName, userId, id);

    return result.changes > 0;
  },

  updatePayload: (userId, id, { payload, email, summary, metadata } = {}) => {
    const assignments = ['payload_json = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [JSON.stringify(payload || {})];

    if (email !== undefined) {
      assignments.push('email = ?');
      params.push(email);
    }

    if (summary !== undefined) {
      assignments.push('summary = ?');
      params.push(summary);
    }

    if (metadata !== undefined) {
      assignments.push('metadata_json = ?');
      params.push(metadata ? JSON.stringify(metadata) : null);
    }

    params.push(userId, id);

    const result = db.prepare(`
      UPDATE auth_profiles
      SET ${assignments.join(', ')}
      WHERE user_id = ? AND id = ?
    `).run(...params);

    return result.changes > 0;
  },

  delete: (userId, id) => {
    const result = db.prepare(`
      DELETE FROM auth_profiles
      WHERE user_id = ? AND id = ?
    `).run(userId, id);

    return result.changes > 0;
  },
};

// E2B sandbox persistence operations
const e2bSandboxDb = {
  create: (userId, sandboxId, { repoUrl = null, branch = null, workspacePath = null, metadata = null } = {}) => {
    const stmt = db.prepare(
      'INSERT INTO e2b_sandboxes (user_id, sandbox_id, repo_url, branch, workspace_path, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(userId, sandboxId, repoUrl, branch, workspacePath, 'running', metadata ? JSON.stringify(metadata) : null);
    return result.lastInsertRowid;
  },

  updateStatus: (sandboxId, status) => {
    db.prepare('UPDATE e2b_sandboxes SET status = ?, last_activity = CURRENT_TIMESTAMP WHERE sandbox_id = ?').run(status, sandboxId);
  },

  updateMetadata: (sandboxId, metadata = null) => {
    db.prepare(`
      UPDATE e2b_sandboxes
      SET metadata_json = ?, last_activity = CURRENT_TIMESTAMP
      WHERE sandbox_id = ?
    `).run(metadata ? JSON.stringify(metadata) : null, sandboxId);
  },

  getByUser: (userId) => {
    return db
      .prepare('SELECT * FROM e2b_sandboxes WHERE user_id = ? ORDER BY last_activity DESC')
      .all(userId)
      .map(normalizeE2BRowTimestamps);
  },

  getActive: (userId) => {
    return db
      .prepare("SELECT * FROM e2b_sandboxes WHERE user_id = ? AND status IN ('running', 'paused') ORDER BY last_activity DESC")
      .all(userId)
      .map(normalizeE2BRowTimestamps);
  },

  getBySandboxId: (sandboxId) => {
    return normalizeE2BRowTimestamps(
      db.prepare('SELECT * FROM e2b_sandboxes WHERE sandbox_id = ?').get(sandboxId),
    );
  },

  delete: (id) => {
    db.prepare('DELETE FROM e2b_sandboxes WHERE id = ?').run(id);
  },

  deleteBySandboxId: (sandboxId) => {
    db.prepare('DELETE FROM e2b_sandboxes WHERE sandbox_id = ?').run(sandboxId);
  },
};

const E2B_SESSION_SELECT_WITH_MESSAGE_COUNTS = `
      SELECT
        e2b_sessions.*,
        COALESCE(message_counts.message_count, 0) AS message_count
      FROM e2b_sessions
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS message_count
        FROM e2b_session_messages
        GROUP BY session_id
      ) AS message_counts
        ON message_counts.session_id = e2b_sessions.session_id
    `;

const e2bSessionDb = {
  upsert: (
    userId,
    sessionId,
    {
      sandboxId,
      agent,
      model = null,
      summary = null,
      status = 'active',
      metadata = null,
    } = {},
  ) => {
    db.prepare(`
      INSERT INTO e2b_sessions (
        user_id,
        sandbox_id,
        session_id,
        agent,
        model,
        summary,
        status,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        user_id = excluded.user_id,
        sandbox_id = COALESCE(excluded.sandbox_id, e2b_sessions.sandbox_id),
        agent = COALESCE(excluded.agent, e2b_sessions.agent),
        model = COALESCE(excluded.model, e2b_sessions.model),
        summary = COALESCE(excluded.summary, e2b_sessions.summary),
        status = COALESCE(excluded.status, e2b_sessions.status),
        metadata_json = COALESCE(excluded.metadata_json, e2b_sessions.metadata_json),
        last_activity = CURRENT_TIMESTAMP
    `).run(
      userId,
      sandboxId,
      sessionId,
      agent,
      model,
      summary,
      status,
      metadata ? JSON.stringify(metadata) : null,
    );
  },

  touch: (
    sessionId,
    { summary = null, model = null, status = null, metadata = null } = {},
  ) => {
    db.prepare(`
      UPDATE e2b_sessions
      SET
        summary = COALESCE(?, summary),
        model = COALESCE(?, model),
        status = COALESCE(?, status),
        metadata_json = COALESCE(?, metadata_json),
        last_activity = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(
      summary,
      model,
      status,
      metadata ? JSON.stringify(metadata) : null,
      sessionId,
    );
  },

  getByUser: (userId) => {
    return db.prepare(`
      ${E2B_SESSION_SELECT_WITH_MESSAGE_COUNTS}
      WHERE e2b_sessions.user_id = ?
      ORDER BY e2b_sessions.last_activity DESC
    `).all(userId).map(normalizeE2BRowTimestamps);
  },

  getBySandbox: (sandboxId) => {
    return db.prepare(`
      ${E2B_SESSION_SELECT_WITH_MESSAGE_COUNTS}
      WHERE e2b_sessions.sandbox_id = ?
      ORDER BY e2b_sessions.last_activity DESC
    `).all(sandboxId).map(normalizeE2BRowTimestamps);
  },

  getBySessionId: (sessionId) => {
    return normalizeE2BRowTimestamps(
      db.prepare(`
        ${E2B_SESSION_SELECT_WITH_MESSAGE_COUNTS}
        WHERE e2b_sessions.session_id = ?
      `).get(sessionId),
    );
  },

  updateStatus: (sessionId, status) => {
    db.prepare(`
      UPDATE e2b_sessions
      SET status = ?, last_activity = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(status, sessionId);
  },

  delete: (sessionId) => {
    db.prepare('DELETE FROM e2b_sessions WHERE session_id = ?').run(sessionId);
  },

  deleteBySandboxId: (sandboxId) => {
    db.prepare('DELETE FROM e2b_sessions WHERE sandbox_id = ?').run(sandboxId);
  },
};

const e2bSessionMessagesDb = {
  append: (sessionId, message) => {
    if (!sessionId || !message?.id || !message?.kind) {
      return;
    }

    db.prepare(`
      INSERT OR IGNORE INTO e2b_session_messages (
        session_id,
        message_id,
        kind,
        timestamp,
        message_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      String(message.id),
      String(message.kind),
      typeof message.timestamp === 'string' ? message.timestamp : null,
      JSON.stringify(message),
    );
  },

  getBySessionId: (sessionId) => {
    return db.prepare(`
      SELECT *
      FROM e2b_session_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId).map(normalizeE2BMessageRow);
  },

  deleteBySessionId: (sessionId) => {
    db.prepare('DELETE FROM e2b_session_messages WHERE session_id = ?').run(sessionId);
  },

  deleteBySandboxId: (sandboxId) => {
    db.prepare(`
      DELETE FROM e2b_session_messages
      WHERE session_id IN (
        SELECT session_id
        FROM e2b_sessions
        WHERE sandbox_id = ?
      )
    `).run(sandboxId);
  },
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  userClaudeSettingsDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  appConfigDb,
  githubTokensDb,
  authProfilesDb,
  e2bSandboxDb,
  e2bSessionDb,
  e2bSessionMessagesDb,
};
