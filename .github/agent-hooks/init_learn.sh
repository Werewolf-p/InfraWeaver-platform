#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="/home/runner/.copilot/session-state/helpers/catalog_sync.sh"
CATALOG="$REPO_ROOT/.github/catalog.jsonl"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# quick summary as JSON
repo_name="$(basename "$REPO_ROOT")"
json=$(jq -n --arg repo "$repo_name" --arg path "." --arg desc "Auto-learn summary for $repo_name" --arg now "$NOW" '{repo:$repo, path:$path, description:$desc, generated_at:$now}')
# append if not present
if [ -x "$HELPER" ]; then
  if [ ! -f "$CATALOG" ] || ! grep -q "\"repo\":\"$repo_name\"" "$CATALOG" 2>/dev/null; then
    $HELPER update "$REPO_ROOT" "$json"
  fi
fi
