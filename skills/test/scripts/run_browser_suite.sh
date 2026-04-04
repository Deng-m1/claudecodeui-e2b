#!/usr/bin/env bash
set -euo pipefail

export E2E_APP_URL="${E2E_APP_URL:-http://127.0.0.1:5179}"
export E2E_API_URL="${E2E_API_URL:-http://127.0.0.1:3111}"
export E2E_USERNAME="${E2E_USERNAME:-dbj}"
export E2E_PROJECT_QUERY="${E2E_PROJECT_QUERY:-claudecodeui-e2b}"
export E2E_PROVIDERS="${E2E_PROVIDERS:-claude,codex,cursor}"

if [[ -z "${E2E_PASSWORD:-}" ]]; then
  echo "E2E_PASSWORD is required." >&2
  exit 1
fi

exec npx playwright test "$@"
