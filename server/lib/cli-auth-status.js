import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const CLI_AUTH_PATHS = {
  claude: {
    directory: path.join(os.homedir(), '.claude'),
    settings: path.join(os.homedir(), '.claude', 'settings.json'),
    credentials: path.join(os.homedir(), '.claude', '.credentials.json'),
  },
  codex: {
    directory: path.join(os.homedir(), '.codex'),
    auth: path.join(os.homedir(), '.codex', 'auth.json'),
    config: path.join(os.homedir(), '.codex', 'config.toml'),
  },
  gemini: {
    directory: path.join(os.homedir(), '.gemini'),
    oauth: path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    accounts: path.join(os.homedir(), '.gemini', 'google_accounts.json'),
  },
  cursor: {
    directory: path.join(os.homedir(), '.cursor'),
    config: path.join(os.homedir(), '.cursor', 'cli-config.json'),
  },
};

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(targetPath) {
  try {
    const content = await fs.readFile(targetPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function loadClaudeSettings() {
  return readJsonIfExists(CLI_AUTH_PATHS.claude.settings);
}

export async function loadClaudeSettingsEnv() {
  const settings = await loadClaudeSettings();
  if (settings?.env && typeof settings.env === 'object') {
    return settings.env;
  }
  return {};
}

export async function checkClaudeCredentials() {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) {
    return {
      authenticated: true,
      email: 'API Key Auth',
      method: 'api_key',
    };
  }

  const settingsEnv = await loadClaudeSettingsEnv();

  if (typeof settingsEnv.ANTHROPIC_API_KEY === 'string' && settingsEnv.ANTHROPIC_API_KEY.trim()) {
    return {
      authenticated: true,
      email: 'API Key Auth',
      method: 'api_key',
    };
  }

  if (typeof settingsEnv.ANTHROPIC_AUTH_TOKEN === 'string' && settingsEnv.ANTHROPIC_AUTH_TOKEN.trim()) {
    return {
      authenticated: true,
      email: 'Configured via settings.json',
      method: 'api_key',
    };
  }

  try {
    const creds = await readJsonIfExists(CLI_AUTH_PATHS.claude.credentials);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      const isExpired = oauth.expiresAt && Date.now() >= oauth.expiresAt;
      if (!isExpired) {
        return {
          authenticated: true,
          email: creds.email || creds.user || null,
          method: 'credentials_file',
        };
      }
    }

    return {
      authenticated: false,
      email: null,
      method: null,
    };
  } catch {
    return {
      authenticated: false,
      email: null,
      method: null,
    };
  }
}

export function checkCursorStatus() {
  return new Promise((resolve) => {
    let processCompleted = false;

    const timeout = setTimeout(() => {
      if (!processCompleted) {
        processCompleted = true;
        if (childProcess) {
          childProcess.kill();
        }
        resolve({
          authenticated: false,
          email: null,
          error: 'Command timeout',
        });
      }
    }, 5000);

    let childProcess;
    try {
      childProcess = spawn('cursor-agent', ['status']);
    } catch {
      clearTimeout(timeout);
      processCompleted = true;
      resolve({
        authenticated: false,
        email: null,
        error: 'Cursor CLI not found or not installed',
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    childProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    childProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      if (processCompleted) return;
      processCompleted = true;
      clearTimeout(timeout);

      if (code === 0) {
        const emailMatch = stdout.match(/Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);

        if (emailMatch) {
          resolve({
            authenticated: true,
            email: emailMatch[1],
            output: stdout,
          });
          return;
        }

        if (stdout.includes('Logged in')) {
          resolve({
            authenticated: true,
            email: 'Logged in',
            output: stdout,
          });
          return;
        }
      }

      resolve({
        authenticated: false,
        email: null,
        error: stderr || 'Not logged in',
      });
    });

    childProcess.on('error', () => {
      if (processCompleted) return;
      processCompleted = true;
      clearTimeout(timeout);

      resolve({
        authenticated: false,
        email: null,
        error: 'Cursor CLI not found or not installed',
      });
    });
  });
}

export async function checkCodexCredentials() {
  try {
    const auth = await readJsonIfExists(CLI_AUTH_PATHS.codex.auth);
    if (!auth) {
      return {
        authenticated: false,
        email: null,
        error: 'Codex not configured',
      };
    }

    const tokens = auth.tokens || {};

    if (tokens.id_token || tokens.access_token) {
      let email = 'Authenticated';
      if (tokens.id_token) {
        try {
          const parts = tokens.id_token.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            email = payload.email || payload.user || 'Authenticated';
          }
        } catch {
          email = 'Authenticated';
        }
      }

      return {
        authenticated: true,
        email,
      };
    }

    if (auth.OPENAI_API_KEY) {
      return {
        authenticated: true,
        email: 'API Key Auth',
      };
    }

    return {
      authenticated: false,
      email: null,
      error: 'No valid tokens found',
    };
  } catch (error) {
    return {
      authenticated: false,
      email: null,
      error: error?.message || 'Codex not configured',
    };
  }
}

export async function checkGeminiCredentials() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return {
      authenticated: true,
      email: 'API Key Auth',
    };
  }

  try {
    const creds = await readJsonIfExists(CLI_AUTH_PATHS.gemini.oauth);
    if (!creds?.access_token) {
      return {
        authenticated: false,
        email: null,
        error: 'Gemini CLI not configured',
      };
    }

    let email = 'OAuth Session';

    try {
      const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${creds.access_token}`);
      if (tokenRes.ok) {
        const tokenInfo = await tokenRes.json();
        if (tokenInfo.email) {
          email = tokenInfo.email;
        }
      } else if (!creds.refresh_token) {
        return {
          authenticated: false,
          email: null,
          error: 'Access token invalid and no refresh token found',
        };
      } else {
        const accounts = await readJsonIfExists(CLI_AUTH_PATHS.gemini.accounts);
        if (accounts?.active) {
          email = accounts.active;
        }
      }
    } catch {
      const accounts = await readJsonIfExists(CLI_AUTH_PATHS.gemini.accounts);
      if (accounts?.active) {
        email = accounts.active;
      }
    }

    return {
      authenticated: true,
      email,
    };
  } catch {
    return {
      authenticated: false,
      email: null,
      error: 'Gemini CLI not configured',
    };
  }
}
