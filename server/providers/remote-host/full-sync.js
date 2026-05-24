import crypto from 'crypto';
import { spawn } from 'child_process';
import fs, { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import {
  remoteHostsDb,
  remoteHostSessionMessagesDb,
  remoteHostSessionsDb,
  remoteWorkspacesDb,
} from '../../database/db.js';
import { executeSshCommand, getSshCredentialPlans } from './transport.js';

const DEFAULT_SYNC_OUTPUT_ROOT = path.join(os.homedir(), '.claude-code-ui', 'remote-sync');
const SSH_CONNECT_TIMEOUT_SECONDS = 8;
const SSH_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HOME_SYNC_TARGETS = [
  '.claude',
  '.codex',
  '.gemini',
  '.cursor',
  '.claude-code-ui',
];
const DEFAULT_WORKSPACE_SYNC_TARGETS = [
  '.cloudcli-data',
  '.claude',
  '.codex',
  '.gemini',
  '.cursor',
  '.claude-code-ui',
];
const REMOTE_SYNC_INSPECT_PY = String.raw`
import json, os, re, sys

payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
workspace_roots = payload.get("workspaceRoots") or []
home_targets = payload.get("homeTargets") or []
workspace_targets = payload.get("workspaceTargets") or []
max_db_hits = int(payload.get("maxDbHits") or 250)
db_pattern = re.compile(r"\.(db|sqlite|sqlite3)$", re.I)
home_dir = os.path.expanduser("~")

seen = set()
candidates = []

def add_candidate(raw_path, source, workspace_root=None):
    normalized = os.path.normpath(str(raw_path or "").strip())
    if not normalized:
        return
    if normalized in seen:
        return
    seen.add(normalized)
    candidates.append({
        "path": normalized,
        "source": source,
        "workspaceRoot": workspace_root,
    })

for relative_target in home_targets:
    add_candidate(os.path.join(home_dir, str(relative_target or "").lstrip("/")), "home")

for workspace_root in workspace_roots:
    root = os.path.normpath(str(workspace_root or "").strip())
    if not root or not root.startswith("/"):
        continue
    for relative_target in workspace_targets:
        add_candidate(os.path.join(root, str(relative_target or "").lstrip("/")), "workspace", root)

paths = []
existing_paths = []
for candidate in candidates:
    entry_path = candidate["path"]
    exists = os.path.exists(entry_path)
    entry = {
        **candidate,
        "exists": exists,
        "isDirectory": False,
        "isFile": False,
        "isSymlink": False,
        "realPath": os.path.realpath(entry_path) if exists else None,
        "dbFiles": [],
        "dbFileCount": 0,
    }
    if exists:
        entry["isDirectory"] = os.path.isdir(entry_path)
        entry["isFile"] = os.path.isfile(entry_path)
        entry["isSymlink"] = os.path.islink(entry_path)
        existing_paths.append(entry_path)
        if entry["isDirectory"]:
            db_hits = []
            for root, _, files in os.walk(entry_path):
                for name in files:
                    if not db_pattern.search(name):
                        continue
                    db_hits.append(os.path.join(root, name))
                    if len(db_hits) >= max_db_hits:
                        break
                if len(db_hits) >= max_db_hits:
                    break
            entry["dbFiles"] = db_hits
            entry["dbFileCount"] = len(db_hits)
        elif entry["isFile"] and db_pattern.search(os.path.basename(entry_path)):
            entry["dbFiles"] = [entry_path]
            entry["dbFileCount"] = 1
    paths.append(entry)

print(json.dumps({
    "home": home_dir,
    "paths": paths,
    "existingPaths": existing_paths,
}, ensure_ascii=False))
`;
const REMOTE_SYNC_ARCHIVE_PY = String.raw`
import json, os, sys, tarfile

payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
paths = []
seen = set()
for raw_path in payload.get("paths") or []:
    normalized = os.path.normpath(str(raw_path or "").strip())
    if not normalized or normalized in seen or not os.path.exists(normalized):
        continue
    seen.add(normalized)
    paths.append(normalized)

with tarfile.open(fileobj=sys.stdout.buffer, mode="w:gz", dereference=False) as archive:
    for entry_path in paths:
        archive.add(entry_path, arcname=os.path.join("remote-root", entry_path.lstrip("/")), recursive=True)
`;

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeBooleanFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function quotePosixShellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeArtifactSegment(value, fallback = 'remote-host') {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return fallback;
  }

  return normalized
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || fallback;
}

function normalizeWorkspaceRoots(workspaceRoots = []) {
  const seen = new Set();
  const normalizedRoots = [];

  for (const value of workspaceRoots) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized || !normalized.startsWith('/')) {
      continue;
    }

    const posixPath = path.posix.normalize(normalized);
    if (seen.has(posixPath)) {
      continue;
    }

    seen.add(posixPath);
    normalizedRoots.push(posixPath);
  }

  return normalizedRoots;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    values
      .map((value) => normalizeNonEmptyString(value))
      .filter(Boolean),
  ));
}

function extractJsonFromStdout(stdout = '') {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON lines.
    }
  }

  throw new Error('Remote sync command did not return valid JSON');
}

function redactRemoteHostForPlatformExport(host, includeSecrets = false) {
  if (!host || typeof host !== 'object') {
    return null;
  }

  return {
    id: host.id,
    userId: host.user_id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    connectionMode: host.connection_mode,
    authMethod: host.auth_method,
    agentUrl: host.agent_url || null,
    agentToken: includeSecrets ? (host.agent_token || null) : null,
    managedSshPublicKey: includeSecrets ? (host.managed_ssh_public_key || null) : null,
    managedSshPrivateKey: includeSecrets ? (host.managed_ssh_private_key || null) : null,
    savedSshPassword: includeSecrets ? (host.saved_ssh_password || null) : null,
    status: host.status,
    lastError: host.last_error,
    lastTestedAt: host.last_tested_at,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    metadata: host.metadata || null,
    secretFlags: {
      hasAgentToken: Boolean(host.agent_token),
      hasManagedSshKey: Boolean(host.managed_ssh_private_key),
      hasSavedSshPassword: Boolean(host.saved_ssh_password),
    },
  };
}

function normalizeWorkspaceForPlatformExport(workspace) {
  if (!workspace || typeof workspace !== 'object') {
    return null;
  }

  return {
    id: workspace.id,
    remoteHostId: workspace.remote_host_id,
    displayName: workspace.display_name,
    workspaceRoot: workspace.workspace_root,
    status: workspace.status,
    metadata: workspace.metadata || null,
    createdAt: workspace.created_at,
    updatedAt: workspace.updated_at,
  };
}

function normalizeRemoteSessionForPlatformExport(session) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  return {
    id: session.id,
    remoteHostId: session.remote_host_id,
    workspaceId: session.workspace_id,
    sessionId: session.session_id,
    provider: session.provider,
    model: session.model,
    summary: session.summary,
    status: session.status,
    messageCount: session.message_count,
    metadata: session.metadata || null,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    lastActivity: session.last_activity,
  };
}

export function buildRemoteSyncPathCandidates({
  workspaceRoots = [],
  homeTargets = DEFAULT_HOME_SYNC_TARGETS,
  workspaceTargets = DEFAULT_WORKSPACE_SYNC_TARGETS,
} = {}) {
  return {
    workspaceRoots: normalizeWorkspaceRoots(workspaceRoots),
    homeTargets: uniqueStrings(homeTargets),
    workspaceTargets: uniqueStrings(workspaceTargets),
  };
}

export function buildRemoteHostPlatformSnapshot({
  host,
  workspaces = [],
  sessions = [],
  messagesBySession = {},
  includeSecrets = false,
} = {}) {
  return {
    generatedAt: new Date().toISOString(),
    host: redactRemoteHostForPlatformExport(host, includeSecrets),
    workspaces: workspaces
      .map((workspace) => normalizeWorkspaceForPlatformExport(workspace))
      .filter(Boolean),
    sessions: sessions
      .map((session) => normalizeRemoteSessionForPlatformExport(session))
      .filter(Boolean),
    messagesBySession: Object.fromEntries(
      Object.entries(messagesBySession || {})
        .map(([sessionId, messages]) => [
          sessionId,
          Array.isArray(messages)
            ? messages.map((message) => ({
              ...message,
            }))
            : [],
        ]),
    ),
  };
}

export async function inspectRemoteSyncTargetsOverSsh(host, options = {}) {
  const pathPlan = buildRemoteSyncPathCandidates({
    workspaceRoots: options.workspaceRoots,
    homeTargets: options.homeTargets,
    workspaceTargets: options.workspaceTargets,
  });
  const payload = {
    ...pathPlan,
    maxDbHits: Number.isFinite(options.maxDbHits) ? options.maxDbHits : 250,
  };
  const remoteCommand = `python3 -c ${quotePosixShellArg(REMOTE_SYNC_INSPECT_PY)} ${quotePosixShellArg(JSON.stringify(payload))}`;
  const failures = [];

  for (const plan of getSshCredentialPlans(host)) {
    try {
      const result = await executeSshCommand(plan.rawPayload, plan.normalized, remoteCommand, {
        timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : SSH_STREAM_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      return {
        ...extractJsonFromStdout(result.stdout || ''),
        via: plan.label,
        requested: payload,
      };
    } catch (error) {
      failures.push(`${plan.label}: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(
    failures.length > 0
      ? `Remote sync inspect failed across the SSH fallback chain: ${failures.join(' | ')}`
      : 'Remote host does not have any SSH credential available for sync export',
  );
}

async function withTemporaryPrivateKey(privateKey, callback) {
  const tempDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'remote-sync-key-'));
  const keyPath = path.join(tempDirectory, 'id_remote');

  try {
    const normalizedKey = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
    await fsPromises.writeFile(keyPath, normalizedKey, { mode: 0o600 });
    return await callback(keyPath);
  } finally {
    await fsPromises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function streamRemoteCommandToFile(rawPayload, normalized, remoteCommand, outputPath, { timeoutMs = SSH_STREAM_TIMEOUT_MS } = {}) {
  const password = normalizeNonEmptyString(rawPayload?.password) || null;
  const privateKey = normalizeNonEmptyString(rawPayload?.privateKey) || null;
  const sshBaseArgs = [
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'ServerAliveInterval=5',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-p', String(normalized.port),
  ];

  const runStream = (command, args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env,
      },
      shell: false,
    });
    const output = fs.createWriteStream(outputPath);
    const hash = crypto.createHash('sha256');
    let stderr = '';
    let bytesWritten = 0;
    let settled = false;

    const finalize = (error, result = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      output.end(() => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    };

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      finalize(new Error(`Remote sync archive download timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      hash.update(chunk);
      bytesWritten += chunk.length;
    });
    child.stdout.pipe(output, { end: false });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finalize(error);
    });
    output.on('error', (error) => {
      child.kill('SIGKILL');
      finalize(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finalize(null, {
          bytesWritten,
          checksumSha256: hash.digest('hex'),
        });
        return;
      }

      finalize(new Error(stderr.trim() || `Remote sync archive download failed with exit code ${code}`));
    });
  });

  if (password) {
    return runStream(
      'sshpass',
      [
        '-e',
        'ssh',
        ...sshBaseArgs,
        '-o', 'PreferredAuthentications=password',
        '-o', 'PubkeyAuthentication=no',
        `${normalized.username}@${normalized.host}`,
        remoteCommand,
      ],
      { SSHPASS: password },
    );
  }

  if (!privateKey) {
    throw new Error('Remote sync requires either a managed SSH key or a saved SSH password');
  }

  return withTemporaryPrivateKey(privateKey, (keyPath) => runStream(
    'ssh',
    [
      ...sshBaseArgs,
      '-i', keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      `${normalized.username}@${normalized.host}`,
      remoteCommand,
    ],
  ));
}

export async function downloadRemoteSyncArchiveOverSsh(host, existingPaths, archivePath, options = {}) {
  const normalizedPaths = normalizeWorkspaceRoots(existingPaths);
  if (normalizedPaths.length === 0) {
    return {
      archivePath: null,
      via: null,
      bytesWritten: 0,
      checksumSha256: null,
    };
  }

  const failures = [];
  const remoteCommand = `python3 -c ${quotePosixShellArg(REMOTE_SYNC_ARCHIVE_PY)} ${quotePosixShellArg(JSON.stringify({ paths: normalizedPaths }))}`;
  const partialArchivePath = `${archivePath}.partial`;

  await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
  await fsPromises.rm(partialArchivePath, { force: true }).catch(() => {});

  for (const plan of getSshCredentialPlans(host)) {
    try {
      const result = await streamRemoteCommandToFile(
        plan.rawPayload,
        plan.normalized,
        remoteCommand,
        partialArchivePath,
        { timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : SSH_STREAM_TIMEOUT_MS },
      );

      await fsPromises.rename(partialArchivePath, archivePath);
      return {
        archivePath,
        via: plan.label,
        ...result,
      };
    } catch (error) {
      failures.push(`${plan.label}: ${error.message || 'unknown error'}`);
      await fsPromises.rm(partialArchivePath, { force: true }).catch(() => {});
    }
  }

  throw new Error(
    failures.length > 0
      ? `Remote sync archive download failed across the SSH fallback chain: ${failures.join(' | ')}`
      : 'Remote host does not have any SSH credential available for sync archive download',
  );
}

export async function syncRemoteHostSnapshot(host, {
  workspaces = [],
  sessions = [],
  messagesBySession = {},
  workspaceRoots = null,
  homeTargets = undefined,
  workspaceTargets = undefined,
  maxDbHits = undefined,
  includePlatformSecrets = false,
  outputDir = null,
  inspectTargets = inspectRemoteSyncTargetsOverSsh,
  downloadArchive = downloadRemoteSyncArchiveOverSsh,
} = {}) {
  const requestedWorkspaceRoots = normalizeWorkspaceRoots(
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? workspaceRoots
      : workspaces.map((workspace) => workspace?.workspace_root),
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactRoot = outputDir
    ? path.resolve(outputDir)
    : path.join(
      DEFAULT_SYNC_OUTPUT_ROOT,
      sanitizeArtifactSegment(host?.label || host?.host, 'remote-host'),
      timestamp,
    );
  const inspectPath = path.join(artifactRoot, 'remote-inspect.json');
  const platformStatePath = path.join(artifactRoot, 'platform-state.json');
  const manifestPath = path.join(artifactRoot, 'manifest.json');
  const archivePath = path.join(artifactRoot, 'remote-state.tar.gz');

  await fsPromises.mkdir(artifactRoot, { recursive: true });

  const platformSnapshot = buildRemoteHostPlatformSnapshot({
    host,
    workspaces,
    sessions,
    messagesBySession,
    includeSecrets: includePlatformSecrets,
  });
  await fsPromises.writeFile(platformStatePath, JSON.stringify(platformSnapshot, null, 2));

  const inspectResult = await inspectTargets(host, {
    workspaceRoots: requestedWorkspaceRoots,
    homeTargets,
    workspaceTargets,
    maxDbHits,
  });
  await fsPromises.writeFile(inspectPath, JSON.stringify(inspectResult, null, 2));

  const archiveResult = await downloadArchive(
    host,
    Array.isArray(inspectResult?.existingPaths) ? inspectResult.existingPaths : [],
    archivePath,
  );

  const manifest = {
    generatedAt: new Date().toISOString(),
    artifactRoot,
    host: {
      id: host?.id || null,
      label: host?.label || null,
      host: host?.host || null,
      port: host?.port || null,
      username: host?.username || null,
    },
    workspaceRoots: requestedWorkspaceRoots,
    inspectPath,
    platformStatePath,
    archivePath: archiveResult.archivePath,
    archiveBytes: archiveResult.bytesWritten,
    archiveChecksumSha256: archiveResult.checksumSha256,
    syncTransport: {
      inspectVia: inspectResult.via || null,
      archiveVia: archiveResult.via || null,
    },
    existingPathCount: Array.isArray(inspectResult?.existingPaths) ? inspectResult.existingPaths.length : 0,
    containsSensitiveRemoteState: true,
    includesPlatformSecrets: includePlatformSecrets,
  };
  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    artifactRoot,
    manifestPath,
    inspectPath,
    platformStatePath,
    archivePath: archiveResult.archivePath,
    archiveBytes: archiveResult.bytesWritten,
    archiveChecksumSha256: archiveResult.checksumSha256,
    existingPathCount: manifest.existingPathCount,
    syncTransport: manifest.syncTransport,
  };
}

function resolveSavedRemoteHostIdentifier(userId, { hostId = null, label = null, host = null } = {}) {
  if (normalizeNonEmptyString(hostId)) {
    return remoteHostsDb.getById(userId, normalizeNonEmptyString(hostId));
  }

  const identifier = normalizeNonEmptyString(label) || normalizeNonEmptyString(host);
  if (!identifier) {
    throw new Error('Remote sync requires either a hostId, a label, or a host address');
  }

  const hosts = remoteHostsDb.getByUser(userId);
  const exactMatch = hosts.find((candidate) => (
    candidate.id === identifier
      || candidate.label === identifier
      || candidate.host === identifier
  ));

  if (!exactMatch) {
    return null;
  }

  return exactMatch;
}

export async function syncSavedRemoteHostSnapshot(userId, identifier = {}, options = {}) {
  const host = resolveSavedRemoteHostIdentifier(userId, identifier);
  if (!host) {
    throw new Error('Remote host not found');
  }

  const allWorkspaces = remoteWorkspacesDb.getByHost(userId, host.id);
  const requestedWorkspaceRoots = normalizeWorkspaceRoots(options.workspaceRoots || []);
  const workspaces = requestedWorkspaceRoots.length > 0
    ? allWorkspaces.filter((workspace) => requestedWorkspaceRoots.includes(path.posix.normalize(workspace.workspace_root)))
    : allWorkspaces;
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const sessions = remoteHostSessionsDb
    .getByUser(userId)
    .filter((session) => session.remote_host_id === host.id)
    .filter((session) => workspaceIds.size === 0 || workspaceIds.has(session.workspace_id));
  const messagesBySession = Object.fromEntries(
    sessions.map((session) => [
      session.session_id,
      remoteHostSessionMessagesDb.getBySessionId(session.session_id),
    ]),
  );

  return syncRemoteHostSnapshot(host, {
    workspaces,
    sessions,
    messagesBySession,
    workspaceRoots: requestedWorkspaceRoots.length > 0 ? requestedWorkspaceRoots : workspaces.map((workspace) => workspace.workspace_root),
    homeTargets: options.homeTargets,
    workspaceTargets: options.workspaceTargets,
    maxDbHits: options.maxDbHits,
    includePlatformSecrets: normalizeBooleanFlag(options.includePlatformSecrets),
    outputDir: options.outputDir,
  });
}
