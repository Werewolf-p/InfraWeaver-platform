#!/usr/bin/env bash
# scripts/update.sh — Pull latest InfraWeaver platform updates
# Usage: ./scripts/update.sh [--skip-rebuild] [--json]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON_OUTPUT=false
SKIP_REBUILD=false

for arg in "$@"; do
  case $arg in
    --json) JSON_OUTPUT=true ;;
    --skip-rebuild) SKIP_REBUILD=true ;;
  esac
done

log() { "$JSON_OUTPUT" || echo "[update] $*"; }
jout() { "$JSON_OUTPUT" && echo "$*"; }

cd "$REPO_DIR"

# 1. Capture pre-update state
OLD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
INIT_SITE_DIR="$REPO_DIR/apps/infraweaver-init"
INIT_OUT_DIR="$REPO_DIR/scripts/init/out"

log "Current commit: $OLD_SHA"
log "Fetching latest from origin..."

# 2. Fetch and check for updates
git fetch --quiet origin main 2>&1 || { log "git fetch failed"; exit 1; }
REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null || echo "")

if [ "$OLD_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date."
  jout "{\"ok\":true,\"updated\":false,\"sha\":\"$OLD_SHA\",\"message\":\"Already up to date\"}"
  exit 0
fi

# 3. Pull latest code
log "Pulling $OLD_SHA → $REMOTE_SHA..."
git pull --ff-only origin main 2>&1 || {
  log "git pull failed (non-fast-forward?)"
  jout "{\"ok\":false,\"error\":\"git pull --ff-only failed\"}"
  exit 1
}
NEW_SHA=$(git rev-parse HEAD)

# 4. Collect changelog
CHANGELOG=$(git log --oneline --no-merges "${OLD_SHA}..${NEW_SHA}" 2>/dev/null || echo "")
log "New commits:"
echo "$CHANGELOG" | while read -r line; do log "  $line"; done

# 5. Rebuild init site if its source changed
INIT_REBUILT=false
if [ "$SKIP_REBUILD" = "false" ]; then
  INIT_CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" -- apps/infraweaver-init/ 2>/dev/null | wc -l)
  SERVER_CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" -- scripts/init/server.py 2>/dev/null | wc -l)
  
  if [ "$INIT_CHANGED" -gt 0 ] || [ "$SERVER_CHANGED" -gt 0 ]; then
    log "Init site source changed ($INIT_CHANGED files), rebuilding..."
    if command -v node &>/dev/null && [ -f "$INIT_SITE_DIR/package.json" ]; then
      (cd "$INIT_SITE_DIR" && npm ci --prefer-offline --loglevel error 2>&1 && npm run build 2>&1) || {
        log "Init site build failed — continuing without rebuild"
      }
      if [ -d "$INIT_SITE_DIR/out" ]; then
        rsync -a --delete "$INIT_SITE_DIR/out/" "$INIT_OUT_DIR/"
        log "Init site rebuilt and synced to $INIT_OUT_DIR"
        INIT_REBUILT=true
      fi
    else
      log "Node.js not available — skipping init site rebuild"
    fi
  else
    log "Init site source unchanged — skipping rebuild"
  fi
fi

jout "{\"ok\":true,\"updated\":true,\"oldSha\":\"$OLD_SHA\",\"newSha\":\"$NEW_SHA\",\"changelog\":$(echo "$CHANGELOG" | python3 -c 'import sys,json;lines=[l for l in sys.stdin.read().splitlines() if l.strip()];print(json.dumps(lines))'),\"initRebuilt\":$INIT_REBUILT}"

log "Update complete: $OLD_SHA → $NEW_SHA"
