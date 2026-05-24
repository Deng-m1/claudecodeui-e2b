import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { remoteHostsDb, remoteHostSessionsDb, remoteWorkspacesDb } from '../../database/db.js';
import { remoteAgentRequest } from './agent-client.js';
import { extractRemoteWorkspaceIdFromProjectName } from './project-utils.js';
import { createNormalizedMessage } from '../types.js';

const SSH_CONNECT_TIMEOUT_SECONDS = 8;
const SSH_TIMEOUT_MS = 30000;
const REMOTE_DISCOVERY_TIMEOUT_MS = 30000;
const REMOTE_HISTORY_TIMEOUT_MS = 60000;
const REMOTE_PROCESS_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const REMOTE_DISCOVERY_TTL_MS = 5000;
const remoteDiscoveryCache = new Map();

const REMOTE_SESSION_DISCOVERY_PY = String.raw`
import json, os, sys

payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
workspace_roots = payload.get("workspaceRoots") or []

def norm_path(value):
    text = str(value or "").strip()
    if not text:
        return ""
    expanded = os.path.expanduser(text)
    if os.path.exists(expanded):
        return os.path.realpath(expanded)
    return os.path.abspath(expanded)

def clip(text, limit=80):
    value = str(text or "").strip().replace("\n", " ")
    if not value:
        return ""
    return value if len(value) <= limit else value[: limit - 3] + "..."

def json_dumps(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def extract_claude_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = str(item.get("text") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""

def extract_codex_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") in ("input_text", "output_text", "text"):
                text = str(item.get("text") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""

workspace_set = set()
for root in workspace_roots:
    normalized = norm_path(root)
    if normalized:
        workspace_set.add(normalized)

sessions = []

claude_root = os.path.expanduser("~/.claude/projects")
if os.path.isdir(claude_root):
    for dirpath, _, filenames in os.walk(claude_root):
        for filename in filenames:
            if not filename.endswith(".jsonl") or filename.startswith("agent-"):
                continue
            file_path = os.path.join(dirpath, filename)
            session_id = filename[:-6]
            cwd = ""
            summary = ""
            last_activity = ""
            message_count = 0
            last_text = ""

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except Exception:
                            continue

                        timestamp = str(entry.get("timestamp") or "").strip()
                        if timestamp and timestamp > last_activity:
                            last_activity = timestamp

                        current_cwd = str(entry.get("cwd") or "").strip()
                        if current_cwd:
                            cwd = current_cwd

                        if entry.get("type") == "summary" and entry.get("summary"):
                            summary = str(entry.get("summary") or "").strip()

                        if entry.get("isApiErrorMessage") is True:
                            continue

                        message = entry.get("message") or {}
                        role = message.get("role")
                        if role not in ("user", "assistant"):
                            continue

                        text = extract_claude_text(message.get("content"))
                        if not text:
                            continue

                        message_count += 1
                        last_text = text
            except Exception:
                continue

            normalized_cwd = norm_path(cwd)
            if not normalized_cwd or normalized_cwd not in workspace_set:
                continue

            if not summary:
                summary = clip(last_text, 50) or "New Session"

            sessions.append({
                "provider": "claude",
                "id": session_id,
                "cwd": normalized_cwd,
                "summary": summary,
                "messageCount": message_count,
                "lastActivity": last_activity,
                "createdAt": last_activity,
                "model": None,
                "status": "completed",
            })

codex_root = os.path.expanduser("~/.codex/sessions")
if os.path.isdir(codex_root):
    for dirpath, _, filenames in os.walk(codex_root):
        for filename in filenames:
            if not filename.endswith(".jsonl"):
                continue
            file_path = os.path.join(dirpath, filename)
            session_id = ""
            cwd = ""
            summary = ""
            last_activity = ""
            message_count = 0
            first_user_text = ""
            model = None

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except Exception:
                            continue

                        timestamp = str(entry.get("timestamp") or "").strip()
                        if timestamp and timestamp > last_activity:
                            last_activity = timestamp

                        if entry.get("type") == "session_meta" and isinstance(entry.get("payload"), dict):
                            payload = entry["payload"]
                            session_id = str(payload.get("id") or session_id).strip()
                            cwd = str(payload.get("cwd") or cwd).strip()
                            model = payload.get("model") or payload.get("model_provider") or model
                            if not summary:
                                summary = str(payload.get("title") or "").strip()
                            continue

                        if entry.get("type") == "event_msg" and isinstance(entry.get("payload"), dict):
                            payload = entry["payload"]
                            if payload.get("type") == "user_message" and payload.get("kind", "plain") == "plain":
                                text = str(payload.get("message") or "").strip()
                                if text:
                                    message_count += 1
                                    if not first_user_text:
                                        first_user_text = text
                            continue

                        if entry.get("type") == "response_item" and isinstance(entry.get("payload"), dict):
                            payload = entry["payload"]
                            if payload.get("type") == "message" and payload.get("role") == "assistant":
                                text = extract_codex_text(payload.get("content"))
                                if text:
                                    message_count += 1
                            continue
            except Exception:
                continue

            normalized_cwd = norm_path(cwd)
            if not normalized_cwd or normalized_cwd not in workspace_set:
                continue

            if not session_id:
                session_id = filename[:-6].split("-")[-1]

            if not summary:
                summary = clip(first_user_text, 50) or "Codex Session"

            sessions.append({
                "provider": "codex",
                "id": session_id,
                "cwd": normalized_cwd,
                "summary": summary,
                "messageCount": message_count,
                "lastActivity": last_activity,
                "createdAt": last_activity,
                "model": model,
                "status": "completed",
            })

sessions.sort(key=lambda item: item.get("lastActivity") or "", reverse=True)
json_dumps({"sessions": sessions})
`;

const REMOTE_SESSION_HISTORY_PY = String.raw`
import json, os, sys

payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
provider = str(payload.get("provider") or "").strip().lower()
session_id = str(payload.get("sessionId") or "").strip()

def json_dumps(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def extract_text_parts(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in ("text", "input_text", "output_text"):
                text = str(item.get("text") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""

def stringify_value(value):
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def find_file(root, matcher):
    if not os.path.isdir(root):
        return ""
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if matcher(filename):
                return os.path.join(dirpath, filename)
    return ""

messages = []
token_usage = None
fingerprint_last = ""

if provider == "codex":
    file_path = find_file(
        os.path.expanduser("~/.codex/sessions"),
        lambda filename: filename == session_id + ".jsonl" or filename.endswith("-" + session_id + ".jsonl"),
    )
    if file_path:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue

                timestamp = str(entry.get("timestamp") or "").strip() or None
                if timestamp:
                    fingerprint_last = timestamp

                if entry.get("type") == "event_msg" and isinstance(entry.get("payload"), dict):
                    payload = entry["payload"]
                    if payload.get("type") == "token_count" and isinstance(payload.get("info"), dict):
                        info = payload["info"]
                        total_usage = info.get("total_token_usage") or {}
                        if total_usage:
                            token_usage = {
                                "used": total_usage.get("total_tokens") or 0,
                                "total": info.get("model_context_window") or 200000,
                            }
                    if payload.get("type") == "user_message" and payload.get("kind", "plain") == "plain":
                        text = str(payload.get("message") or "").strip()
                        if text:
                            messages.append({
                                "timestamp": timestamp,
                                "kind": "text",
                                "role": "user",
                                "content": text,
                            })
                    continue

                if entry.get("type") != "response_item" or not isinstance(entry.get("payload"), dict):
                    continue

                payload = entry["payload"]
                payload_type = payload.get("type")

                if payload_type == "message" and payload.get("role") == "assistant":
                    text = extract_text_parts(payload.get("content"))
                    if text:
                        messages.append({
                            "timestamp": timestamp,
                            "kind": "text",
                            "role": "assistant",
                            "content": text,
                        })
                    continue

                if payload_type == "reasoning":
                    summary = payload.get("summary") or []
                    text = "\n".join(
                        str(item.get("text") or "").strip()
                        for item in summary
                        if isinstance(item, dict) and str(item.get("text") or "").strip()
                    ).strip()
                    if text:
                        messages.append({
                            "timestamp": timestamp,
                            "kind": "thinking",
                            "content": text,
                        })
                    continue

                if payload_type == "function_call":
                    tool_name = str(payload.get("name") or "Unknown").strip() or "Unknown"
                    tool_input = payload.get("arguments")
                    lower_name = tool_name.lower()
                    if lower_name in ("shell_command", "exec_command") or lower_name.endswith(".exec_command"):
                        tool_name = "Bash"
                        try:
                            parsed = json.loads(payload.get("arguments") or "{}")
                        except Exception:
                            parsed = {"command": str(payload.get("arguments") or "").strip()}
                        if isinstance(parsed, dict):
                            command = str(parsed.get("command") or parsed.get("cmd") or "").strip()
                            parsed["command"] = command
                        tool_input = parsed
                    messages.append({
                        "timestamp": timestamp,
                        "kind": "tool_use",
                        "toolName": tool_name,
                        "toolInput": tool_input,
                        "toolId": payload.get("call_id") or payload.get("id") or "",
                    })
                    continue

                if payload_type == "function_call_output":
                    messages.append({
                        "timestamp": timestamp,
                        "kind": "tool_result",
                        "toolId": payload.get("call_id") or "",
                        "content": stringify_value(payload.get("output")),
                        "isError": False,
                    })
                    continue

elif provider == "claude":
    file_path = find_file(
        os.path.expanduser("~/.claude/projects"),
        lambda filename: filename == session_id + ".jsonl" and not filename.startswith("agent-"),
    )
    if file_path:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue

                if entry.get("isApiErrorMessage") is True:
                    continue

                timestamp = str(entry.get("timestamp") or "").strip() or None
                if timestamp:
                    fingerprint_last = timestamp

                message = entry.get("message") or {}
                role = message.get("role")
                content = message.get("content")

                if role == "user":
                    if isinstance(content, list):
                        for part in content:
                            if not isinstance(part, dict):
                                continue
                            if part.get("type") == "text":
                                text = str(part.get("text") or "").strip()
                                if text:
                                    messages.append({
                                        "timestamp": timestamp,
                                        "kind": "text",
                                        "role": "user",
                                        "content": text,
                                    })
                            if part.get("type") == "tool_result":
                                messages.append({
                                    "timestamp": timestamp,
                                    "kind": "tool_result",
                                    "toolId": part.get("tool_use_id") or "",
                                    "content": stringify_value(part.get("content")),
                                    "isError": bool(part.get("is_error")),
                                })
                    elif isinstance(content, str) and content.strip():
                        messages.append({
                            "timestamp": timestamp,
                            "kind": "text",
                            "role": "user",
                            "content": content.strip(),
                        })
                    continue

                if role != "assistant":
                    continue

                if isinstance(content, list):
                    for part in content:
                        if not isinstance(part, dict):
                            continue
                        part_type = part.get("type")
                        if part_type == "text":
                            text = str(part.get("text") or "").strip()
                            if text:
                                messages.append({
                                    "timestamp": timestamp,
                                    "kind": "text",
                                    "role": "assistant",
                                    "content": text,
                                })
                        elif part_type in ("thinking", "redacted_thinking"):
                            text = str(part.get("thinking") or part.get("text") or "").strip()
                            if text:
                                messages.append({
                                    "timestamp": timestamp,
                                    "kind": "thinking",
                                    "content": text,
                                })
                        elif part_type == "tool_use":
                            messages.append({
                                "timestamp": timestamp,
                                "kind": "tool_use",
                                "toolName": str(part.get("name") or "Unknown").strip() or "Unknown",
                                "toolInput": part.get("input"),
                                "toolId": part.get("id") or "",
                            })
                elif isinstance(content, str) and content.strip():
                    messages.append({
                        "timestamp": timestamp,
                        "kind": "text",
                        "role": "assistant",
                        "content": content.strip(),
                    })

fingerprint = provider + ":" + session_id + ":" + str(len(messages)) + ":" + (fingerprint_last or "")
json_dumps({"messages": messages, "tokenUsage": token_usage, "fingerprint": fingerprint})
`;

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOptionalSecret(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function quotePosixShellArg(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeComparableRemotePath(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return '';
  }

  return path.posix.resolve(normalized);
}

function buildStoredSshNormalization(host, authMethod) {
  const normalizedHost = normalizeNonEmptyString(host?.host);
  const username = normalizeNonEmptyString(host?.username);
  const port = Number.parseInt(String(host?.port || 22), 10);

  if (!normalizedHost || !username || !Number.isFinite(port)) {
    throw new Error('Saved remote host is missing SSH connection metadata required for SSH fallback');
  }

  return {
    host: normalizedHost,
    port,
    username,
    authMethod,
  };
}

function runProcess(command, args, { env = {}, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env,
      },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const finish = (error, result = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }

      const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n') || `Command failed with exit code ${code}`;
      finish(new Error(message));
    });
  });
}

async function withTemporaryPrivateKey(privateKey, callback) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-native-key-'));
  const keyPath = path.join(tempDirectory, 'id_remote');

  try {
    const normalizedKey = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
    await fs.writeFile(keyPath, normalizedKey, { mode: 0o600 });
    return await callback(keyPath);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeSshCommand(rawPayload, normalized, remoteCommand, { timeoutMs = SSH_TIMEOUT_MS } = {}) {
  const password = normalizeOptionalSecret(rawPayload?.password);
  const privateKey = normalizeOptionalSecret(rawPayload?.privateKey);
  const sshBaseArgs = [
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-p', String(normalized.port),
  ];

  if (normalized.authMethod === 'password') {
    if (!password) {
      throw new Error('Saved password is not available for SSH fallback');
    }

    return runProcess(
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
      {
        env: {
          SSHPASS: password,
        },
        timeoutMs,
      },
    );
  }

  if (!privateKey) {
    throw new Error('Saved managed SSH key is not available for SSH fallback');
  }

  return withTemporaryPrivateKey(privateKey, async (keyPath) => {
    return runProcess(
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
      { timeoutMs },
    );
  });
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

  throw new Error('Remote command did not return valid JSON');
}

async function runRemotePythonJson(host, script, payload, { timeoutMs, maxOutputBytes } = {}) {
  const args = ['-c', script, JSON.stringify(payload || {})];
  const failures = [];

  if (normalizeNonEmptyString(host?.agent_url) && normalizeOptionalSecret(host?.agent_token)) {
    try {
      const response = await remoteAgentRequest(host, '/process/run', {
        command: 'python3',
        args,
        cwd: '/',
        timeoutMs,
        maxOutputBytes,
      }, {
        timeoutMs: (timeoutMs || SSH_TIMEOUT_MS) + 5000,
      });

      if (Number(response?.exitCode || 0) !== 0) {
        throw new Error([response?.stderr, response?.stdout].filter(Boolean).join('\n') || 'Remote agent command failed');
      }

      return extractJsonFromStdout(response?.stdout || '');
    } catch (error) {
      failures.push(`agent: ${error.message || 'unknown error'}`);
    }
  }

  const managedPrivateKey = normalizeOptionalSecret(host?.managed_ssh_private_key);
  if (managedPrivateKey) {
    try {
      const result = await executeSshCommand(
        { privateKey: managedPrivateKey },
        buildStoredSshNormalization(host, 'ssh_key'),
        `python3 -c ${quotePosixShellArg(script)} ${quotePosixShellArg(JSON.stringify(payload || {}))}`,
        { timeoutMs },
      );
      return extractJsonFromStdout(result.stdout || '');
    } catch (error) {
      failures.push(`managed SSH key: ${error.message || 'unknown error'}`);
    }
  }

  const savedPassword = normalizeOptionalSecret(host?.saved_ssh_password);
  if (savedPassword) {
    try {
      const result = await executeSshCommand(
        { password: savedPassword },
        buildStoredSshNormalization(host, 'password'),
        `python3 -c ${quotePosixShellArg(script)} ${quotePosixShellArg(JSON.stringify(payload || {}))}`,
        { timeoutMs },
      );
      return extractJsonFromStdout(result.stdout || '');
    } catch (error) {
      failures.push(`saved password: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(failures.length > 0 ? failures.join(' | ') : 'No remote session discovery transport is available');
}

function normalizeDiscoveredSession(rawSession = {}) {
  const provider = normalizeNonEmptyString(rawSession.provider);
  const id = normalizeNonEmptyString(rawSession.id);
  const cwd = normalizeNonEmptyString(rawSession.cwd);
  if (!provider || !id || !cwd) {
    return null;
  }

  const summary = normalizeNonEmptyString(rawSession.summary)
    || (provider === 'codex' ? 'Codex Session' : 'New Session');
  const lastActivity = normalizeNonEmptyString(rawSession.lastActivity) || new Date().toISOString();
  const createdAt = normalizeNonEmptyString(rawSession.createdAt) || lastActivity;

  return {
    id,
    summary,
    name: summary,
    title: summary,
    createdAt,
    created_at: createdAt,
    updated_at: lastActivity,
    lastActivity,
    messageCount: Number(rawSession.messageCount || 0),
    provider,
    model: normalizeNonEmptyString(rawSession.model) || null,
    status: normalizeNonEmptyString(rawSession.status) || 'completed',
    runtime: 'remote_host',
    cwd,
  };
}

function cloneDiscoveryMap(map) {
  return new Map(
    Array.from(map.entries(), ([workspaceId, sessions]) => [workspaceId, [...sessions]]),
  );
}

export async function discoverRemoteHostSessionsByWorkspace(host, workspaces = []) {
  if (!host?.id || !Array.isArray(workspaces) || workspaces.length === 0) {
    return new Map();
  }

  const normalizedWorkspaces = workspaces
    .map((workspace) => ({
      id: workspace.id,
      workspaceRoot: normalizeComparableRemotePath(workspace.workspace_root),
    }))
    .filter((workspace) => workspace.id && workspace.workspaceRoot);

  if (normalizedWorkspaces.length === 0) {
    return new Map();
  }

  const cacheKey = `${host.id}:${normalizedWorkspaces.map((workspace) => workspace.workspaceRoot).sort().join('|')}`;
  const cached = remoteDiscoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cloneDiscoveryMap(cached.value);
  }

  const rootToWorkspaceId = new Map(
    normalizedWorkspaces.map((workspace) => [workspace.workspaceRoot, workspace.id]),
  );
  const discovered = await runRemotePythonJson(
    host,
    REMOTE_SESSION_DISCOVERY_PY,
    {
      workspaceRoots: normalizedWorkspaces.map((workspace) => workspace.workspaceRoot),
    },
    {
      timeoutMs: REMOTE_DISCOVERY_TIMEOUT_MS,
      maxOutputBytes: REMOTE_PROCESS_MAX_OUTPUT_BYTES,
    },
  );

  const grouped = new Map(normalizedWorkspaces.map((workspace) => [workspace.id, []]));
  for (const rawSession of Array.isArray(discovered?.sessions) ? discovered.sessions : []) {
    const session = normalizeDiscoveredSession(rawSession);
    if (!session) {
      continue;
    }

    const workspaceId = rootToWorkspaceId.get(normalizeComparableRemotePath(session.cwd));
    if (!workspaceId) {
      continue;
    }

    grouped.get(workspaceId)?.push(session);
  }

  remoteDiscoveryCache.set(cacheKey, {
    expiresAt: Date.now() + REMOTE_DISCOVERY_TTL_MS,
    value: grouped,
  });

  return cloneDiscoveryMap(grouped);
}

function normalizeRemoteHistoryMessage(sessionId, provider, rawMessage = {}) {
  const kind = normalizeNonEmptyString(rawMessage.kind);
  if (!kind) {
    return null;
  }

  const normalized = createNormalizedMessage({
    ...rawMessage,
    kind,
    provider,
    sessionId,
    timestamp: normalizeNonEmptyString(rawMessage.timestamp) || new Date().toISOString(),
  });

  if (kind === 'text' && normalized.role !== 'user' && normalized.role !== 'assistant') {
    normalized.role = 'assistant';
  }

  return normalized;
}

function resolveRemoteHistoryTarget(sessionId, { projectName = '', userId = null } = {}) {
  const workspaceIdFromProject = extractRemoteWorkspaceIdFromProjectName(projectName);
  if (workspaceIdFromProject && userId) {
    const workspace = remoteWorkspacesDb.getById(userId, workspaceIdFromProject);
    const host = workspace ? remoteHostsDb.getById(userId, workspace.remote_host_id) : null;
    if (workspace && host) {
      return { workspace, host };
    }
  }

  const sessionRecord = remoteHostSessionsDb.getBySessionId(sessionId);
  if (!sessionRecord) {
    return null;
  }

  const effectiveUserId = userId || sessionRecord.user_id;
  const workspace = remoteWorkspacesDb.getById(effectiveUserId, sessionRecord.workspace_id);
  const host = workspace ? remoteHostsDb.getById(effectiveUserId, workspace.remote_host_id) : null;
  return workspace && host ? { workspace, host } : null;
}

export async function loadRemoteHostSessionHistorySnapshot(sessionId, {
  provider = 'claude',
  projectName = '',
  userId = null,
} = {}) {
  const normalizedProvider = normalizeNonEmptyString(provider).toLowerCase();
  if (!['claude', 'codex'].includes(normalizedProvider)) {
    return {
      messages: [],
      tokenUsage: null,
      fingerprint: `remote:${normalizedProvider}:${sessionId}:unsupported`,
    };
  }

  const target = resolveRemoteHistoryTarget(sessionId, { projectName, userId });
  if (!target) {
    return {
      messages: [],
      tokenUsage: null,
      fingerprint: `remote:${normalizedProvider}:${sessionId}:missing`,
    };
  }

  const payload = await runRemotePythonJson(
    target.host,
    REMOTE_SESSION_HISTORY_PY,
    {
      provider: normalizedProvider,
      sessionId,
      workspaceRoot: target.workspace.workspace_root,
    },
    {
      timeoutMs: REMOTE_HISTORY_TIMEOUT_MS,
      maxOutputBytes: REMOTE_PROCESS_MAX_OUTPUT_BYTES,
    },
  );

  const messages = (Array.isArray(payload?.messages) ? payload.messages : [])
    .map((message) => normalizeRemoteHistoryMessage(sessionId, normalizedProvider, message))
    .filter(Boolean);

  return {
    messages,
    tokenUsage: payload?.tokenUsage || null,
    fingerprint: normalizeNonEmptyString(payload?.fingerprint)
      || `remote:${normalizedProvider}:${sessionId}:${messages.length}`,
  };
}
