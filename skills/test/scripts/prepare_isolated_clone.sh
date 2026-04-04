#!/usr/bin/env bash
set -euo pipefail

SOURCE="."
DEST=""
CHECKOUT_BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --dest)
      DEST="$2"
      shift 2
      ;;
    --branch)
      CHECKOUT_BRANCH="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! git -C "$SOURCE" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Source is not a git repository: $SOURCE" >&2
  exit 1
fi

SOURCE_ROOT="$(git -C "$SOURCE" rev-parse --show-toplevel)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -z "$DEST" ]]; then
  DEST="/tmp/$(basename "$SOURCE_ROOT")-isolated-${TIMESTAMP}"
fi

if [[ -e "$DEST" ]]; then
  echo "Destination already exists: $DEST" >&2
  exit 1
fi

git clone --no-hardlinks "$SOURCE_ROOT" "$DEST"

if [[ -n "$CHECKOUT_BRANCH" ]]; then
  git -C "$DEST" checkout "$CHECKOUT_BRANCH"
fi

echo "Isolated clone ready: $DEST"
echo "Source repo was not modified."
