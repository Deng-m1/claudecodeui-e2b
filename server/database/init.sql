-- Initialize authentication database
PRAGMA foreign_keys = ON;

-- Users table (single user system)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- API Keys table for external API access
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

-- User credentials table for storing various tokens/credentials (GitHub, GitLab, etc.)
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

-- User notification preferences (backend-owned, provider-agnostic)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- User Claude permission settings (backend-owned runtime source of truth)
CREATE TABLE IF NOT EXISTS user_claude_settings (
    user_id INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- VAPID key pair for Web Push notifications
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Browser push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Session custom names (provider-agnostic display name overrides)
CREATE TABLE IF NOT EXISTS session_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    custom_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider);

-- App configuration table (auto-generated secrets, settings, etc.)
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- E2B cloud sandbox records (for pause/resume persistence)
CREATE TABLE IF NOT EXISTS e2b_sandboxes (
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
);

CREATE INDEX IF NOT EXISTS idx_e2b_sandboxes_user_id ON e2b_sandboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_e2b_sandboxes_status ON e2b_sandboxes(status);

-- E2B cloud session records (session threads within a cloud project)
CREATE TABLE IF NOT EXISTS e2b_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    sandbox_id TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    agent TEXT NOT NULL,
    model TEXT,
    summary TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_e2b_sessions_user_id ON e2b_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_e2b_sessions_sandbox_id ON e2b_sessions(sandbox_id);

-- E2B persisted normalized messages (backend-owned fallback when sandbox-agent
-- does not retain session/event history across reconnects)
CREATE TABLE IF NOT EXISTS e2b_session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT,
    message_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_e2b_session_messages_session_id
    ON e2b_session_messages(session_id, id);

-- Auth center profiles for reusable provider credential/config snapshots
CREATE TABLE IF NOT EXISTS auth_profiles (
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
);

CREATE INDEX IF NOT EXISTS idx_auth_profiles_user_id ON auth_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_profiles_provider ON auth_profiles(provider);
CREATE INDEX IF NOT EXISTS idx_auth_profiles_user_provider ON auth_profiles(user_id, provider);
