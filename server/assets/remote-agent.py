#!/usr/bin/env python3
import argparse
import base64
import errno
import json
import os
import platform
import posixpath
import pty
import shlex
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

AGENT_VERSION = "0.2.1"
STARTED_AT = int(time.time())
MAX_TERMINAL_BUFFER_CHUNKS = 4000
TERMINAL_SESSIONS = {}
TERMINAL_SESSIONS_LOCK = threading.Lock()


def read_token(token_file):
    with open(token_file, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def run_command(args, timeout=5):
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return None

    output = (completed.stdout or "").strip() or (completed.stderr or "").strip()
    return output or None


def command_probe(command, version_args=None):
    command_path = shutil.which(command)
    version = None

    if command_path and version_args:
        version = run_command([command_path, *version_args])

    return {
        "available": bool(command_path),
        "path": command_path,
        "version": version,
    }


def expand_existing_paths(paths):
    existing = []
    for path in paths:
        expanded = os.path.expanduser(path)
        if os.path.exists(expanded):
            existing.append(expanded)
    return existing


def detect_provider(provider, command, auth_files, env_keys, version_args=None):
    probe = command_probe(command, version_args)
    auth_file_hits = expand_existing_paths(auth_files)
    env_hits = [key for key in env_keys if os.environ.get(key)]
    warnings = []

    if not probe["available"]:
        warnings.append(f"{command} is not installed")

    return {
        "provider": provider,
        "installed": probe["available"],
        "command": probe["path"] or command,
        "version": probe["version"],
        "authenticated": bool(auth_file_hits or env_hits),
        "authFiles": auth_file_hits,
        "envKeys": env_hits,
        "warnings": warnings,
    }


def build_provider_probe():
    return {
        "providers": [
            detect_provider(
                "claude",
                "claude",
                ["~/.claude/.credentials.json", "~/.claude/settings.json"],
                ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
                ["--version"],
            ),
            detect_provider(
                "codex",
                "codex",
                ["~/.codex/auth.json", "~/.codex/config.toml"],
                ["OPENAI_API_KEY", "CODEX_API_KEY", "CLIPROXY_API_KEY"],
                ["--version"],
            ),
            detect_provider(
                "gemini",
                "gemini",
                ["~/.gemini/oauth_creds.json", "~/.gemini/settings.json"],
                ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
                ["--version"],
            ),
            detect_provider(
                "cursor",
                "cursor-agent",
                ["~/.cursor/mcp.json", "~/.cursor/auth.json"],
                [],
                ["--version"],
            ),
        ]
    }


def build_system_probe():
    return {
        "hostname": socket.gethostname(),
        "user": run_command(["whoami"]) or os.environ.get("USER") or "unknown",
        "home": os.path.expanduser("~"),
        "shell": os.environ.get("SHELL"),
        "cwd": os.getcwd(),
        "system": platform.platform(),
        "python": sys.version.splitlines()[0],
        "commands": {
            "python3": command_probe("python3", ["--version"]),
            "git": command_probe("git", ["--version"]),
            "tmux": command_probe("tmux", ["-V"]),
            "claude": command_probe("claude", ["--version"]),
            "codex": command_probe("codex", ["--version"]),
        },
    }


def normalize_posix_path(value):
    raw_path = str(value or "").strip()
    if not raw_path:
        raise ValueError("path is required")

    normalized = posixpath.normpath(raw_path)
    if not normalized.startswith("/"):
        raise ValueError("path must be an absolute path")

    return normalized


def permissions_rwx(mode):
    def perm_to_rwx(perm):
        return (
            ("r" if perm & 4 else "-")
            + ("w" if perm & 2 else "-")
            + ("x" if perm & 1 else "-")
        )

    return (
        perm_to_rwx((mode >> 6) & 7)
        + perm_to_rwx((mode >> 3) & 7)
        + perm_to_rwx(mode & 7)
    )


def stat_entry(target_path):
    normalized_path = normalize_posix_path(target_path)
    entry_stat = os.stat(normalized_path)
    entry_type = "directory" if stat.S_ISDIR(entry_stat.st_mode) else "file"
    return {
        "path": normalized_path,
        "name": posixpath.basename(normalized_path) or normalized_path,
        "entryType": entry_type,
        "size": entry_stat.st_size,
        "modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(entry_stat.st_mtime)),
        "permissionsRwx": permissions_rwx(entry_stat.st_mode),
    }


def list_fs_entries(target_path):
    normalized_path = normalize_posix_path(target_path)
    if not os.path.exists(normalized_path):
        raise FileNotFoundError(f"{normalized_path} was not found")
    if not os.path.isdir(normalized_path):
        raise NotADirectoryError(f"{normalized_path} is not a directory")

    entries = []
    for name in sorted(os.listdir(normalized_path)):
        child_path = posixpath.join(normalized_path, name)
        entry = stat_entry(child_path)
        entry["name"] = name
        entries.append(entry)
    return entries


def read_fs_file(target_path, encoding):
    normalized_path = normalize_posix_path(target_path)
    with open(normalized_path, "rb") as handle:
        content = handle.read()

    if encoding == "base64":
        return base64.b64encode(content).decode("ascii")

    return content.decode("utf-8")


def write_fs_file(target_path, content, encoding, create_parent_directories=False, fail_if_exists=False):
    normalized_path = normalize_posix_path(target_path)
    parent_path = posixpath.dirname(normalized_path)
    if create_parent_directories:
        os.makedirs(parent_path, exist_ok=True)

    if fail_if_exists and os.path.exists(normalized_path):
        raise FileExistsError(f"{normalized_path} already exists")

    if encoding == "base64":
        payload = base64.b64decode(content or "")
    else:
        payload = (content or "").encode("utf-8")

    mode = "xb" if fail_if_exists else "wb"
    with open(normalized_path, mode) as handle:
        handle.write(payload)


def mkdir_fs(target_path, recursive=False):
    normalized_path = normalize_posix_path(target_path)
    if recursive:
        os.makedirs(normalized_path, exist_ok=True)
    else:
        os.mkdir(normalized_path)


def move_fs(from_path, to_path, overwrite=False):
    normalized_from = normalize_posix_path(from_path)
    normalized_to = normalize_posix_path(to_path)

    if not overwrite and os.path.exists(normalized_to):
        raise FileExistsError(f"{normalized_to} already exists")

    os.rename(normalized_from, normalized_to)


def delete_fs_entry(target_path, recursive=False):
    normalized_path = normalize_posix_path(target_path)

    if os.path.isdir(normalized_path):
        if recursive:
            shutil.rmtree(normalized_path)
        else:
            os.rmdir(normalized_path)
        return

    os.remove(normalized_path)


def truncate_output(value, max_bytes):
    if isinstance(value, bytes):
        encoded = value
    else:
        encoded = (value or "").encode("utf-8", errors="replace")

    if len(encoded) <= max_bytes:
        return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")

    return encoded[:max_bytes].decode("utf-8", errors="replace")


def run_process(payload):
    command = str(payload.get("command") or "").strip()
    if not command:
        raise ValueError("command is required")

    args = payload.get("args") or []
    if not isinstance(args, list):
        raise ValueError("args must be an array")

    cwd = normalize_posix_path(payload.get("cwd") or os.path.expanduser("~"))
    timeout_ms = int(payload.get("timeoutMs") or 120000)
    max_output_bytes = int(payload.get("maxOutputBytes") or 2000000)
    login_shell = bool(payload.get("loginShell"))
    use_shell = bool(payload.get("useShell")) or login_shell
    shell = str(payload.get("shell") or os.environ.get("SHELL") or "/bin/bash").strip() or "/bin/bash"
    env = {
        str(key): str(value)
        for key, value in (payload.get("env") or {}).items()
        if isinstance(key, str) and value is not None
    }
    child_env = os.environ.copy()
    child_env.update(env)
    command_args = [command, *[str(arg) for arg in args]]
    run_args = command_args

    if use_shell:
        shell_command = shlex.join(command_args)
        shell_flag = "-lc" if login_shell else "-c"
        run_args = [shell, shell_flag, shell_command]

    try:
        completed = subprocess.run(
            run_args,
            cwd=cwd,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=max(timeout_ms, 1) / 1000.0,
            check=False,
        )
        return {
            "stdout": truncate_output(completed.stdout, max_output_bytes),
            "stderr": truncate_output(completed.stderr, max_output_bytes),
            "exitCode": completed.returncode,
            "timedOut": False,
        }
    except subprocess.TimeoutExpired as error:
        return {
            "stdout": truncate_output(error.stdout, max_output_bytes),
            "stderr": truncate_output(error.stderr, max_output_bytes),
            "exitCode": -1,
            "timedOut": True,
        }


def set_terminal_size(fd, cols, rows):
    safe_cols = max(1, int(cols or 80))
    safe_rows = max(1, int(rows or 24))
    winsize = struct.pack("HHHH", safe_rows, safe_cols, 0, 0)
    import fcntl

    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


class TerminalSession:
    def __init__(self, terminal_id, cwd, shell, shell_args, env, cols, rows):
        self.terminal_id = terminal_id
        self.cwd = normalize_posix_path(cwd)
        self.shell = str(shell or "").strip() or "/bin/bash"
        self.shell_args = [str(arg) for arg in (shell_args or [])]
        self.env = {
            key: str(value)
            for key, value in (env or {}).items()
            if isinstance(key, str) and isinstance(value, str)
        }
        self.buffer = deque(maxlen=MAX_TERMINAL_BUFFER_CHUNKS)
        self.next_cursor = 0
        self.closed = False
        self.exit_code = None
        self.exit_signal = None
        self.pid = None
        self.fd = None
        self.lock = threading.Lock()

        pid, fd = pty.fork()
        if pid == 0:
            child_env = os.environ.copy()
            child_env.update(self.env)
            try:
                os.chdir(self.cwd)
            except Exception:
                os._exit(1)
            os.execvpe(self.shell, [self.shell, *self.shell_args], child_env)

        self.pid = pid
        self.fd = fd
        set_terminal_size(self.fd, cols, rows)

        self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader_thread.start()

    def _append_output(self, data):
        text = data.decode("utf-8", errors="replace")
        with self.lock:
            self.buffer.append({
                "cursor": self.next_cursor,
                "data": text,
            })
            self.next_cursor += 1

    def _mark_closed(self):
        if self.closed:
            return

        self.closed = True
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == 0:
                pid, status = os.waitpid(self.pid, 0)
        except ChildProcessError:
            status = None

        if status is None:
            return

        if os.WIFEXITED(status):
            self.exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            self.exit_code = 128 + os.WTERMSIG(status)
            self.exit_signal = signal.Signals(os.WTERMSIG(status)).name

    def _reader_loop(self):
        while True:
            try:
                data = os.read(self.fd, 4096)
            except OSError as error:
                if error.errno not in (errno.EIO, errno.EBADF):
                    self._append_output(f"\r\n[remote-agent error] {error}\r\n".encode("utf-8"))
                break

            if not data:
                break

            self._append_output(data)

        self._mark_closed()

    def snapshot(self):
        return {
            "terminalId": self.terminal_id,
            "pid": self.pid,
            "cwd": self.cwd,
            "shell": self.shell,
            "closed": self.closed,
            "exitCode": self.exit_code,
            "exitSignal": self.exit_signal,
        }

    def read(self, cursor=0):
        requested_cursor = max(0, int(cursor or 0))

        with self.lock:
            oldest_cursor = self.buffer[0]["cursor"] if self.buffer else self.next_cursor
            truncated = requested_cursor < oldest_cursor
            effective_cursor = oldest_cursor if truncated else requested_cursor
            output = "".join(
                entry["data"]
                for entry in self.buffer
                if entry["cursor"] >= effective_cursor
            )
            next_cursor = self.next_cursor

        return {
            "output": output,
            "nextCursor": next_cursor,
            "truncated": truncated,
            "closed": self.closed,
            "exitCode": self.exit_code,
            "exitSignal": self.exit_signal,
        }

    def write(self, data):
        if self.closed:
            raise ValueError("terminal session is closed")

        try:
            os.write(self.fd, data)
        except OSError as error:
            self._mark_closed()
            raise ValueError(f"terminal write failed: {error}") from error

    def resize(self, cols, rows):
        if self.closed:
            return
        set_terminal_size(self.fd, cols, rows)


def get_terminal_session(terminal_id):
    with TERMINAL_SESSIONS_LOCK:
        session = TERMINAL_SESSIONS.get(terminal_id)
        if not session:
            raise FileNotFoundError("terminal session not found")
        return session


def open_terminal(payload):
    terminal_id = str(payload.get("terminalId") or "").strip()
    if not terminal_id:
        raise ValueError("terminalId is required")

    cwd = payload.get("cwd") or os.path.expanduser("~")
    shell = payload.get("shell") or "/bin/bash"
    shell_args = payload.get("shellArgs") or []
    env = payload.get("env") or {}
    cols = payload.get("cols") or 80
    rows = payload.get("rows") or 24

    with TERMINAL_SESSIONS_LOCK:
        existing = TERMINAL_SESSIONS.get(terminal_id)
        if existing:
            if existing.closed:
                TERMINAL_SESSIONS.pop(terminal_id, None)
            else:
                existing.resize(cols, rows)
                return {
                    "created": False,
                    **existing.snapshot(),
                }

        session = TerminalSession(terminal_id, cwd, shell, shell_args, env, cols, rows)
        TERMINAL_SESSIONS[terminal_id] = session
        return {
            "created": True,
            **session.snapshot(),
        }


def read_terminal(payload):
    session = get_terminal_session(str(payload.get("terminalId") or "").strip())
    return session.read(payload.get("cursor") or 0)


def input_terminal(payload):
    session = get_terminal_session(str(payload.get("terminalId") or "").strip())
    data = base64.b64decode(payload.get("dataBase64") or "")
    session.write(data)
    return session.snapshot()


def resize_terminal(payload):
    session = get_terminal_session(str(payload.get("terminalId") or "").strip())
    session.resize(payload.get("cols") or 80, payload.get("rows") or 24)
    return session.snapshot()


class RemoteAgentHandler(BaseHTTPRequestHandler):
    agent_token = None
    bind_host = None
    bind_port = None

    def _json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_authorized(self):
        expected = f"Bearer {self.agent_token}"
        return self.headers.get("Authorization") == expected

    def _require_auth(self):
        if self._is_authorized():
            return True

        self._json(401, {
            "ok": False,
            "error": "Unauthorized",
        })
        return False

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        if not raw_body:
            return {}
        return json.loads(raw_body.decode("utf-8"))

    def _handle_post_action(self, handler):
        if not self._require_auth():
            return

        try:
            payload = self._read_json_body()
            result = handler(payload)
            self._json(200, {
                "ok": True,
                **(result or {}),
            })
        except FileNotFoundError as error:
            self._json(404, {"ok": False, "error": str(error)})
        except FileExistsError as error:
            self._json(409, {"ok": False, "error": str(error)})
        except PermissionError as error:
            self._json(403, {"ok": False, "error": str(error)})
        except (NotADirectoryError, ValueError, json.JSONDecodeError) as error:
            self._json(400, {"ok": False, "error": str(error)})
        except Exception as error:
            self._json(500, {"ok": False, "error": str(error)})

    def do_GET(self):
        if not self._require_auth():
            return

        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._json(200, {
                "ok": True,
                "service": "claude-code-ui-remote-agent",
                "version": AGENT_VERSION,
                "startedAt": STARTED_AT,
                "pid": os.getpid(),
                "bindHost": self.bind_host,
                "bindPort": self.bind_port,
                "capabilities": [
                    "health",
                    "probe/system",
                    "probe/providers",
                    "fs/list",
                    "fs/read",
                    "fs/write",
                    "fs/mkdir",
                    "fs/move",
                    "fs/delete",
                    "fs/stat",
                    "process/run",
                    "terminals/open",
                    "terminals/read",
                    "terminals/input",
                    "terminals/resize",
                ],
                "system": build_system_probe(),
            })
            return

        if parsed.path == "/probe/system":
            self._json(200, {
                "ok": True,
                **build_system_probe(),
            })
            return

        if parsed.path == "/probe/providers":
            self._json(200, {
                "ok": True,
                **build_provider_probe(),
            })
            return

        self._json(404, {
            "ok": False,
            "error": "Not Found",
        })

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/fs/list":
            self._handle_post_action(lambda payload: {
                "entries": list_fs_entries(payload.get("path")),
            })
            return

        if parsed.path == "/fs/read":
            self._handle_post_action(lambda payload: {
                "content": read_fs_file(payload.get("path"), payload.get("encoding") or "utf8"),
            })
            return

        if parsed.path == "/fs/write":
            self._handle_post_action(lambda payload: (
                write_fs_file(
                    payload.get("path"),
                    payload.get("content"),
                    payload.get("encoding") or "utf8",
                    bool(payload.get("createParentDirectories")),
                    bool(payload.get("failIfExists")),
                ) or {"path": normalize_posix_path(payload.get("path"))}
            ))
            return

        if parsed.path == "/fs/mkdir":
            self._handle_post_action(lambda payload: (
                mkdir_fs(payload.get("path"), bool(payload.get("recursive"))) or {
                    "path": normalize_posix_path(payload.get("path")),
                }
            ))
            return

        if parsed.path == "/fs/move":
            self._handle_post_action(lambda payload: (
                move_fs(payload.get("from"), payload.get("to"), bool(payload.get("overwrite"))) or {
                    "from": normalize_posix_path(payload.get("from")),
                    "to": normalize_posix_path(payload.get("to")),
                }
            ))
            return

        if parsed.path == "/fs/delete":
            self._handle_post_action(lambda payload: (
                delete_fs_entry(payload.get("path"), bool(payload.get("recursive"))) or {
                    "path": normalize_posix_path(payload.get("path")),
                }
            ))
            return

        if parsed.path == "/fs/stat":
            self._handle_post_action(lambda payload: stat_entry(payload.get("path")))
            return

        if parsed.path == "/process/run":
            self._handle_post_action(run_process)
            return

        if parsed.path == "/terminals/open":
            self._handle_post_action(open_terminal)
            return

        if parsed.path == "/terminals/read":
            self._handle_post_action(read_terminal)
            return

        if parsed.path == "/terminals/input":
            self._handle_post_action(input_terminal)
            return

        if parsed.path == "/terminals/resize":
            self._handle_post_action(resize_terminal)
            return

        self._json(404, {
            "ok": False,
            "error": "Not Found",
        })

    def log_message(self, format, *args):
        return


def parse_args():
    parser = argparse.ArgumentParser(description="Claude Code UI remote agent")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token-file", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    RemoteAgentHandler.agent_token = read_token(args.token_file)
    RemoteAgentHandler.bind_host = args.host
    RemoteAgentHandler.bind_port = args.port
    server = ThreadingHTTPServer((args.host, args.port), RemoteAgentHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
