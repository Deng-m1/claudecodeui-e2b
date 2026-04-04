/**
 * PROJECT DISCOVERY AND MANAGEMENT SYSTEM
 * ========================================
 * 
 * This module manages project discovery for both Claude CLI and Cursor CLI sessions.
 * 
 * ## Architecture Overview
 * 
 * 1. **Claude Projects** (stored in ~/.claude/projects/)
 *    - Each project is a directory named with the project path encoded (/ replaced with -)
 *    - Contains .jsonl files with conversation history including 'cwd' field
 *    - Project metadata stored in ~/.claude/project-config.json
 * 
 * 2. **Cursor Projects** (stored in ~/.cursor/chats/)
 *    - Each project directory is named with MD5 hash of the absolute project path
 *    - Example: /Users/john/myproject -> MD5 -> a1b2c3d4e5f6...
 *    - Contains session directories with SQLite databases (store.db)
 *    - Project path is NOT stored in the database - only in the MD5 hash
 * 
 * ## Project Discovery Strategy
 * 
 * 1. **Claude Projects Discovery**:
 *    - Scan ~/.claude/projects/ directory for Claude project folders
 *    - Extract actual project path from .jsonl files (cwd field)
 *    - Fall back to decoded directory name if no sessions exist
 * 
 * 2. **Cursor Sessions Discovery**:
 *    - For each KNOWN project (from Claude or manually added)
 *    - Compute MD5 hash of the project's absolute path
 *    - Check if ~/.cursor/chats/{md5_hash}/ directory exists
 *    - Read session metadata from SQLite store.db files
 * 
 * 3. **Manual Project Addition**:
 *    - Users can manually add project paths via UI
 *    - Stored in ~/.claude/project-config.json with 'manuallyAdded' flag
 *    - Allows discovering Cursor sessions for projects without Claude sessions
 * 
 * ## Critical Limitations
 * 
 * - **CANNOT discover Cursor-only projects**: From a quick check, there was no mention of
 *   the cwd of each project. if someone has the time, you can try to reverse engineer it.
 * 
 * - **Project relocation breaks history**: If a project directory is moved or renamed,
 *   the MD5 hash changes, making old Cursor sessions inaccessible unless the old
 *   path is known and manually added.
 * 
 * ## Error Handling
 * 
 * - Missing ~/.claude directory is handled gracefully with automatic creation
 * - ENOENT errors are caught and handled without crashing
 * - Empty arrays returned when no projects/sessions exist
 * 
 * ## Caching Strategy
 * 
 * - Project directory extraction is cached to minimize file I/O
 * - Cache is cleared when project configuration changes
 * - Session data is fetched on-demand, not cached
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';
import sessionManager from './sessionManager.js';
import { applyCustomSessionNames, e2bSandboxDb, e2bSessionDb, e2bSessionMessagesDb } from './database/db.js';
import {
  buildE2BProjectName,
  extractSandboxIdFromProjectName,
  getE2BProjectDisplayName,
  isE2BProjectName,
  resolveE2BAgentProvider,
} from './providers/e2b/project-utils.js';
import { getProjectCapabilities } from './services/project-runtime/capabilities.js';

// Import TaskMaster detection functions
async function detectTaskMasterFolder(projectPath) {
  try {
    const taskMasterPath = path.join(projectPath, '.taskmaster');

    // Check if .taskmaster directory exists
    try {
      const stats = await fs.stat(taskMasterPath);
      if (!stats.isDirectory()) {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster exists but is not a directory'
        };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster directory not found'
        };
      }
      throw error;
    }

    // Check for key TaskMaster files
    const keyFiles = [
      'tasks/tasks.json',
      'config.json'
    ];

    const fileStatus = {};
    let hasEssentialFiles = true;

    for (const file of keyFiles) {
      const filePath = path.join(taskMasterPath, file);
      try {
        await fs.access(filePath);
        fileStatus[file] = true;
      } catch (error) {
        fileStatus[file] = false;
        if (file === 'tasks/tasks.json') {
          hasEssentialFiles = false;
        }
      }
    }

    // Parse tasks.json if it exists for metadata
    let taskMetadata = null;
    if (fileStatus['tasks/tasks.json']) {
      try {
        const tasksPath = path.join(taskMasterPath, 'tasks/tasks.json');
        const tasksContent = await fs.readFile(tasksPath, 'utf8');
        const tasksData = JSON.parse(tasksContent);

        // Handle both tagged and legacy formats
        let tasks = [];
        if (tasksData.tasks) {
          // Legacy format
          tasks = tasksData.tasks;
        } else {
          // Tagged format - get tasks from all tags
          Object.values(tasksData).forEach(tagData => {
            if (tagData.tasks) {
              tasks = tasks.concat(tagData.tasks);
            }
          });
        }

        // Calculate task statistics
        const stats = tasks.reduce((acc, task) => {
          acc.total++;
          acc[task.status] = (acc[task.status] || 0) + 1;

          // Count subtasks
          if (task.subtasks) {
            task.subtasks.forEach(subtask => {
              acc.subtotalTasks++;
              acc.subtasks = acc.subtasks || {};
              acc.subtasks[subtask.status] = (acc.subtasks[subtask.status] || 0) + 1;
            });
          }

          return acc;
        }, {
          total: 0,
          subtotalTasks: 0,
          pending: 0,
          'in-progress': 0,
          done: 0,
          review: 0,
          deferred: 0,
          cancelled: 0,
          subtasks: {}
        });

        taskMetadata = {
          taskCount: stats.total,
          subtaskCount: stats.subtotalTasks,
          completed: stats.done || 0,
          pending: stats.pending || 0,
          inProgress: stats['in-progress'] || 0,
          review: stats.review || 0,
          completionPercentage: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
          lastModified: (await fs.stat(tasksPath)).mtime.toISOString()
        };
      } catch (parseError) {
        console.warn('Failed to parse tasks.json:', parseError.message);
        taskMetadata = { error: 'Failed to parse tasks.json' };
      }
    }

    return {
      hasTaskmaster: true,
      hasEssentialFiles,
      files: fileStatus,
      metadata: taskMetadata,
      path: taskMasterPath
    };

  } catch (error) {
    console.error('Error detecting TaskMaster folder:', error);
    return {
      hasTaskmaster: false,
      reason: `Error checking directory: ${error.message}`
    };
  }
}

// Cache for extracted project directories
const projectDirectoryCache = new Map();
const CODEX_INDEX_REFRESH_TTL_MS = 5000;
const SESSION_PAGE_SIZE = 5;
const SUPPORTED_SESSION_PROVIDERS = ['claude', 'cursor', 'codex', 'gemini'];
const REQUIRED_CURSOR_STORE_TABLES = ['meta', 'blobs'];
const cursorStoreSchemaCache = new Map();
const CODEX_STATE_DB_PATH = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const codexSessionsIndexCache = {
  files: new Map(),
  sessionsByProject: new Map(),
  sessionsById: new Map(),
  refreshPromise: null,
  lastRefreshAt: 0,
};

function getCursorStoreSchemaCacheEntry(storeDbPath, mtimeMs) {
  const cached = cursorStoreSchemaCache.get(storeDbPath);
  if (!cached) {
    return null;
  }

  if (cached.mtimeMs !== mtimeMs) {
    cursorStoreSchemaCache.delete(storeDbPath);
    return null;
  }

  return cached;
}

async function readCursorSessionStore(storeDbPath, options = {}, reader) {
  const { sessionId = null, suppressWarning = false } = options;
  const stat = await fs.stat(storeDbPath);
  const dbStatMtimeMs = stat.mtimeMs;
  const cached = getCursorStoreSchemaCacheEntry(storeDbPath, dbStatMtimeMs);

  if (cached?.valid === false) {
    return {
      ok: false,
      reason: cached.reason,
      dbStatMtimeMs,
    };
  }

  const db = await open({
    filename: storeDbPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });

  try {
    const tableRows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tableNames = new Set(tableRows.map((row) => String(row.name || '')));
    const missingTables = REQUIRED_CURSOR_STORE_TABLES.filter((tableName) => !tableNames.has(tableName));

    if (missingTables.length > 0) {
      const reason = `missing tables: ${missingTables.join(', ')}`;
      const shouldWarn = !cached?.warned && !suppressWarning;
      cursorStoreSchemaCache.set(storeDbPath, {
        valid: false,
        reason,
        mtimeMs: dbStatMtimeMs,
        warned: shouldWarn || cached?.warned === true,
      });
      if (shouldWarn && sessionId) {
        console.warn(`Skipping Cursor session ${sessionId}: ${reason}`);
      }
      return {
        ok: false,
        reason,
        dbStatMtimeMs,
      };
    }

    const value = await reader(db, { dbStatMtimeMs });
    cursorStoreSchemaCache.set(storeDbPath, {
      valid: true,
      mtimeMs: dbStatMtimeMs,
      warned: false,
    });
    return {
      ok: true,
      value,
      dbStatMtimeMs,
    };
  } catch (error) {
    const reason = error?.message || 'unknown_cursor_store_error';
    const isCacheable = /no such table/i.test(reason) || /SQLITE_(?:ERROR|CORRUPT|NOTADB)/i.test(reason);

    if (isCacheable) {
      const shouldWarn = !cached?.warned && !suppressWarning;
      cursorStoreSchemaCache.set(storeDbPath, {
        valid: false,
        reason,
        mtimeMs: dbStatMtimeMs,
        warned: shouldWarn || cached?.warned === true,
      });
      if (shouldWarn && sessionId) {
        console.warn(`Skipping Cursor session ${sessionId}: ${reason}`);
      }
      return {
        ok: false,
        reason,
        dbStatMtimeMs,
      };
    }

    throw error;
  } finally {
    await db.close();
  }
}

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
}

function encodeProjectPath(projectPath = '') {
  return String(projectPath || '').replace(/[\\/:\s~_]/g, '-');
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const configPath = path.join(claudeDir, 'project-config.json');

  // Ensure the .claude directory exists
  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);

    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }

  // If it starts with /, it's an absolute path
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }

  // Check project config for originalPath (manually added projects via UI or platform)
  // This handles projects with dashes in their directory names correctly
  const config = await loadProjectConfig();
  if (config[projectName]?.originalPath) {
    const originalPath = config[projectName].originalPath;
    projectDirectoryCache.set(projectName, originalPath);
    return originalPath;
  }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const cwdCounts = new Map();
  let latestTimestamp = 0;
  let latestCwd = null;
  let extractedPath;

  try {
    // Check if the project directory exists
    await fs.access(projectDir);

    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // Process all JSONL files to collect cwd values
      for (const file of jsonlFiles) {
        const jsonlFile = path.join(projectDir, file);
        const fileStream = fsSync.createReadStream(jsonlFile);
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });

        for await (const line of rl) {
          if (line.trim()) {
            try {
              const entry = JSON.parse(line);

              if (entry.cwd) {
                // Count occurrences of each cwd
                cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1);

                // Track the most recent cwd
                const timestamp = new Date(entry.timestamp || 0).getTime();
                if (timestamp > latestTimestamp) {
                  latestTimestamp = timestamp;
                  latestCwd = entry.cwd;
                }
              }
            } catch (parseError) {
              // Skip malformed lines
            }
          }
        }
      }

      // Determine the best cwd to use
      if (cwdCounts.size === 0) {
        // No cwd found, fall back to decoded project name
        extractedPath = projectName.replace(/-/g, '/');
      } else if (cwdCounts.size === 1) {
        // Only one cwd, use it
        extractedPath = Array.from(cwdCounts.keys())[0];
      } else {
        // Multiple cwd values - prefer the most recent one if it has reasonable usage
        const mostRecentCount = cwdCounts.get(latestCwd) || 0;
        const maxCount = Math.max(...cwdCounts.values());

        // Use most recent if it has at least 25% of the max count
        if (mostRecentCount >= maxCount * 0.25) {
          extractedPath = latestCwd;
        } else {
          // Otherwise use the most frequently used cwd
          for (const [cwd, count] of cwdCounts.entries()) {
            if (count === maxCount) {
              extractedPath = cwd;
              break;
            }
          }
        }

        // Fallback (shouldn't reach here)
        if (!extractedPath) {
          extractedPath = latestCwd || projectName.replace(/-/g, '/');
        }
      }
    }

    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;

  } catch (error) {
    // If the directory doesn't exist, just use the decoded project name
    if (error.code === 'ENOENT') {
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      console.error(`Error extracting project directory for ${projectName}:`, error);
      // Fall back to decoded project name for other errors
      extractedPath = projectName.replace(/-/g, '/');
    }

    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;
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

function normalizeE2BSessionRecord(record) {
  const metadata = parseJsonOrNull(record.metadata_json);
  const summary =
    record.summary ||
    metadata?.summary ||
    metadata?.title ||
    'New Session';

  return {
    id: record.session_id,
    summary,
    name: summary,
    title: summary,
    createdAt: record.created_at,
    created_at: record.created_at,
    updated_at: record.last_activity,
    lastActivity: record.last_activity,
    messageCount: Number(record.message_count ?? metadata?.messageCount ?? 0),
    provider: resolveE2BAgentProvider(record.agent),
    agent: record.agent,
    model: record.model,
    status: record.status,
    runtime: 'e2b',
  };
}

function extractProjectAuthSelections(value) {
  if (value && typeof value === 'object') {
    return value;
  }

  return null;
}

function sortSessionsByLastActivity(sessions = []) {
  return [...sessions].sort(
    (left, right) =>
      new Date(right.lastActivity || right.updated_at || right.createdAt || right.created_at || 0) -
      new Date(left.lastActivity || left.updated_at || left.createdAt || left.created_at || 0),
  );
}

function paginateSessions(sessions, limit = SESSION_PAGE_SIZE, offset = 0) {
  const normalizedOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const total = sessions.length;

  if (limit === 0) {
    return {
      sessions: [...sessions],
      hasMore: false,
      total,
      offset: normalizedOffset,
      limit: 0,
    };
  }

  const normalizedLimit = Math.max(1, Number.isFinite(limit) ? limit : SESSION_PAGE_SIZE);
  const paginatedSessions = sessions.slice(normalizedOffset, normalizedOffset + normalizedLimit);

  return {
    sessions: paginatedSessions,
    hasMore: normalizedOffset + normalizedLimit < total,
    total,
    offset: normalizedOffset,
    limit: normalizedLimit,
  };
}

function buildProjectSessionMetaFromProviders(providerResults = {}) {
  const byProvider = {};
  let total = 0;
  let hasMore = false;

  for (const provider of SUPPORTED_SESSION_PROVIDERS) {
    const result = providerResults[provider] || {};
    const providerTotal = Number(result.total || result.sessions?.length || 0);
    const providerHasMore = result.hasMore === true;

    byProvider[provider] = {
      total: providerTotal,
      hasMore: providerHasMore,
    };

    total += providerTotal;
    hasMore = hasMore || providerHasMore;
  }

  return {
    total,
    hasMore,
    byProvider,
  };
}

function buildE2BProviderSessionMeta(sessions, limit = SESSION_PAGE_SIZE) {
  const counts = Object.fromEntries(
    SUPPORTED_SESSION_PROVIDERS.map((provider) => [provider, 0]),
  );

  for (const session of sessions) {
    const provider = resolveE2BAgentProvider(session.agent || session.provider);
    counts[provider] = (counts[provider] || 0) + 1;
  }

  const meta = buildProjectSessionMetaFromProviders(
    Object.fromEntries(
      SUPPORTED_SESSION_PROVIDERS.map((provider) => [
        provider,
        {
          total: counts[provider] || 0,
          hasMore: limit > 0 ? (counts[provider] || 0) > limit : false,
        },
      ]),
    ),
  );

  return {
    ...meta,
    hasMore: limit > 0 ? sessions.length > limit : false,
    total: sessions.length,
  };
}

function buildE2BProject(sandboxRecord, config, options = {}) {
  const { limit = SESSION_PAGE_SIZE, offset = 0 } = options;
  const projectName = buildE2BProjectName(sandboxRecord.sandbox_id);
  const customName = config[projectName]?.displayName;
  const metadata = parseJsonOrNull(sandboxRecord.metadata_json);
  const allSessions = sortSessionsByLastActivity(e2bSessionDb
    .getBySandbox(sandboxRecord.sandbox_id)
    .map(normalizeE2BSessionRecord));
  const paginatedSessions = paginateSessions(allSessions, limit, offset);

  applyCustomSessionNames(allSessions, 'e2b');

  return {
    name: projectName,
    path: sandboxRecord.workspace_path || '/home/user',
    displayName: customName || getE2BProjectDisplayName(sandboxRecord.repo_url, sandboxRecord.sandbox_id),
    fullPath: sandboxRecord.workspace_path || '/home/user',
    isCustomName: Boolean(customName),
    kind: 'cloud',
    runtime: 'e2b',
    capabilities: getProjectCapabilities('e2b'),
    authSelections: extractProjectAuthSelections(metadata?.authSelections),
    sessions: [],
    cursorSessions: [],
    codexSessions: [],
    geminiSessions: [],
    e2bSessions: paginatedSessions.sessions,
    sessionMeta: buildE2BProviderSessionMeta(allSessions, limit),
    cloud: {
      sandboxId: sandboxRecord.sandbox_id,
      status: sandboxRecord.status,
      repoUrl: sandboxRecord.repo_url,
      branch: sandboxRecord.branch,
      workspacePath: sandboxRecord.workspace_path,
      createdAt: sandboxRecord.created_at,
      lastActivity: sandboxRecord.last_activity,
      metadata,
    },
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildProjectDescriptor(projectName, projectPath, config = {}) {
  const projectConfig = config[projectName] || {};
  return {
    name: projectName,
    path: projectPath,
    fullPath: projectPath,
    kind: 'local',
    runtime: 'local',
    capabilities: getProjectCapabilities('local'),
    displayName: projectConfig.displayName || await generateDisplayName(projectName, projectPath),
    authSelections: extractProjectAuthSelections(projectConfig.authSelections),
  };
}

async function resolveProjectDescriptorForPath(projectPath, config = {}) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  const directProjectName = encodeProjectPath(projectPath);
  const directProjectDir = path.join(os.homedir(), '.claude', 'projects', directProjectName);

  if (await pathExists(directProjectDir)) {
    return buildProjectDescriptor(directProjectName, projectPath, config);
  }

  if (config[directProjectName]) {
    return buildProjectDescriptor(directProjectName, projectPath, config);
  }

  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (normalizeComparablePath(projectConfig?.originalPath) === normalizedProjectPath) {
      return buildProjectDescriptor(projectName, projectPath, config);
    }
  }

  return buildProjectDescriptor(directProjectName, projectPath, config);
}

async function resolveProjectPathForBootstrap(projectName, config = {}, sessionCwd = '') {
  if (typeof sessionCwd === 'string' && sessionCwd.trim()) {
    return sessionCwd.trim();
  }

  const configuredPath = config[projectName]?.originalPath;
  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    return configuredPath.trim();
  }

  return extractProjectDirectory(projectName);
}

function mergeBootstrapSessionIntoList(sessions = [], selectedSession = null) {
  if (!selectedSession?.id) {
    return sessions;
  }

  const merged = [selectedSession, ...sessions.filter((session) => session.id !== selectedSession.id)];
  return sortSessionsByLastActivity(merged);
}

function looksLikeUuidSessionId(sessionId = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

async function buildBootstrapProject(project, session, {
  provider = 'claude',
  runtime = 'local',
  kind = 'local',
  cloud = null,
  includeAllProviderSessions = true,
  prefillSelectedSessionOnly = false,
} = {}) {
  const baseProject = {
    name: project.name,
    displayName: project.displayName,
    path: project.path,
    fullPath: project.fullPath,
    kind,
    runtime,
    capabilities: getProjectCapabilities(runtime),
    authSelections: project.authSelections || null,
    cloud,
    sessions: [],
    cursorSessions: [],
    codexSessions: [],
    geminiSessions: [],
    e2bSessions: [],
    sessionMeta: buildProjectSessionMetaFromProviders(),
  };

  if (runtime === 'e2b') {
    const sandboxId = extractSandboxIdFromProjectName(project.name);
    const allSessions = sandboxId
      ? sortSessionsByLastActivity(e2bSessionDb.getBySandbox(sandboxId).map(normalizeE2BSessionRecord))
      : [];

    applyCustomSessionNames(allSessions, 'e2b');

    return {
      ...baseProject,
      e2bSessions: mergeBootstrapSessionIntoList(
        paginateSessions(allSessions, SESSION_PAGE_SIZE, 0).sessions,
        session,
      ),
      sessionMeta: buildE2BProviderSessionMeta(allSessions, SESSION_PAGE_SIZE),
    };
  }

  if (prefillSelectedSessionOnly) {
    const providerResults = {
      claude: { sessions: [], hasMore: false, total: 0 },
      cursor: { sessions: [], hasMore: false, total: 0 },
      codex: { sessions: [], hasMore: false, total: 0 },
      gemini: { sessions: [], hasMore: false, total: 0 },
    };
    if (providerResults[provider]) {
      providerResults[provider] = {
        sessions: session ? [session] : [],
        hasMore: false,
        total: session ? 1 : 0,
      };
    }

    return {
      ...baseProject,
      sessions: provider === 'claude' && session ? [session] : [],
      cursorSessions: provider === 'cursor' && session ? [session] : [],
      codexSessions: provider === 'codex' && session ? [session] : [],
      geminiSessions: provider === 'gemini' && session ? [session] : [],
      sessionMeta: buildProjectSessionMetaFromProviders(providerResults),
    };
  }

  const providerResults = {
    claude: { sessions: [], hasMore: false, total: 0 },
    cursor: { sessions: [], hasMore: false, total: 0 },
    codex: { sessions: [], hasMore: false, total: 0 },
    gemini: { sessions: [], hasMore: false, total: 0 },
  };
  const shouldLoadProvider = (candidateProvider) => includeAllProviderSessions || provider === candidateProvider;

  if (shouldLoadProvider('claude')) {
    try {
      providerResults.claude = await getSessions(project.name, SESSION_PAGE_SIZE, 0);
    } catch {
      providerResults.claude = { sessions: [], hasMore: false, total: 0 };
    }
  }
  applyCustomSessionNames(providerResults.claude.sessions || [], 'claude');

  if (shouldLoadProvider('cursor')) {
    try {
      providerResults.cursor = await getCursorSessionsPage(project.fullPath, { limit: SESSION_PAGE_SIZE, offset: 0 });
    } catch {
      providerResults.cursor = { sessions: [], hasMore: false, total: 0 };
    }
  }
  applyCustomSessionNames(providerResults.cursor.sessions || [], 'cursor');

  if (shouldLoadProvider('codex')) {
    try {
      providerResults.codex = await getCodexSessionsPage(project.fullPath, { limit: SESSION_PAGE_SIZE, offset: 0 });
    } catch {
      providerResults.codex = { sessions: [], hasMore: false, total: 0 };
    }
  }
  applyCustomSessionNames(providerResults.codex.sessions || [], 'codex');

  if (shouldLoadProvider('gemini')) {
    try {
      providerResults.gemini = await getGeminiSessionsPage(project.fullPath, { limit: SESSION_PAGE_SIZE, offset: 0 });
    } catch {
      providerResults.gemini = { sessions: [], hasMore: false, total: 0 };
    }
  }
  applyCustomSessionNames(providerResults.gemini.sessions || [], 'gemini');

  return {
    ...baseProject,
    sessions: mergeBootstrapSessionIntoList(
      providerResults.claude.sessions || [],
      provider === 'claude' ? session : null,
    ),
    cursorSessions: mergeBootstrapSessionIntoList(
      providerResults.cursor.sessions || [],
      provider === 'cursor' ? session : null,
    ),
    codexSessions: mergeBootstrapSessionIntoList(
      providerResults.codex.sessions || [],
      provider === 'codex' ? session : null,
    ),
    geminiSessions: mergeBootstrapSessionIntoList(
      providerResults.gemini.sessions || [],
      provider === 'gemini' ? session : null,
    ),
    sessionMeta: buildProjectSessionMetaFromProviders(providerResults),
  };
}

async function findClaudeSessionBootstrap(sessionId, config = {}) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  let entries = [];
  try {
    entries = await fs.readdir(claudeDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectName = entry.name;
    const sessionFilePath = path.join(claudeDir, projectName, `${sessionId}.jsonl`);
    if (!(await pathExists(sessionFilePath))) {
      continue;
    }

    const parsed = await parseJsonlSessions(sessionFilePath);
    const session = parsed.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      continue;
    }

    applyCustomSessionNames([session], 'claude');

    const projectPath = await resolveProjectPathForBootstrap(projectName, config, session.cwd);
    const project = await buildProjectDescriptor(projectName, projectPath, config);

    return {
      provider: 'claude',
      project: await buildBootstrapProject(project, session, {
        provider: 'claude',
        includeAllProviderSessions: false,
        prefillSelectedSessionOnly: true,
      }),
      session: {
        ...session,
        __provider: 'claude',
        __projectName: project.name,
        __runtime: 'local',
      },
    };
  }

  return null;
}

async function findCursorSessionBootstrap(sessionId, config = {}) {
  const cursorRoot = path.join(os.homedir(), '.cursor', 'chats');
  const claudeProjectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let cwdDirs = [];
  let claudeProjectDirs = [];

  try {
    cwdDirs = await fs.readdir(cursorRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  try {
    claudeProjectDirs = await fs.readdir(claudeProjectsRoot, { withFileTypes: true });
  } catch {
    claudeProjectDirs = [];
  }

  for (const cwdEntry of cwdDirs) {
    if (!cwdEntry.isDirectory()) {
      continue;
    }

    const storeDbPath = path.join(cursorRoot, cwdEntry.name, sessionId, 'store.db');
    if (!(await pathExists(storeDbPath))) {
      continue;
    }

    const knownProject = await (async () => {
      for (const [projectName, projectConfig] of Object.entries(config)) {
        const originalPath = projectConfig?.originalPath;
        if (!originalPath) {
          continue;
        }

        const cwdHash = crypto.createHash('md5').update(originalPath).digest('hex');
        if (cwdHash === cwdEntry.name) {
          return { projectName, projectPath: originalPath };
        }
      }

      for (const projectEntry of claudeProjectDirs) {
        if (!projectEntry.isDirectory()) {
          continue;
        }

        const projectName = projectEntry.name;
        const projectPath = await resolveProjectPathForBootstrap(projectName, config);
        const cwdHash = crypto.createHash('md5').update(projectPath).digest('hex');
        if (cwdHash === cwdEntry.name) {
          return { projectName, projectPath };
        }
      }

      return null;
    })();

    if (!knownProject) {
      return null;
    }

    const cursorStore = await readCursorSessionStore(
      storeDbPath,
      { sessionId, suppressWarning: true },
      async (db) => {
        const metaRows = await db.all('SELECT key, value FROM meta');
        const messageCountResult = await db.get('SELECT COUNT(*) as count FROM blobs');

        const metadata = {};
        for (const row of metaRows) {
          if (!row.value) {
            continue;
          }

          try {
            const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
            if (hexMatch) {
              metadata[row.key] = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
            } else {
              metadata[row.key] = row.value.toString();
            }
          } catch {
            metadata[row.key] = row.value.toString();
          }
        }

        return {
          metadata,
          messageCount: messageCountResult?.count || 0,
        };
      },
    );

    if (!cursorStore.ok) {
      continue;
    }

    const { metadata, messageCount } = cursorStore.value;
    const session = {
      id: sessionId,
      summary: metadata.title || metadata.sessionTitle || 'Untitled Session',
      name: metadata.title || metadata.sessionTitle || 'Untitled Session',
      createdAt: metadata.createdAt || null,
      lastActivity: metadata.createdAt || null,
      messageCount,
    };

    const project = await buildProjectDescriptor(knownProject.projectName, knownProject.projectPath, config);
  return {
    provider: 'cursor',
    project: await buildBootstrapProject(project, session, {
      provider: 'cursor',
      includeAllProviderSessions: false,
      prefillSelectedSessionOnly: true,
    }),
    session: {
      ...session,
      __provider: 'cursor',
        __projectName: project.name,
        __runtime: 'local',
      },
    };
  }

  return null;
}

async function findCodexSessionBootstrap(sessionId, config = {}) {
  let codexSession = null;

  if (await pathExists(CODEX_STATE_DB_PATH)) {
    try {
      const db = await open({
        filename: CODEX_STATE_DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
      });

      try {
        const thread = await db.get(
          `SELECT id, rollout_path, cwd, title, updated_at, model_provider
             FROM threads
            WHERE id = ?`,
          sessionId,
        );

        if (thread?.rollout_path && await pathExists(thread.rollout_path)) {
          const parsedSession = await parseCodexSessionFile(thread.rollout_path);
          if (parsedSession?.id === sessionId) {
            codexSession = {
              ...parsedSession,
              filePath: thread.rollout_path,
              normalizedProjectPath: normalizeComparablePath(parsedSession.cwd),
            };
          }
        }
      } finally {
        await db.close();
      }
    } catch (error) {
      console.warn(`Could not read Codex bootstrap metadata for ${sessionId}:`, error.message);
    }
  }

  const cache = await refreshCodexSessionsIndex();
  const indexedSession = cache.sessionsById.get(sessionId) || null;

  if (codexSession && indexedSession) {
    codexSession = {
      ...indexedSession,
      ...codexSession,
      filePath: codexSession.filePath || indexedSession.filePath,
      normalizedProjectPath: codexSession.normalizedProjectPath || indexedSession.normalizedProjectPath,
      forkedFromId: codexSession.forkedFromId || indexedSession.forkedFromId || null,
      forkChildCount: indexedSession.forkChildCount || 0,
      forkChildIds: indexedSession.forkChildIds || [],
    };
  } else if (!codexSession) {
    codexSession = indexedSession;
  }

  if (!codexSession) {
    return null;
  }

  const session = {
    id: codexSession.id,
    summary: codexSession.summary,
    name: codexSession.summary,
    createdAt: codexSession.lastActivity,
    lastActivity: codexSession.lastActivity,
    messageCount: codexSession.messageCount,
    model: codexSession.model,
    provider: 'codex',
    forkedFromId: codexSession.forkedFromId || null,
    forkChildCount: Number(codexSession.forkChildCount || 0),
    forkChildIds: Array.isArray(codexSession.forkChildIds) ? codexSession.forkChildIds : [],
  };
  applyCustomSessionNames([session], 'codex');

  const project = await resolveProjectDescriptorForPath(codexSession.cwd, config);
  return {
    provider: 'codex',
    project: await buildBootstrapProject(project, session, {
      provider: 'codex',
      includeAllProviderSessions: false,
      prefillSelectedSessionOnly: true,
    }),
    session: {
      ...session,
      __provider: 'codex',
      __projectName: project.name,
      __runtime: 'local',
    },
  };
}

async function findGeminiSessionBootstrap(sessionId, config = {}) {
  const memorySession = sessionManager.getSession(sessionId);
  if (memorySession?.projectPath) {
    const summary = sessionManager.getSessionSummary(memorySession);
    const session = {
      id: memorySession.id,
      summary,
      name: summary,
      createdAt: memorySession.createdAt,
      lastActivity: memorySession.lastActivity,
      messageCount: memorySession.messages?.length || 0,
      provider: 'gemini',
    };
    applyCustomSessionNames([session], 'gemini');

    const project = await resolveProjectDescriptorForPath(memorySession.projectPath, config);
    return {
      provider: 'gemini',
      project: await buildBootstrapProject(project, session, {
        provider: 'gemini',
        includeAllProviderSessions: false,
        prefillSelectedSessionOnly: true,
      }),
      session: {
        ...session,
        __provider: 'gemini',
        __projectName: project.name,
        __runtime: 'local',
      },
    };
  }

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  let projectDirs = [];
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const projectRootFile = path.join(geminiTmpDir, projectDir, '.project_root');
    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let projectRoot = '';
    let chatFiles = [];

    try {
      projectRoot = (await fs.readFile(projectRootFile, 'utf8')).trim();
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) {
        continue;
      }

      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const currentSessionId = data.sessionId || chatFile.replace('.json', '');
        if (currentSessionId !== sessionId) {
          continue;
        }

        const firstUserMsg = (data.messages || []).find((message) => message.type === 'user');
        const firstUserText = Array.isArray(firstUserMsg?.content)
          ? firstUserMsg.content.filter((part) => part?.text).map((part) => part.text).join(' ')
          : (typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '');
        const summary = firstUserText
          ? (firstUserText.length > 50 ? `${firstUserText.substring(0, 50)}...` : firstUserText)
          : 'Gemini CLI Session';

        const session = {
          id: sessionId,
          summary,
          name: summary,
          createdAt: data.startTime || null,
          lastActivity: data.lastUpdated || data.startTime || null,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          provider: 'gemini',
        };
        applyCustomSessionNames([session], 'gemini');

        const project = await resolveProjectDescriptorForPath(projectRoot, config);
        return {
          provider: 'gemini',
          project: await buildBootstrapProject(project, session, { provider: 'gemini' }),
          session: {
            ...session,
            __provider: 'gemini',
            __projectName: project.name,
            __runtime: 'local',
          },
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function findE2BSessionBootstrap(sessionId, userId, config = {}) {
  const sessionRecord = e2bSessionDb.getBySessionId(sessionId);
  if (!sessionRecord || (userId && sessionRecord.user_id !== userId)) {
    return null;
  }

  const sandboxRecord = e2bSandboxDb.getBySandboxId(sessionRecord.sandbox_id);
  if (!sandboxRecord) {
    return null;
  }

  const session = normalizeE2BSessionRecord(sessionRecord);
  applyCustomSessionNames([session], 'e2b');

  const projectName = buildE2BProjectName(sandboxRecord.sandbox_id);
  const project = {
    name: projectName,
    displayName:
      config[projectName]?.displayName || getE2BProjectDisplayName(sandboxRecord.repo_url, sandboxRecord.sandbox_id),
    path: sandboxRecord.workspace_path || '/home/user',
    fullPath: sandboxRecord.workspace_path || '/home/user',
    authSelections: extractProjectAuthSelections(parseJsonOrNull(sandboxRecord.metadata_json)?.authSelections),
  };
  const subProvider = resolveE2BAgentProvider(sessionRecord.agent);

  return {
    provider: 'e2b',
    project: await buildBootstrapProject(
      project,
      session,
      {
        provider: 'e2b',
        runtime: 'e2b',
        kind: 'cloud',
        cloud: {
          sandboxId: sandboxRecord.sandbox_id,
          status: sandboxRecord.status,
          repoUrl: sandboxRecord.repo_url,
          branch: sandboxRecord.branch,
          workspacePath: sandboxRecord.workspace_path,
          createdAt: sandboxRecord.created_at,
          lastActivity: sandboxRecord.last_activity,
          metadata: parseJsonOrNull(sandboxRecord.metadata_json),
        },
      },
    ),
    session: {
      ...session,
      __provider: subProvider,
      __projectName: project.name,
      __runtime: 'e2b',
    },
  };
}

async function findSessionBootstrapFallback(sessionId, userId) {
  const projects = await getProjects(null, { userId });

  for (const project of projects) {
    const session =
      project.sessions?.find((candidate) => candidate.id === sessionId) ||
      project.cursorSessions?.find((candidate) => candidate.id === sessionId) ||
      project.codexSessions?.find((candidate) => candidate.id === sessionId) ||
      project.geminiSessions?.find((candidate) => candidate.id === sessionId) ||
      project.e2bSessions?.find((candidate) => candidate.id === sessionId);

    if (!session) {
      continue;
    }

    const provider =
      project.e2bSessions?.some((candidate) => candidate.id === sessionId)
        ? resolveE2BAgentProvider(session.agent || session.provider)
        : project.cursorSessions?.some((candidate) => candidate.id === sessionId)
          ? 'cursor'
          : project.codexSessions?.some((candidate) => candidate.id === sessionId)
            ? 'codex'
            : project.geminiSessions?.some((candidate) => candidate.id === sessionId)
              ? 'gemini'
              : 'claude';

    return {
      provider: project.runtime === 'e2b' ? 'e2b' : provider,
      project,
      session: {
        ...session,
        __provider: provider,
        __projectName: project.name,
        __runtime: project.runtime === 'e2b' ? 'e2b' : 'local',
      },
    };
  }

  return null;
}

async function getSessionBootstrap(sessionId, options = {}) {
  const { userId = null } = options;
  const config = await loadProjectConfig();

  const fastResolvers = sessionId.startsWith('e2b_')
    ? [
        () => findE2BSessionBootstrap(sessionId, userId, config),
        () => findClaudeSessionBootstrap(sessionId, config),
        () => findCodexSessionBootstrap(sessionId, config),
        () => findGeminiSessionBootstrap(sessionId, config),
        () => findCursorSessionBootstrap(sessionId, config),
      ]
    : looksLikeUuidSessionId(sessionId)
      ? [
          () => findE2BSessionBootstrap(sessionId, userId, config),
          () => findCodexSessionBootstrap(sessionId, config),
          () => findGeminiSessionBootstrap(sessionId, config),
          () => findCursorSessionBootstrap(sessionId, config),
          () => findClaudeSessionBootstrap(sessionId, config),
        ]
      : [
          () => findE2BSessionBootstrap(sessionId, userId, config),
          () => findClaudeSessionBootstrap(sessionId, config),
          () => findCodexSessionBootstrap(sessionId, config),
          () => findGeminiSessionBootstrap(sessionId, config),
          () => findCursorSessionBootstrap(sessionId, config),
        ];

  for (const resolver of fastResolvers) {
    try {
      const result = await resolver();
      if (result) {
        return result;
      }
    } catch (error) {
      console.warn(`[Projects] Session bootstrap resolver failed for ${sessionId}:`, error.message);
    }
  }

  return findSessionBootstrapFallback(sessionId, userId);
}

async function getProjects(progressCallback = null, options = {}) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const config = await loadProjectConfig();
  const { userId = null } = options;
  const projects = [];
  const existingProjects = new Set();
  const codexSessionsIndexRef = { sessionsByProject: null };
  let totalProjects = 0;
  let processedProjects = 0;
  let directories = [];

  try {
    // Check if the .claude/projects directory exists
    await fs.access(claudeDir);

    // First, get existing Claude projects from the file system
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    directories = entries.filter(e => e.isDirectory());

    // Build set of existing project names for later
    directories.forEach(e => existingProjects.add(e.name));

    // Count manual projects not already in directories
    const manualProjectsCount = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded && !existingProjects.has(name))
      .length;

    totalProjects = directories.length + manualProjectsCount;

    for (const entry of directories) {
      processedProjects++;

      // Emit progress
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: entry.name
        });
      }

      // Extract actual project directory from JSONL sessions
      const actualProjectDir = await extractProjectDirectory(entry.name);

      // Get display name from config or generate one
      const customName = config[entry.name]?.displayName;
      const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);
      const fullPath = actualProjectDir;

      const project = {
        name: entry.name,
        path: actualProjectDir,
        displayName: customName || autoDisplayName,
        fullPath: fullPath,
        kind: 'local',
        runtime: 'local',
        capabilities: getProjectCapabilities('local'),
        isCustomName: !!customName,
        authSelections: extractProjectAuthSelections(config[entry.name]?.authSelections),
        sessions: [],
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        sessionMeta: buildProjectSessionMetaFromProviders(),
      };
      const providerResults = {};

      // Try to get sessions for this project (first page for performance)
      try {
        const sessionResult = await getSessions(entry.name, SESSION_PAGE_SIZE, 0);
        project.sessions = sessionResult.sessions || [];
        providerResults.claude = sessionResult;
      } catch (e) {
        console.warn(`Could not load sessions for project ${entry.name}:`, e.message);
        providerResults.claude = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.sessions, 'claude');

      // Also fetch Cursor sessions for this project
      try {
        const cursorResult = await getCursorSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
        });
        project.cursorSessions = cursorResult.sessions || [];
        providerResults.cursor = cursorResult;
      } catch (e) {
        console.warn(`Could not load Cursor sessions for project ${entry.name}:`, e.message);
        project.cursorSessions = [];
        providerResults.cursor = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.cursorSessions, 'cursor');

      // Also fetch Codex sessions for this project
      try {
        const codexResult = await getCodexSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
          indexRef: codexSessionsIndexRef,
        });
        project.codexSessions = codexResult.sessions || [];
        providerResults.codex = codexResult;
      } catch (e) {
        console.warn(`Could not load Codex sessions for project ${entry.name}:`, e.message);
        project.codexSessions = [];
        providerResults.codex = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.codexSessions, 'codex');

      // Also fetch Gemini sessions for this project (UI + CLI)
      try {
        const geminiResult = await getGeminiSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
        });
        project.geminiSessions = geminiResult.sessions || [];
        providerResults.gemini = geminiResult;
      } catch (e) {
        console.warn(`Could not load Gemini sessions for project ${entry.name}:`, e.message);
        project.geminiSessions = [];
        providerResults.gemini = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.geminiSessions, 'gemini');
      project.sessionMeta = buildProjectSessionMetaFromProviders(providerResults);

      // Add TaskMaster detection
      try {
        const taskMasterResult = await detectTaskMasterFolder(actualProjectDir);
        project.taskmaster = {
          hasTaskmaster: taskMasterResult.hasTaskmaster,
          hasEssentialFiles: taskMasterResult.hasEssentialFiles,
          metadata: taskMasterResult.metadata,
          status: taskMasterResult.hasTaskmaster && taskMasterResult.hasEssentialFiles ? 'configured' : 'not-configured'
        };
      } catch (e) {
        console.warn(`Could not detect TaskMaster for project ${entry.name}:`, e.message);
        project.taskmaster = {
          hasTaskmaster: false,
          hasEssentialFiles: false,
          metadata: null,
          status: 'error'
        };
      }

      projects.push(project);
    }
  } catch (error) {
    // If the directory doesn't exist (ENOENT), that's okay - just continue with empty projects
    if (error.code !== 'ENOENT') {
      console.error('Error reading projects directory:', error);
    }
    // Calculate total for manual projects only (no directories exist)
    totalProjects = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded)
      .length;
  }

  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      processedProjects++;

      // Emit progress for manual projects
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: projectName
        });
      }

      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;

      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, '/');
        }
      }

      const project = {
        name: projectName,
        path: actualProjectDir,
        displayName: projectConfig.displayName || await generateDisplayName(projectName, actualProjectDir),
        fullPath: actualProjectDir,
        kind: 'local',
        runtime: 'local',
        capabilities: getProjectCapabilities('local'),
        isCustomName: !!projectConfig.displayName,
        isManuallyAdded: true,
        authSelections: extractProjectAuthSelections(projectConfig?.authSelections),
        sessions: [],
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        sessionMeta: buildProjectSessionMetaFromProviders(),
      };
      const providerResults = {
        claude: { sessions: [], hasMore: false, total: 0 },
      };

      // Try to fetch Cursor sessions for manual projects too
      try {
        const cursorResult = await getCursorSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
        });
        project.cursorSessions = cursorResult.sessions || [];
        providerResults.cursor = cursorResult;
      } catch (e) {
        console.warn(`Could not load Cursor sessions for manual project ${projectName}:`, e.message);
        providerResults.cursor = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.cursorSessions, 'cursor');

      // Try to fetch Codex sessions for manual projects too
      try {
        const codexResult = await getCodexSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
          indexRef: codexSessionsIndexRef,
        });
        project.codexSessions = codexResult.sessions || [];
        providerResults.codex = codexResult;
      } catch (e) {
        console.warn(`Could not load Codex sessions for manual project ${projectName}:`, e.message);
        providerResults.codex = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.codexSessions, 'codex');

      // Try to fetch Gemini sessions for manual projects too (UI + CLI)
      try {
        const geminiResult = await getGeminiSessionsPage(actualProjectDir, {
          limit: SESSION_PAGE_SIZE,
          offset: 0,
        });
        project.geminiSessions = geminiResult.sessions || [];
        providerResults.gemini = geminiResult;
      } catch (e) {
        console.warn(`Could not load Gemini sessions for manual project ${projectName}:`, e.message);
        providerResults.gemini = { sessions: [], hasMore: false, total: 0 };
      }
      applyCustomSessionNames(project.geminiSessions, 'gemini');
      project.sessionMeta = buildProjectSessionMetaFromProviders(providerResults);

      // Add TaskMaster detection for manual projects
      try {
        const taskMasterResult = await detectTaskMasterFolder(actualProjectDir);

        // Determine TaskMaster status
        let taskMasterStatus = 'not-configured';
        if (taskMasterResult.hasTaskmaster && taskMasterResult.hasEssentialFiles) {
          taskMasterStatus = 'taskmaster-only'; // We don't check MCP for manual projects in bulk
        }

        project.taskmaster = {
          status: taskMasterStatus,
          hasTaskmaster: taskMasterResult.hasTaskmaster,
          hasEssentialFiles: taskMasterResult.hasEssentialFiles,
          metadata: taskMasterResult.metadata
        };
      } catch (error) {
        console.warn(`TaskMaster detection failed for manual project ${projectName}:`, error.message);
        project.taskmaster = {
          status: 'error',
          hasTaskmaster: false,
          hasEssentialFiles: false,
          error: error.message
        };
      }

      projects.push(project);
    }
  }

  if (userId) {
    try {
      const cloudProjects = e2bSandboxDb
        .getActive(userId)
        .map((sandboxRecord) => buildE2BProject(sandboxRecord, config));
      projects.push(...cloudProjects);
    } catch (error) {
      console.warn('[Projects] Could not load E2B cloud projects:', error.message);
    }
  }

  // Emit completion after all projects (including manual) are processed
  if (progressCallback) {
    progressCallback({
      phase: 'complete',
      current: totalProjects,
      total: totalProjects
    });
  }

  return projects;
}

async function getSessions(projectName, limit = 5, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    // agent-*.jsonl files contain session start data at this point. This needs to be revisited
    // periodically to make sure only accurate data is there and no new functionality is added there
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }

    // Sort files by modification time (newest first)
    const filesWithStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime };
      })
    );
    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    const allSessions = new Map();
    const allEntries = [];
    const uuidToSessionMap = new Map();

    // Collect all sessions and entries from all files
    for (const { file } of filesWithStats) {
      const jsonlFile = path.join(projectDir, file);
      const result = await parseJsonlSessions(jsonlFile);

      result.sessions.forEach(session => {
        if (!allSessions.has(session.id)) {
          allSessions.set(session.id, session);
        }
      });

      allEntries.push(...result.entries);

      // Early exit optimization for large projects
      if (allSessions.size >= (limit + offset) * 2 && allEntries.length >= Math.min(3, filesWithStats.length)) {
        break;
      }
    }

    // Build UUID-to-session mapping for timeline detection
    allEntries.forEach(entry => {
      if (entry.uuid && entry.sessionId) {
        uuidToSessionMap.set(entry.uuid, entry.sessionId);
      }
    });

    // Group sessions by first user message ID
    const sessionGroups = new Map(); // firstUserMsgId -> { latestSession, allSessions[] }
    const sessionToFirstUserMsgId = new Map(); // sessionId -> firstUserMsgId

    // Find the first user message for each session
    allEntries.forEach(entry => {
      if (entry.sessionId && entry.type === 'user' && entry.parentUuid === null && entry.uuid) {
        // This is a first user message in a session (parentUuid is null)
        const firstUserMsgId = entry.uuid;

        if (!sessionToFirstUserMsgId.has(entry.sessionId)) {
          sessionToFirstUserMsgId.set(entry.sessionId, firstUserMsgId);

          const session = allSessions.get(entry.sessionId);
          if (session) {
            if (!sessionGroups.has(firstUserMsgId)) {
              sessionGroups.set(firstUserMsgId, {
                latestSession: session,
                allSessions: [session]
              });
            } else {
              const group = sessionGroups.get(firstUserMsgId);
              group.allSessions.push(session);

              // Update latest session if this one is more recent
              if (new Date(session.lastActivity) > new Date(group.latestSession.lastActivity)) {
                group.latestSession = session;
              }
            }
          }
        }
      }
    });

    // Collect all sessions that don't belong to any group (standalone sessions)
    const groupedSessionIds = new Set();
    sessionGroups.forEach(group => {
      group.allSessions.forEach(session => groupedSessionIds.add(session.id));
    });

    const standaloneSessionsArray = Array.from(allSessions.values())
      .filter(session => !groupedSessionIds.has(session.id));

    // Combine grouped sessions (only show latest from each group) + standalone sessions
    const latestFromGroups = Array.from(sessionGroups.values()).map(group => {
      const session = { ...group.latestSession };
      // Add metadata about grouping
      if (group.allSessions.length > 1) {
        session.isGrouped = true;
        session.groupSize = group.allSessions.length;
        session.groupSessions = group.allSessions.map(s => s.id);
      }
      return session;
    });
    const visibleSessions = [...latestFromGroups, ...standaloneSessionsArray]
      .filter(session => !session.summary.startsWith('{ "'))
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const total = visibleSessions.length;
    const paginatedSessions = visibleSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  const entries = [];
  const pendingSummaries = new Map(); // leafUuid -> summary for entries without sessionId

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          entries.push(entry);

          // Handle summary entries that don't have sessionId yet
          if (entry.type === 'summary' && entry.summary && !entry.sessionId && entry.leafUuid) {
            pendingSummaries.set(entry.leafUuid, entry.summary);
          }

          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: 'New Session',
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || '',
                lastUserMessage: null,
                lastAssistantMessage: null
              });
            }

            const session = sessions.get(entry.sessionId);

            if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
              session.cwd = entry.cwd;
            }

            // Apply pending summary if this entry has a parentUuid that matches a pending summary
            if (session.summary === 'New Session' && entry.parentUuid && pendingSummaries.has(entry.parentUuid)) {
              session.summary = pendingSummaries.get(entry.parentUuid);
            }

            // Update summary from summary entries with sessionId
            if (entry.type === 'summary' && entry.summary) {
              session.summary = entry.summary;
            }

            // Track last user and assistant messages (skip system messages)
            if (entry.message?.role === 'user' && entry.message?.content) {
              const content = entry.message.content;

              // Extract text from array format if needed
              let textContent = content;
              if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                textContent = content[0].text;
              }

              const isSystemMessage = typeof textContent === 'string' && (
                textContent.startsWith('<command-name>') ||
                textContent.startsWith('<command-message>') ||
                textContent.startsWith('<command-args>') ||
                textContent.startsWith('<local-command-stdout>') ||
                textContent.startsWith('<system-reminder>') ||
                textContent.startsWith('Caveat:') ||
                textContent.startsWith('This session is being continued from a previous') ||
                textContent.startsWith('Invalid API key') ||
                textContent.includes('{"subtasks":') || // Filter Task Master prompts
                textContent.includes('CRITICAL: You MUST respond with ONLY a JSON') || // Filter Task Master system prompts
                textContent === 'Warmup' // Explicitly filter out "Warmup"
              );

              if (typeof textContent === 'string' && textContent.length > 0 && !isSystemMessage) {
                session.lastUserMessage = textContent;
              }
            } else if (entry.message?.role === 'assistant' && entry.message?.content) {
              // Skip API error messages using the isApiErrorMessage flag
              if (entry.isApiErrorMessage === true) {
                // Skip this message entirely
              } else {
                // Track last assistant text message
                let assistantText = null;

                if (Array.isArray(entry.message.content)) {
                  for (const part of entry.message.content) {
                    if (part.type === 'text' && part.text) {
                      assistantText = part.text;
                    }
                  }
                } else if (typeof entry.message.content === 'string') {
                  assistantText = entry.message.content;
                }

                // Additional filter for assistant messages with system content
                const isSystemAssistantMessage = typeof assistantText === 'string' && (
                  assistantText.startsWith('Invalid API key') ||
                  assistantText.includes('{"subtasks":') ||
                  assistantText.includes('CRITICAL: You MUST respond with ONLY a JSON')
                );

                if (assistantText && !isSystemAssistantMessage) {
                  session.lastAssistantMessage = assistantText;
                }
              }
            }

            session.messageCount++;

            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          // Skip malformed lines silently
        }
      }
    }

    // After processing all entries, set final summary based on last message if no summary exists
    for (const session of sessions.values()) {
      if (session.summary === 'New Session') {
        // Prefer last user message, fall back to last assistant message
        const lastMessage = session.lastUserMessage || session.lastAssistantMessage;
        if (lastMessage) {
          session.summary = lastMessage.length > 50 ? lastMessage.substring(0, 50) + '...' : lastMessage;
        }
      }
    }

    // Filter out sessions that contain JSON responses (Task Master errors)
    const allSessions = Array.from(sessions.values());
    const filteredSessions = allSessions.filter(session => {
      const shouldFilter = session.summary.startsWith('{ "');
      if (shouldFilter) {
      }
      // Log a sample of summaries to debug
      if (Math.random() < 0.01) { // Log 1% of sessions
      }
      return !shouldFilter;
    });


    return {
      sessions: filteredSessions,
      entries: entries
    };

  } catch (error) {
    console.error('Error reading JSONL file:', error);
    return { sessions: [], entries: [] };
  }
}

// Parse an agent JSONL file and extract tool uses
async function parseAgentTools(filePath) {
  const tools = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          // Look for assistant messages with tool_use
          if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_use') {
                tools.push({
                  toolId: part.id,
                  toolName: part.name,
                  toolInput: part.input,
                  timestamp: entry.timestamp
                });
              }
            }
          }
          // Look for tool results
          if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_result') {
                // Find the matching tool and add result
                const tool = tools.find(t => t.toolId === part.tool_use_id);
                if (tool) {
                  tool.toolResult = {
                    content: typeof part.content === 'string' ? part.content :
                      Array.isArray(part.content) ? part.content.map(c => c.text || '').join('\n') :
                        JSON.stringify(part.content),
                    isError: Boolean(part.is_error)
                  };
                }
              }
            }
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }
  } catch (error) {
    console.warn(`Error parsing agent file ${filePath}:`, error.message);
  }

  return tools;
}

// Get messages for a specific session with pagination support
async function getSessionMessages(projectName, sessionId, limit = null, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    // agent-*.jsonl files contain subagent tool history - we'll process them separately
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
    const agentFiles = files.filter(file => file.endsWith('.jsonl') && file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    // Map of agentId -> tools for subagent tool grouping
    const agentToolsCache = new Map();

    // Process all JSONL files to find messages for this session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            // Silently skip malformed JSONL lines (common with concurrent writes)
          }
        }
      }
    }

    // Collect agentIds from Task tool results
    const agentIds = new Set();
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        agentIds.add(message.toolUseResult.agentId);
      }
    }

    // Load agent tools for each agentId found
    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (agentFiles.includes(agentFileName)) {
        const agentFilePath = path.join(projectDir, agentFileName);
        const tools = await parseAgentTools(agentFilePath);
        agentToolsCache.set(agentId, tools);
      }
    }

    // Attach agent tools to their parent Task messages
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        const agentId = message.toolUseResult.agentId;
        const agentTools = agentToolsCache.get(agentId);
        if (agentTools && agentTools.length > 0) {
          message.subagentTools = agentTools;
        }
      }
    }
    // Sort messages by timestamp
    const sortedMessages = messages.sort((a, b) =>
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );

    const total = sortedMessages.length;

    // If no limit is specified, return all messages (backward compatibility)
    if (limit === null) {
      return sortedMessages;
    }

    // Apply pagination - for recent messages, we need to slice from the end
    // offset 0 should give us the most recent messages
    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();

  if (!newDisplayName || newDisplayName.trim() === '') {
    // Remove custom name if empty, will fall back to auto-generated
    if (config[projectName]) {
      delete config[projectName].displayName;
    }
  } else {
    // Set custom display name, preserving other properties (manuallyAdded, originalPath)
    config[projectName] = {
      ...config[projectName],
      displayName: newDisplayName.trim()
    };
  }

  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      throw new Error('No session files found for this project');
    }

    // Check all JSONL files to find which one contains the session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const content = await fs.readFile(jsonlFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      // Check if this file contains the session
      const hasSession = lines.some(line => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sessionId;
        } catch {
          return false;
        }
      });

      if (hasSession) {
        // Filter out all entries for this session
        const filteredLines = lines.filter(line => {
          try {
            const data = JSON.parse(line);
            return data.sessionId !== sessionId;
          } catch {
            return true; // Keep malformed lines
          }
        });

        // Write back the filtered content
        await fs.writeFile(jsonlFile, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''));
        return true;
      }
    }

    throw new Error(`Session ${sessionId} not found in any files`);
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete a project (force=true to delete even with sessions)
async function deleteProject(projectName, force = false) {
  if (isE2BProjectName(projectName)) {
    const sandboxId = extractSandboxIdFromProjectName(projectName);
    if (!sandboxId) {
      throw new Error('Invalid E2B cloud project name');
    }

    const config = await loadProjectConfig();
    delete config[projectName];
    await saveProjectConfig(config);

    e2bSandboxDb.updateStatus(sandboxId, 'destroyed');
    e2bSessionMessagesDb.deleteBySandboxId(sandboxId);
    e2bSessionDb.deleteBySandboxId(sandboxId);
    return true;
  }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty && !force) {
      throw new Error('Cannot delete project with existing sessions');
    }

    const config = await loadProjectConfig();
    let projectPath = config[projectName]?.path || config[projectName]?.originalPath;

    // Fallback to extractProjectDirectory if projectPath is not in config
    if (!projectPath) {
      projectPath = await extractProjectDirectory(projectName);
    }

    // Remove the project directory (includes all Claude sessions)
    await fs.rm(projectDir, { recursive: true, force: true });

    // Delete all Codex sessions associated with this project
    if (projectPath) {
      try {
        const codexSessions = await getCodexSessions(projectPath, { limit: 0 });
        for (const session of codexSessions) {
          try {
            await deleteCodexSession(session.id);
          } catch (err) {
            console.warn(`Failed to delete Codex session ${session.id}:`, err.message);
          }
        }
      } catch (err) {
        console.warn('Failed to delete Codex sessions:', err.message);
      }

      // Delete Cursor sessions directory if it exists
      try {
        const hash = crypto.createHash('md5').update(projectPath).digest('hex');
        const cursorProjectDir = path.join(os.homedir(), '.cursor', 'chats', hash);
        await fs.rm(cursorProjectDir, { recursive: true, force: true });
      } catch (err) {
        // Cursor dir may not exist, ignore
      }
    }

    // Remove from project config
    delete config[projectName];
    await saveProjectConfig(config);

    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (without creating folders)
async function addProjectManually(projectPath, displayName = null) {
  const absolutePath = path.resolve(projectPath);

  try {
    // Check if the path exists
    await fs.access(absolutePath);
  } catch (error) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  // Generate project name (encode path for use as directory name)
  const projectName = absolutePath.replace(/[\\/:\s~_]/g, '-');

  // Check if project already exists in config
  const config = await loadProjectConfig();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  if (config[projectName]) {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }

  // Allow adding projects even if the directory exists - this enables tracking
  // existing Claude Code or Cursor projects in the UI

  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };

  if (displayName) {
    config[projectName].displayName = displayName;
  }

  await saveProjectConfig(config);


  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectName, absolutePath),
    isManuallyAdded: true,
    authSelections: null,
    sessions: [],
    cursorSessions: []
  };
}

// Fetch Cursor sessions for a given project path
async function getCursorSessionsPage(projectPath, options = {}) {
  const { limit = SESSION_PAGE_SIZE, offset = 0 } = options;
  try {
    const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath = path.join(os.homedir(), '.cursor', 'chats', cwdId);

    try {
      await fs.access(cursorChatsPath);
    } catch {
      return { sessions: [], hasMore: false, total: 0, offset, limit };
    }

    const sessionDirs = await fs.readdir(cursorChatsPath);
    const sessions = [];

    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(cursorChatsPath, sessionId);
      const storeDbPath = path.join(sessionPath, 'store.db');

      try {
        await fs.access(storeDbPath);

        const cursorStore = await readCursorSessionStore(
          storeDbPath,
          { sessionId },
          async (db, { dbStatMtimeMs }) => {
            const metaRows = await db.all('SELECT key, value FROM meta');
            const messageCountResult = await db.get('SELECT COUNT(*) as count FROM blobs');

            const metadata = {};
            for (const row of metaRows) {
              if (!row.value) {
                continue;
              }

              try {
                const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
                if (hexMatch) {
                  const jsonStr = Buffer.from(row.value, 'hex').toString('utf8');
                  metadata[row.key] = JSON.parse(jsonStr);
                } else {
                  metadata[row.key] = row.value.toString();
                }
              } catch {
                metadata[row.key] = row.value.toString();
              }
            }

            return {
              metadata,
              messageCount: messageCountResult?.count || 0,
              dbStatMtimeMs,
            };
          },
        );

        if (!cursorStore.ok) {
          continue;
        }

        const { metadata, messageCount, dbStatMtimeMs } = cursorStore.value;
        const sessionName = metadata.title || metadata.sessionTitle || 'Untitled Session';

        let createdAt = null;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt).toISOString();
        } else if (dbStatMtimeMs) {
          createdAt = new Date(dbStatMtimeMs).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        sessions.push({
          id: sessionId,
          name: sessionName,
          createdAt,
          lastActivity: createdAt,
          messageCount,
          projectPath,
        });
      } catch (error) {
        console.warn(`Could not read Cursor session ${sessionId}:`, error.message);
      }
    }

    return paginateSessions(sortSessionsByLastActivity(sessions), limit, offset);
  } catch (error) {
    console.error('Error fetching Cursor sessions:', error);
    return { sessions: [], hasMore: false, total: 0, offset, limit };
  }
}

async function getCursorSessions(projectPath, options = {}) {
  const result = await getCursorSessionsPage(projectPath, options);
  return result.sessions;
}


function normalizeComparablePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());

  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findCodexJsonlFiles(dir) {
  const files = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findCodexJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return files;
}

function rebuildCodexSessionsIndexMaps() {
  const sessionsByProject = new Map();
  const sessionsById = new Map();

  for (const entry of codexSessionsIndexCache.files.values()) {
    if (!entry?.session) {
      continue;
    }

    const session = {
      ...entry.session,
      filePath: entry.filePath,
    };
    const existingSession = sessionsById.get(session.id);

    if (
      !existingSession ||
      new Date(session.lastActivity || 0).getTime() >= new Date(existingSession.lastActivity || 0).getTime()
    ) {
      sessionsById.set(session.id, session);
    }
  }

  for (const session of sessionsById.values()) {
    session.forkChildCount = 0;
    session.forkChildIds = [];
  }

  for (const session of sessionsById.values()) {
    const forkedFromId = typeof session.forkedFromId === 'string' ? session.forkedFromId.trim() : '';
    if (!forkedFromId) {
      continue;
    }

    const parentSession = sessionsById.get(forkedFromId);
    if (!parentSession) {
      continue;
    }

    parentSession.forkChildCount = Number(parentSession.forkChildCount || 0) + 1;
    parentSession.forkChildIds = [...(parentSession.forkChildIds || []), session.id];
  }

  for (const session of sessionsById.values()) {
    if (!sessionsByProject.has(session.normalizedProjectPath)) {
      sessionsByProject.set(session.normalizedProjectPath, []);
    }

    sessionsByProject.get(session.normalizedProjectPath).push(session);
  }

  for (const sessions of sessionsByProject.values()) {
    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  codexSessionsIndexCache.sessionsByProject = sessionsByProject;
  codexSessionsIndexCache.sessionsById = sessionsById;
}

async function refreshCodexSessionsIndex({ force = false } = {}) {
  if (!force && codexSessionsIndexCache.refreshPromise) {
    return codexSessionsIndexCache.refreshPromise;
  }

  if (
    !force &&
    codexSessionsIndexCache.lastRefreshAt > 0 &&
    Date.now() - codexSessionsIndexCache.lastRefreshAt < CODEX_INDEX_REFRESH_TTL_MS
  ) {
    return {
      sessionsByProject: codexSessionsIndexCache.sessionsByProject,
      sessionsById: codexSessionsIndexCache.sessionsById,
    };
  }

  codexSessionsIndexCache.refreshPromise = (async () => {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    const nextFiles = new Map();

    try {
      await fs.access(codexSessionsDir);
    } catch (error) {
      codexSessionsIndexCache.files = new Map();
      codexSessionsIndexCache.sessionsByProject = new Map();
      codexSessionsIndexCache.sessionsById = new Map();
      codexSessionsIndexCache.lastRefreshAt = Date.now();
      return {
        sessionsByProject: codexSessionsIndexCache.sessionsByProject,
        sessionsById: codexSessionsIndexCache.sessionsById,
      };
    }

    const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        continue;
      }

      const prev = codexSessionsIndexCache.files.get(filePath);
      if (prev && prev.mtimeMs === stats.mtimeMs && prev.size === stats.size) {
        nextFiles.set(filePath, prev);
        continue;
      }

      try {
        const sessionData = await parseCodexSessionFile(filePath);
        if (!sessionData?.id) {
          nextFiles.set(filePath, {
            filePath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            session: null,
          });
          continue;
        }

        const normalizedProjectPath = normalizeComparablePath(sessionData.cwd);
        if (!normalizedProjectPath) {
          nextFiles.set(filePath, {
            filePath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            session: null,
          });
          continue;
        }

        nextFiles.set(filePath, {
          filePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          session: {
            id: sessionData.id,
            summary: sessionData.summary || 'Codex Session',
            messageCount: sessionData.messageCount || 0,
            lastActivity: sessionData.timestamp ? new Date(sessionData.timestamp) : new Date(),
            cwd: sessionData.cwd,
            model: sessionData.model,
            provider: 'codex',
            forkedFromId: sessionData.forkedFromId || null,
            normalizedProjectPath,
          },
        });
      } catch (error) {
        console.warn(`Could not parse Codex session file ${filePath}:`, error.message);
      }
    }

    codexSessionsIndexCache.files = nextFiles;
    rebuildCodexSessionsIndexMaps();
    codexSessionsIndexCache.lastRefreshAt = Date.now();

    return {
      sessionsByProject: codexSessionsIndexCache.sessionsByProject,
      sessionsById: codexSessionsIndexCache.sessionsById,
    };
  })();

  try {
    return await codexSessionsIndexCache.refreshPromise;
  } finally {
    codexSessionsIndexCache.refreshPromise = null;
  }
}

// Fetch Codex sessions for a given project path
async function getCodexSessionsPage(projectPath, options = {}) {
  const { limit = SESSION_PAGE_SIZE, offset = 0, indexRef = null } = options;
  try {
    const normalizedProjectPath = normalizeComparablePath(projectPath);
    if (!normalizedProjectPath) {
      return [];
    }

    if (indexRef && !indexRef.sessionsByProject) {
      const cache = await refreshCodexSessionsIndex();
      indexRef.sessionsByProject = cache.sessionsByProject;
    }

    const sessionsByProject = indexRef?.sessionsByProject || (await refreshCodexSessionsIndex()).sessionsByProject;
    const sessions = sessionsByProject.get(normalizedProjectPath) || [];

    return paginateSessions(sessions, limit, offset);

  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    return { sessions: [], hasMore: false, total: 0, offset, limit };
  }
}

async function getCodexSessions(projectPath, options = {}) {
  const result = await getCodexSessionsPage(projectPath, options);
  return result.sessions;
}

function isVisibleCodexUserMessage(payload) {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  // Codex logs internal context (environment, instructions) as non-plain user_message kinds.
  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  if (typeof payload.message !== 'string' || payload.message.trim().length === 0) {
    return false;
  }
  
  return true;
}

// Parse a Codex session JSONL file to extract metadata
async function parseCodexSessionFile(filePath) {
  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let sessionMeta = null;
    let lastTimestamp = null;
    let lastUserMessage = null;
    let messageCount = 0;

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);

          // Track timestamp
          if (entry.timestamp) {
            lastTimestamp = entry.timestamp;
          }

          // Extract session metadata
          if (entry.type === 'session_meta' && entry.payload) {
            const nextSessionMeta = {
              id: entry.payload.id,
              cwd: entry.payload.cwd,
              model: entry.payload.model || entry.payload.model_provider,
              timestamp: entry.timestamp,
              git: entry.payload.git,
              forkedFromId:
                typeof entry.payload.forked_from_id === 'string' && entry.payload.forked_from_id.trim()
                  ? entry.payload.forked_from_id.trim()
                  : null,
            };

            if (!sessionMeta) {
              sessionMeta = nextSessionMeta;
            } else if (sessionMeta.id === nextSessionMeta.id) {
              sessionMeta = {
                ...sessionMeta,
                ...nextSessionMeta,
                forkedFromId: sessionMeta.forkedFromId || nextSessionMeta.forkedFromId || null,
              };
            }
          }

          // Count visible user messages and extract summary from the latest plain user input.
          if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload)) {
            messageCount++;
            if (entry.payload.message) {
              lastUserMessage = entry.payload.message;
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
            messageCount++;
          }

        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }

    if (sessionMeta) {
      return {
        ...sessionMeta,
        timestamp: lastTimestamp || sessionMeta.timestamp,
        summary: lastUserMessage ?
          (lastUserMessage.length > 50 ? lastUserMessage.substring(0, 50) + '...' : lastUserMessage) :
          'Codex Session',
        messageCount
      };
    }

    return null;

  } catch (error) {
    console.error('Error parsing Codex session file:', error);
    return null;
  }
}

// Get messages for a specific Codex session
async function getCodexSessionMessages(sessionId, limit = null, offset = 0) {
  try {
    const cache = await refreshCodexSessionsIndex();
    const sessionFilePath = cache.sessionsById.get(sessionId)?.filePath || null;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    let tokenUsage = null;
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    // Helper to extract text from Codex content array
    const extractText = (content) => {
      if (!Array.isArray(content)) return content;
      return content
        .map(item => {
          if (item.type === 'input_text' || item.type === 'output_text') {
            return item.text;
          }
          if (item.type === 'text') {
            return item.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    };

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);

          // Extract token usage from token_count events (keep latest)
          if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
            const info = entry.payload.info;
            if (info.total_token_usage) {
              tokenUsage = {
                used: info.total_token_usage.total_tokens || 0,
                total: info.model_context_window || 200000
              };
            }
          }
          
          // Use event_msg.user_message for user-visible inputs.
          if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload)) {
            messages.push({
              type: 'user',
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: entry.payload.message
              }
            });
          }

          // response_item.message may include internal prompts for non-assistant roles.
          // Keep only assistant output from response_item.
          if (
            entry.type === 'response_item' &&
            entry.payload?.type === 'message' &&
            entry.payload.role === 'assistant'
          ) {
            const content = entry.payload.content;
            const textContent = extractText(content);

            // Only add if there's actual content
            if (textContent?.trim()) {
              messages.push({
                type: 'assistant',
                timestamp: entry.timestamp,
                message: {
                  role: 'assistant',
                  content: textContent
                }
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
            const summaryText = entry.payload.summary
              ?.map(s => s.text)
              .filter(Boolean)
              .join('\n');
            if (summaryText?.trim()) {
              messages.push({
                type: 'thinking',
                timestamp: entry.timestamp,
                message: {
                  role: 'assistant',
                  content: summaryText
                }
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
            let toolName = entry.payload.name;
            let toolInput = entry.payload.arguments;

            // Map Codex tool names to Claude equivalents
            if (toolName === 'shell_command') {
              toolName = 'Bash';
              try {
                const args = JSON.parse(entry.payload.arguments);
                toolInput = JSON.stringify({ command: args.command });
              } catch (e) {
                // Keep original if parsing fails
              }
            }

            messages.push({
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: toolName,
              toolInput: toolInput,
              toolCallId: entry.payload.call_id
            });
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
            messages.push({
              type: 'tool_result',
              timestamp: entry.timestamp,
              toolCallId: entry.payload.call_id,
              output: entry.payload.output
            });
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
            const toolName = entry.payload.name || 'custom_tool';
            const input = entry.payload.input || '';

            if (toolName === 'apply_patch') {
              // Parse Codex patch format and convert to Claude Edit format
              const fileMatch = input.match(/\*\*\* Update File: (.+)/);
              const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';

              // Extract old and new content from patch
              const lines = input.split('\n');
              const oldLines = [];
              const newLines = [];

              for (const line of lines) {
                if (line.startsWith('-') && !line.startsWith('---')) {
                  oldLines.push(line.substring(1));
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                  newLines.push(line.substring(1));
                }
              }

              messages.push({
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName: 'Edit',
                toolInput: JSON.stringify({
                  file_path: filePath,
                  old_string: oldLines.join('\n'),
                  new_string: newLines.join('\n')
                }),
                toolCallId: entry.payload.call_id
              });
            } else {
              messages.push({
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName: toolName,
                toolInput: input,
                toolCallId: entry.payload.call_id
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
            messages.push({
              type: 'tool_result',
              timestamp: entry.timestamp,
              toolCallId: entry.payload.call_id,
              output: entry.payload.output || ''
            });
          }

        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

    const total = messages.length;

    // Apply pagination if limit is specified
    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      const paginatedMessages = messages.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage
      };
    }

    return { messages, tokenUsage };

  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

async function deleteCodexSession(sessionId) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    const findJsonlFiles = async (dir) => {
      const files = [];
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await findJsonlFiles(fullPath));
          } else if (entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
          }
        }
      } catch (error) { }
      return files;
    };

    const jsonlFiles = await findJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      const sessionData = await parseCodexSessionFile(filePath);
      if (sessionData && sessionData.id === sessionId) {
        await fs.unlink(filePath);
        return true;
      }
    }

    throw new Error(`Codex session file not found for session ${sessionId}`);
  } catch (error) {
    console.error(`Error deleting Codex session ${sessionId}:`, error);
    throw error;
  }
}

async function searchConversations(query, limit = 50, onProjectResult = null, signal = null) {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const config = await loadProjectConfig();
  const results = [];
  let totalMatches = 0;
  const words = safeQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return { results: [], totalMatches: 0, query: safeQuery };

  const isAborted = () => signal?.aborted === true;

  const isSystemMessage = (textContent) => {
    return typeof textContent === 'string' && (
      textContent.startsWith('<command-name>') ||
      textContent.startsWith('<command-message>') ||
      textContent.startsWith('<command-args>') ||
      textContent.startsWith('<local-command-stdout>') ||
      textContent.startsWith('<system-reminder>') ||
      textContent.startsWith('Caveat:') ||
      textContent.startsWith('This session is being continued from a previous') ||
      textContent.startsWith('Invalid API key') ||
      textContent.includes('{"subtasks":') ||
      textContent.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
      textContent === 'Warmup'
    );
  };

  const extractText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join(' ');
    }
    return '';
  };

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordPatterns = words.map(w => new RegExp(`(?<!\\p{L})${escapeRegex(w)}(?!\\p{L})`, 'u'));
  const allWordsMatch = (textLower) => {
    return wordPatterns.every(p => p.test(textLower));
  };

  const buildSnippet = (text, textLower, snippetLen = 150) => {
    let firstIndex = -1;
    let firstWordLen = 0;
    for (const w of words) {
      const re = new RegExp(`(?<!\\p{L})${escapeRegex(w)}(?!\\p{L})`, 'u');
      const m = re.exec(textLower);
      if (m && (firstIndex === -1 || m.index < firstIndex)) {
        firstIndex = m.index;
        firstWordLen = w.length;
      }
    }
    if (firstIndex === -1) firstIndex = 0;
    const halfLen = Math.floor(snippetLen / 2);
    let start = Math.max(0, firstIndex - halfLen);
    let end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    let snippet = text.slice(start, end).replace(/\n/g, ' ');
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    snippet = prefix + snippet + suffix;
    const snippetLower = snippet.toLowerCase();
    const highlights = [];
    for (const word of words) {
      const re = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
      let match;
      while ((match = re.exec(snippetLower)) !== null) {
        highlights.push({ start: match.index, end: match.index + word.length });
      }
    }
    highlights.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const h of highlights) {
      const last = merged[merged.length - 1];
      if (last && h.start <= last.end) {
        last.end = Math.max(last.end, h.end);
      } else {
        merged.push({ ...h });
      }
    }
    return { snippet, highlights: merged };
  };

  try {
    await fs.access(claudeDir);
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    const projectDirs = entries.filter(e => e.isDirectory());
    let scannedProjects = 0;
    const totalProjects = projectDirs.length;

    for (const projectEntry of projectDirs) {
      if (totalMatches >= safeLimit || isAborted()) break;

      const projectName = projectEntry.name;
      const projectDir = path.join(claudeDir, projectName);
      const displayName = config[projectName]?.displayName
        || await generateDisplayName(projectName);

      let files;
      try {
        files = await fs.readdir(projectDir);
      } catch {
        continue;
      }

      const jsonlFiles = files.filter(
        file => file.endsWith('.jsonl') && !file.startsWith('agent-')
      );

      const projectResult = {
        projectName,
        projectDisplayName: displayName,
        sessions: []
      };

      for (const file of jsonlFiles) {
        if (totalMatches >= safeLimit || isAborted()) break;

        const filePath = path.join(projectDir, file);
        const sessionMatches = new Map();
        const sessionSummaries = new Map();
        const pendingSummaries = new Map();
        const sessionLastMessages = new Map();
        let currentSessionId = null;

        try {
          const fileStream = fsSync.createReadStream(filePath);
          const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
          });

          for await (const line of rl) {
            if (totalMatches >= safeLimit || isAborted()) break;
            if (!line.trim()) continue;

            let entry;
            try {
              entry = JSON.parse(line);
            } catch {
              continue;
            }

            if (entry.sessionId) {
              currentSessionId = entry.sessionId;
            }
            if (entry.type === 'summary' && entry.summary) {
              const sid = entry.sessionId || currentSessionId;
              if (sid) {
                sessionSummaries.set(sid, entry.summary);
              } else if (entry.leafUuid) {
                pendingSummaries.set(entry.leafUuid, entry.summary);
              }
            }

            // Apply pending summary via parentUuid
            if (entry.parentUuid && currentSessionId && !sessionSummaries.has(currentSessionId)) {
              const pending = pendingSummaries.get(entry.parentUuid);
              if (pending) sessionSummaries.set(currentSessionId, pending);
            }

            // Track last user/assistant message for fallback title
            if (entry.message?.content && currentSessionId && !entry.isApiErrorMessage) {
              const role = entry.message.role;
              if (role === 'user' || role === 'assistant') {
                const text = extractText(entry.message.content);
                if (text && !isSystemMessage(text)) {
                  if (!sessionLastMessages.has(currentSessionId)) {
                    sessionLastMessages.set(currentSessionId, {});
                  }
                  const msgs = sessionLastMessages.get(currentSessionId);
                  if (role === 'user') msgs.user = text;
                  else msgs.assistant = text;
                }
              }
            }

            if (!entry.message?.content) continue;
            if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue;
            if (entry.isApiErrorMessage) continue;

            const text = extractText(entry.message.content);
            if (!text || isSystemMessage(text)) continue;

            const textLower = text.toLowerCase();
            if (!allWordsMatch(textLower)) continue;

            const sessionId = entry.sessionId || currentSessionId || file.replace('.jsonl', '');
            if (!sessionMatches.has(sessionId)) {
              sessionMatches.set(sessionId, []);
            }

            const matches = sessionMatches.get(sessionId);
            if (matches.length < 2) {
              const { snippet, highlights } = buildSnippet(text, textLower);
              matches.push({
                role: entry.message.role,
                snippet,
                highlights,
                timestamp: entry.timestamp || null,
                provider: 'claude',
                messageUuid: entry.uuid || null
              });
              totalMatches++;
            }
          }
        } catch {
          continue;
        }

        for (const [sessionId, matches] of sessionMatches) {
          projectResult.sessions.push({
            sessionId,
            provider: 'claude',
            sessionSummary: sessionSummaries.get(sessionId) || (() => {
              const msgs = sessionLastMessages.get(sessionId);
              const lastMsg = msgs?.user || msgs?.assistant;
              return lastMsg ? (lastMsg.length > 50 ? lastMsg.substring(0, 50) + '...' : lastMsg) : 'New Session';
            })(),
            matches
          });
        }
      }

      // Search Codex sessions for this project
      try {
        const actualProjectDir = await extractProjectDirectory(projectName);
        if (actualProjectDir && !isAborted() && totalMatches < safeLimit) {
          await searchCodexSessionsForProject(
            actualProjectDir, projectResult, words, allWordsMatch, extractText, isSystemMessage,
            buildSnippet, safeLimit, () => totalMatches, (n) => { totalMatches += n; }, isAborted
          );
        }
      } catch {
        // Skip codex search errors
      }

      // Search Gemini sessions for this project
      try {
        const actualProjectDir = await extractProjectDirectory(projectName);
        if (actualProjectDir && !isAborted() && totalMatches < safeLimit) {
          await searchGeminiSessionsForProject(
            actualProjectDir, projectResult, words, allWordsMatch,
            buildSnippet, safeLimit, () => totalMatches, (n) => { totalMatches += n; }
          );
        }
      } catch {
        // Skip gemini search errors
      }

      scannedProjects++;
      if (projectResult.sessions.length > 0) {
        results.push(projectResult);
        if (onProjectResult) {
          onProjectResult({ projectResult, totalMatches, scannedProjects, totalProjects });
        }
      } else if (onProjectResult && scannedProjects % 10 === 0) {
        onProjectResult({ projectResult: null, totalMatches, scannedProjects, totalProjects });
      }
    }
  } catch {
    // claudeDir doesn't exist
  }

  return { results, totalMatches, query: safeQuery };
}

async function searchCodexSessionsForProject(
  projectPath, projectResult, words, allWordsMatch, extractText, isSystemMessage,
  buildSnippet, limit, getTotalMatches, addMatches, isAborted
) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return;
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  try {
    await fs.access(codexSessionsDir);
  } catch {
    return;
  }

  const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);

  for (const filePath of jsonlFiles) {
    if (getTotalMatches() >= limit || isAborted()) break;

    try {
      const fileStream = fsSync.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      // First pass: read session_meta to check project path match
      let sessionMeta = null;
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session_meta' && entry.payload) {
            sessionMeta = entry.payload;
            break;
          }
        } catch { continue; }
      }

      // Skip sessions that don't belong to this project
      if (!sessionMeta) continue;
      const sessionProjectPath = normalizeComparablePath(sessionMeta.cwd);
      if (sessionProjectPath !== normalizedProjectPath) continue;

      // Second pass: re-read file to find matching messages
      const fileStream2 = fsSync.createReadStream(filePath);
      const rl2 = readline.createInterface({ input: fileStream2, crlfDelay: Infinity });
      let lastUserMessage = null;
      const matches = [];

      for await (const line of rl2) {
        if (getTotalMatches() >= limit || isAborted()) break;
        if (!line.trim()) continue;

        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        let text = null;
        let role = null;

        if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && entry.payload.message) {
          text = entry.payload.message;
          role = 'user';
          lastUserMessage = text;
        } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
          const contentParts = entry.payload.content || [];
          if (entry.payload.role === 'user') {
            text = contentParts
              .filter(p => p.type === 'input_text' && p.text)
              .map(p => p.text)
              .join(' ');
            role = 'user';
            if (text) lastUserMessage = text;
          } else if (entry.payload.role === 'assistant') {
            text = contentParts
              .filter(p => p.type === 'output_text' && p.text)
              .map(p => p.text)
              .join(' ');
            role = 'assistant';
          }
        }

        if (!text || !role) continue;
        const textLower = text.toLowerCase();
        if (!allWordsMatch(textLower)) continue;

        if (matches.length < 2) {
          const { snippet, highlights } = buildSnippet(text, textLower);
          matches.push({ role, snippet, highlights, timestamp: entry.timestamp || null, provider: 'codex' });
          addMatches(1);
        }
      }

      if (matches.length > 0) {
        projectResult.sessions.push({
          sessionId: sessionMeta.id,
          provider: 'codex',
          sessionSummary: lastUserMessage
            ? (lastUserMessage.length > 50 ? lastUserMessage.substring(0, 50) + '...' : lastUserMessage)
            : 'Codex Session',
          matches
        });
      }
    } catch {
      continue;
    }
  }
}

async function searchGeminiSessionsForProject(
  projectPath, projectResult, words, allWordsMatch,
  buildSnippet, limit, getTotalMatches, addMatches
) {
  // 1) Search in-memory sessions (created via UI)
  for (const [sessionId, session] of sessionManager.sessions) {
    if (getTotalMatches() >= limit) break;
    if (session.projectPath !== projectPath) continue;

    const matches = [];
    for (const msg of session.messages) {
      if (getTotalMatches() >= limit) break;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : '';
      if (!text) continue;

      const textLower = text.toLowerCase();
      if (!allWordsMatch(textLower)) continue;

      if (matches.length < 2) {
        const { snippet, highlights } = buildSnippet(text, textLower);
        matches.push({
          role: msg.role, snippet, highlights,
          timestamp: msg.timestamp ? msg.timestamp.toISOString() : null,
          provider: 'gemini'
        });
        addMatches(1);
      }
    }

    if (matches.length > 0) {
      const firstUserMsg = session.messages.find(m => m.role === 'user');
      const summary = firstUserMsg?.content
        ? (typeof firstUserMsg.content === 'string'
          ? (firstUserMsg.content.length > 50 ? firstUserMsg.content.substring(0, 50) + '...' : firstUserMsg.content)
          : 'Gemini Session')
        : 'Gemini Session';

      projectResult.sessions.push({
        sessionId,
        provider: 'gemini',
        sessionSummary: summary,
        matches
      });
    }
  }

  // 2) Search Gemini CLI sessions on disk (~/.gemini/tmp/<project>/chats/*.json)
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return;

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  try {
    await fs.access(geminiTmpDir);
  } catch {
    return;
  }

  const trackedSessionIds = new Set();
  for (const [sid] of sessionManager.sessions) {
    trackedSessionIds.add(sid);
  }

  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    if (getTotalMatches() >= limit) break;

    const projectRootFile = path.join(geminiTmpDir, projectDir, '.project_root');
    let projectRoot;
    try {
      projectRoot = (await fs.readFile(projectRootFile, 'utf8')).trim();
    } catch {
      continue;
    }

    if (normalizeComparablePath(projectRoot) !== normalizedProjectPath) continue;

    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (getTotalMatches() >= limit) break;
      if (!chatFile.endsWith('.json')) continue;

      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        if (!session.messages || !Array.isArray(session.messages)) continue;

        const cliSessionId = session.sessionId || chatFile.replace('.json', '');
        if (trackedSessionIds.has(cliSessionId)) continue;

        const matches = [];
        let firstUserText = null;

        for (const msg of session.messages) {
          if (getTotalMatches() >= limit) break;

          const role = msg.type === 'user' ? 'user'
            : (msg.type === 'gemini' || msg.type === 'assistant') ? 'assistant'
            : null;
          if (!role) continue;

          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(p => p.text)
              .map(p => p.text)
              .join(' ');
          }
          if (!text) continue;

          if (role === 'user' && !firstUserText) firstUserText = text;

          const textLower = text.toLowerCase();
          if (!allWordsMatch(textLower)) continue;

          if (matches.length < 2) {
            const { snippet, highlights } = buildSnippet(text, textLower);
            matches.push({
              role, snippet, highlights,
              timestamp: msg.timestamp || null,
              provider: 'gemini'
            });
            addMatches(1);
          }
        }

        if (matches.length > 0) {
          const summary = firstUserText
            ? (firstUserText.length > 50 ? firstUserText.substring(0, 50) + '...' : firstUserText)
            : 'Gemini CLI Session';

          projectResult.sessions.push({
            sessionId: cliSessionId,
            provider: 'gemini',
            sessionSummary: summary,
            matches
          });
        }
      } catch {
        continue;
      }
    }
  }
}

async function getGeminiProjectSessions(projectPath) {
  const uiSessions = sessionManager.getProjectSessions(projectPath) || [];
  const cliSessions = await getGeminiCliSessions(projectPath);
  const mergedSessions = [];
  const seenSessionIds = new Set();

  for (const session of [...uiSessions, ...cliSessions]) {
    if (seenSessionIds.has(session.id)) {
      continue;
    }

    seenSessionIds.add(session.id);
    mergedSessions.push(session);
  }

  return sortSessionsByLastActivity(mergedSessions);
}

async function getGeminiSessionsPage(projectPath, options = {}) {
  const { limit = SESSION_PAGE_SIZE, offset = 0 } = options;

  try {
    const sessions = await getGeminiProjectSessions(projectPath);
    return paginateSessions(sessions, limit, offset);
  } catch (error) {
    console.error('Error fetching Gemini sessions:', error);
    return { sessions: [], hasMore: false, total: 0, offset, limit };
  }
}

async function getProjectSessionsPage({
  projectName,
  projectPath = '',
  provider = 'claude',
  limit = SESSION_PAGE_SIZE,
  offset = 0,
} = {}) {
  const normalizedProvider = typeof provider === 'string' ? provider.toLowerCase() : 'claude';

  if (isE2BProjectName(projectName)) {
    const sandboxId = extractSandboxIdFromProjectName(projectName);

    if (!sandboxId) {
      return { sessions: [], hasMore: false, total: 0, offset, limit };
    }

    let sessions = sortSessionsByLastActivity(
      e2bSessionDb.getBySandbox(sandboxId).map(normalizeE2BSessionRecord),
    );

    if (normalizedProvider && normalizedProvider !== 'all') {
      sessions = sessions.filter(
        (session) => resolveE2BAgentProvider(session.agent || session.provider) === normalizedProvider,
      );
    }

    applyCustomSessionNames(sessions, 'e2b');
    return paginateSessions(sessions, limit, offset);
  }

  if (normalizedProvider === 'claude') {
    const result = await getSessions(projectName, limit, offset);
    applyCustomSessionNames(result.sessions || [], 'claude');
    return result;
  }

  if (!projectPath) {
    return { sessions: [], hasMore: false, total: 0, offset, limit };
  }

  if (normalizedProvider === 'cursor') {
    const result = await getCursorSessionsPage(projectPath, { limit, offset });
    applyCustomSessionNames(result.sessions || [], 'cursor');
    return result;
  }

  if (normalizedProvider === 'codex') {
    const result = await getCodexSessionsPage(projectPath, { limit, offset });
    applyCustomSessionNames(result.sessions || [], 'codex');
    return result;
  }

  if (normalizedProvider === 'gemini') {
    const result = await getGeminiSessionsPage(projectPath, { limit, offset });
    applyCustomSessionNames(result.sessions || [], 'gemini');
    return result;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function getGeminiCliSessions(projectPath) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return [];

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  try {
    await fs.access(geminiTmpDir);
  } catch {
    return [];
  }

  const sessions = [];
  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectRootFile = path.join(geminiTmpDir, projectDir, '.project_root');
    let projectRoot;
    try {
      projectRoot = (await fs.readFile(projectRootFile, 'utf8')).trim();
    } catch {
      continue;
    }

    if (normalizeComparablePath(projectRoot) !== normalizedProjectPath) continue;

    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) continue;
      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        if (!session.messages || !Array.isArray(session.messages)) continue;

        const sessionId = session.sessionId || chatFile.replace('.json', '');
        const firstUserMsg = session.messages.find(m => m.type === 'user');
        let summary = 'Gemini CLI Session';
        if (firstUserMsg) {
          const text = Array.isArray(firstUserMsg.content)
            ? firstUserMsg.content.filter(p => p.text).map(p => p.text).join(' ')
            : (typeof firstUserMsg.content === 'string' ? firstUserMsg.content : '');
          if (text) {
            summary = text.length > 50 ? text.substring(0, 50) + '...' : text;
          }
        }

        sessions.push({
          id: sessionId,
          summary,
          messageCount: session.messages.length,
          lastActivity: session.lastUpdated || session.startTime || null,
          provider: 'gemini'
        });
      } catch {
        continue;
      }
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
  );
}

async function getGeminiCliSessionMessages(sessionId) {
  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) continue;
      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        const fileSessionId = session.sessionId || chatFile.replace('.json', '');
        if (fileSessionId !== sessionId) continue;

        return (session.messages || []).map(msg => {
          const role = msg.type === 'user' ? 'user'
            : (msg.type === 'gemini' || msg.type === 'assistant') ? 'assistant'
            : msg.type;

          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content.filter(p => p.text).map(p => p.text).join('\n');
          }

          return {
            type: 'message',
            message: { role, content },
            timestamp: msg.timestamp || null
          };
        });
      } catch {
        continue;
      }
    }
  }

  return [];
}

export {
  getProjects,
  getSessionBootstrap,
  getProjectSessionsPage,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  getCodexSessions,
  getCodexSessionMessages,
  deleteCodexSession,
  getGeminiCliSessions,
  getGeminiCliSessionMessages,
  searchConversations
};
