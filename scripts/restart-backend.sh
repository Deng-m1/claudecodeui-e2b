#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${LOG_FILE:-/tmp/claudecliui-server.log}"
PID_FILE="${PID_FILE:-/tmp/claudecliui-server.pid}"
TERMINALD_LOG_FILE="${TERMINALD_LOG_FILE:-/tmp/claudecliui-terminald.log}"
TERMINALD_PID_FILE="${TERMINALD_PID_FILE:-/tmp/claudecliui-terminald.pid}"
GRACE_SECONDS="${GRACE_SECONDS:-5}"
DEFAULT_SERVER_PORT="${DEFAULT_SERVER_PORT:-3111}"
SERVER_PORT="${1:-${RESTART_BACKEND_PORT:-$DEFAULT_SERVER_PORT}}"
DEFAULT_TERMINALD_PORT="${DEFAULT_TERMINALD_PORT:-$((SERVER_PORT + 1))}"
TERMINALD_PORT="${TERMINALD_PORT:-$DEFAULT_TERMINALD_PORT}"
export SERVER_PORT
export TERMINALD_PORT

get_pid_cwd() {
  local pid="$1"
  readlink -f "/proc/${pid}/cwd" 2>/dev/null || true
}

get_pid_cmd() {
  local pid="$1"
  ps -p "$pid" -o args= 2>/dev/null || true
}

is_repo_pid() {
  local pid="$1"
  local cwd
  cwd="$(get_pid_cwd "$pid")"
  [[ -n "$cwd" && "$cwd" == "$REPO_ROOT" ]]
}

describe_pid() {
  local pid="$1"
  local cwd cmd
  cwd="$(get_pid_cwd "$pid")"
  cmd="$(get_pid_cmd "$pid")"

  if [[ -z "$cmd" ]]; then
    return
  fi

  echo "  PID ${pid}"
  echo "    cwd: ${cwd:-unknown}"
  echo "    cmd: $cmd"
}

find_server_port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$SERVER_PORT" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
  fi
}

find_listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
  fi
}

find_repo_server_pids() {
  if [[ -f "$PID_FILE" ]]; then
    local pid_from_file
    pid_from_file="$(<"$PID_FILE")"
    if [[ "$pid_from_file" =~ ^[0-9]+$ ]] && kill -0 "$pid_from_file" 2>/dev/null && is_repo_pid "$pid_from_file"; then
      echo "$pid_from_file"
    fi
  fi

  ps -eo pid=,args= 2>/dev/null | while read -r pid cmd; do
    if [[ -z "${pid:-}" || "$pid" == "$$" ]]; then
      continue
    fi

    case "$cmd" in
      *"server/index.js"*|*"server/cli.js start"*|*"/.bin/cloudcli start"*|*"/.bin/claude-code-ui start"*)
        if is_repo_pid "$pid"; then
          echo "$pid"
        fi
        ;;
    esac
  done | sort -u
}

find_repo_terminald_pids() {
  if [[ -f "$TERMINALD_PID_FILE" ]]; then
    local pid_from_file
    pid_from_file="$(<"$TERMINALD_PID_FILE")"
    if [[ "$pid_from_file" =~ ^[0-9]+$ ]] && kill -0 "$pid_from_file" 2>/dev/null && is_repo_pid "$pid_from_file"; then
      echo "$pid_from_file"
    fi
  fi

  ps -eo pid=,args= 2>/dev/null | while read -r pid cmd; do
    if [[ -z "${pid:-}" || "$pid" == "$$" ]]; then
      continue
    fi

    case "$cmd" in
      *"terminald/index.js"*)
        if is_repo_pid "$pid"; then
          echo "$pid"
        fi
        ;;
    esac
  done | sort -u
}

stop_existing_servers() {
  mapfile -t pids < <(find_repo_server_pids || true)

  if [[ "${#pids[@]}" -eq 0 ]]; then
    mapfile -t port_pids < <(find_server_port_pids || true)

    if [[ "${#port_pids[@]}" -eq 0 ]]; then
      echo "No running backend process found for ${REPO_ROOT}"
      return 0
    fi

    echo "No repo-local backend process found for ${REPO_ROOT}"
    echo "But port ${SERVER_PORT} is already being listened on by:"
    for pid in "${port_pids[@]}"; do
      describe_pid "$pid"
    done
    echo "Stop that process from its own working tree, or free port ${SERVER_PORT}, then rerun this script."
    return 1
  fi

  echo "Stopping backend PID(s): ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true

  local deadline=$((SECONDS + GRACE_SECONDS))
  while (( SECONDS < deadline )); do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
        break
      fi
    done

    if [[ "$alive" -eq 0 ]]; then
      echo "Existing backend stopped cleanly"
      return
    fi

    sleep 1
  done

  echo "Force killing remaining backend PID(s): ${pids[*]}"
  kill -9 "${pids[@]}" 2>/dev/null || true
}

stop_existing_terminald() {
  mapfile -t pids < <(find_repo_terminald_pids || true)

  if [[ "${#pids[@]}" -eq 0 ]]; then
    mapfile -t port_pids < <(find_listener_pids "$TERMINALD_PORT" || true)

    if [[ "${#port_pids[@]}" -eq 0 ]]; then
      echo "No running terminald process found for ${REPO_ROOT}"
      return 0
    fi

    echo "No repo-local terminald process found for ${REPO_ROOT}"
    echo "But port ${TERMINALD_PORT} is already being listened on by:"
    for pid in "${port_pids[@]}"; do
      describe_pid "$pid"
    done
    echo "Stop that process from its own working tree, or free port ${TERMINALD_PORT}, then rerun this script."
    return 1
  fi

  echo "Stopping terminald PID(s): ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true

  local deadline=$((SECONDS + GRACE_SECONDS))
  while (( SECONDS < deadline )); do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
        break
      fi
    done

    if [[ "$alive" -eq 0 ]]; then
      echo "Existing terminald stopped cleanly"
      return
    fi

    sleep 1
  done

  echo "Force killing remaining terminald PID(s): ${pids[*]}"
  kill -9 "${pids[@]}" 2>/dev/null || true
}

start_backend() {
  mkdir -p "$(dirname -- "$LOG_FILE")"

  mapfile -t port_pids < <(find_server_port_pids || true)
  local blocking_pids=()
  local pid

  for pid in "${port_pids[@]}"; do
    if [[ -n "$pid" ]] && ! is_repo_pid "$pid"; then
      blocking_pids+=("$pid")
    fi
  done

  if [[ "${#blocking_pids[@]}" -gt 0 ]]; then
    echo "Cannot start backend: port ${SERVER_PORT} is already in use by another process:"
    for pid in "${blocking_pids[@]}"; do
      describe_pid "$pid"
    done
    echo "Restart that process from its own repo, or choose a different SERVER_PORT."
    exit 1
  fi

  cd "$REPO_ROOT"
  if command -v setsid >/dev/null 2>&1; then
    setsid node server/index.js >>"$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node server/index.js >>"$LOG_FILE" 2>&1 < /dev/null &
  fi
  local new_pid=$!
  echo "$new_pid" >"$PID_FILE"

  local deadline=$((SECONDS + 10))
  local repo_owns_port=0
  while (( SECONDS < deadline )); do
    if ! kill -0 "$new_pid" 2>/dev/null; then
      break
    fi

    mapfile -t port_pids < <(find_server_port_pids || true)
    for pid in "${port_pids[@]}"; do
      if [[ "$pid" == "$new_pid" ]] || is_repo_pid "$pid"; then
        repo_owns_port=1
        break 2
      fi
    done

    sleep 1
  done

  if ! kill -0 "$new_pid" 2>/dev/null || [[ "$repo_owns_port" -ne 1 ]]; then
    echo "Backend failed to start. Check log: $LOG_FILE"
    if [[ -f "$LOG_FILE" ]]; then
      tail -n 40 "$LOG_FILE"
    fi
    exit 1
  fi

  echo "Backend restarted successfully"
  echo "PID: $new_pid"
  echo "Log: $LOG_FILE"
}

start_terminald() {
  mkdir -p "$(dirname -- "$TERMINALD_LOG_FILE")"

  mapfile -t port_pids < <(find_listener_pids "$TERMINALD_PORT" || true)
  local blocking_pids=()
  local pid

  for pid in "${port_pids[@]}"; do
    if [[ -n "$pid" ]] && ! is_repo_pid "$pid"; then
      blocking_pids+=("$pid")
    fi
  done

  if [[ "${#blocking_pids[@]}" -gt 0 ]]; then
    echo "Cannot start terminald: port ${TERMINALD_PORT} is already in use by another process:"
    for pid in "${blocking_pids[@]}"; do
      describe_pid "$pid"
    done
    echo "Restart that process from its own repo, or choose a different TERMINALD_PORT."
    exit 1
  fi

  cd "$REPO_ROOT"
  if command -v setsid >/dev/null 2>&1; then
    setsid node terminald/index.js >>"$TERMINALD_LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node terminald/index.js >>"$TERMINALD_LOG_FILE" 2>&1 < /dev/null &
  fi
  local new_pid=$!
  echo "$new_pid" >"$TERMINALD_PID_FILE"

  local deadline=$((SECONDS + 10))
  local repo_owns_port=0
  while (( SECONDS < deadline )); do
    if ! kill -0 "$new_pid" 2>/dev/null; then
      break
    fi

    mapfile -t port_pids < <(find_listener_pids "$TERMINALD_PORT" || true)
    for pid in "${port_pids[@]}"; do
      if [[ "$pid" == "$new_pid" ]] || is_repo_pid "$pid"; then
        repo_owns_port=1
        break 2
      fi
    done

    sleep 1
  done

  if ! kill -0 "$new_pid" 2>/dev/null || [[ "$repo_owns_port" -ne 1 ]]; then
    echo "terminald failed to start. Check log: $TERMINALD_LOG_FILE"
    if [[ -f "$TERMINALD_LOG_FILE" ]]; then
      tail -n 40 "$TERMINALD_LOG_FILE"
    fi
    exit 1
  fi

  echo "terminald restarted successfully"
  echo "PID: $new_pid"
  echo "Log: $TERMINALD_LOG_FILE"
}

stop_existing_terminald || exit 1
stop_existing_servers || exit 1
start_terminald
start_backend
