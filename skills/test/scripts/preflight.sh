#!/usr/bin/env bash
set -euo pipefail

REPO="."
PORTS=("3111" "5179")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --ports)
      IFS=',' read -r -a PORTS <<< "$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! git -C "$REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Target is not a git repository: $REPO" >&2
  exit 1
fi

ROOT="$(git -C "$REPO" rev-parse --show-toplevel)"
BRANCH="$(git -C "$REPO" branch --show-current || true)"
HEAD_SHA="$(git -C "$REPO" rev-parse --short HEAD)"
DIRTY_COUNT="$(git -C "$REPO" status --short | wc -l | tr -d ' ')"

echo "== Repo =="
echo "root: $ROOT"
echo "branch: ${BRANCH:-DETACHED}"
echo "head: $HEAD_SHA"
echo "dirty_entries: $DIRTY_COUNT"
echo

echo "== Dirty Preview =="
git -C "$REPO" status --short | sed -n '1,40p'
echo

echo "== Remotes =="
git -C "$REPO" remote -v || true
echo

echo "== Processes =="
ps -ef | grep -E "server/index.js|vite" | grep -v grep || true
echo

echo "== Ports =="
for port in "${PORTS[@]}"; do
  echo "-- port $port --"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E ":${port}[[:space:]]" || echo "not listening"
  else
    echo "ss not available"
  fi
done
echo

echo "== Key Files =="
for path in \
  "$ROOT/scripts/restart-backend.sh" \
  "$ROOT/scripts/e2b-e2e-flow.js" \
  "$ROOT/server/index.js" \
  "$ROOT/src/components/chat/hooks/useChatRealtimeHandlers.ts"; do
  if [[ -e "$path" ]]; then
    echo "ok: $path"
  else
    echo "missing: $path"
  fi
done
