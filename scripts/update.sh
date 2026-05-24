#!/usr/bin/env bash
# scripts/update.sh — Pull latest InfraWeaver platform updates from GitHub
# Usage: ./scripts/update.sh [--skip-rebuild] [--json]
#
# This script updates the init-VM's local copy of the platform repo from the
# official GitHub repository. Kubernetes apps (api/console/node) update
# automatically via ArgoCD when image tags change in the manifests.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITHUB_URL="https://github.com/Werewolf-p/InfraWeaver-platform.git"
JSON_OUTPUT=false
SKIP_REBUILD=false

for arg in "$@"; do
  case $arg in
    --json)         JSON_OUTPUT=true ;;
    --skip-rebuild) SKIP_REBUILD=true ;;
  esac
done

log()  { "$JSON_OUTPUT" || echo "[update] $*"; }
jout() { "$JSON_OUTPUT" && echo "$*"; }

cd "$REPO_DIR"

# 1. Capture pre-update state
OLD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
INIT_SITE_DIR="$REPO_DIR/apps/infraweaver-init"
INIT_OUT_DIR="$REPO_DIR/scripts/init/out"

log "Current commit: $OLD_SHA"

# 2. Ensure github remote exists
if ! git remote get-url github &>/dev/null; then
  git remote add github "$GITHUB_URL"
  log "Added github remote: $GITHUB_URL"
fi

log "Fetching latest from GitHub..."
git fetch --quiet github main 2>&1 || {
  log "GitHub fetch failed — falling back to origin (Onedev)"
  git fetch --quiet origin main 2>&1 || { log "All fetches failed"; exit 1; }
  git remote set-head github -a 2>/dev/null || true
}

REMOTE_SHA=$(git rev-parse github/main 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo "")

if [ "$OLD_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date ($OLD_SHA)."
  jout "{\"ok\":true,\"updated\":false,\"sha\":\"$OLD_SHA\",\"message\":\"Already up to date\"}"
  exit 0
fi

# 3. Pull from GitHub
log "Pulling $OLD_SHA → $REMOTE_SHA..."
git pull --ff-only github main 2>&1 || {
  log "Fast-forward failed — trying merge"
  git merge github/main --no-edit 2>&1 || {
    log "Merge failed"
    jout "{\"ok\":false,\"error\":\"git merge github/main failed\"}"
    exit 1
  }
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
      timeout 300 bash -c "cd '$INIT_SITE_DIR' && npm ci --prefer-offline --loglevel error && npm run build" 2>&1 || {
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

CHANGELOG_JSON=$(echo "$CHANGELOG" | python3 -c 'import sys,json; lines=[l for l in sys.stdin.read().splitlines() if l.strip()]; print(json.dumps(lines))')

jout "{\"ok\":true,\"updated\":true,\"oldSha\":\"$OLD_SHA\",\"newSha\":\"$NEW_SHA\",\"changelog\":${CHANGELOG_JSON},\"initRebuilt\":$INIT_REBUILT}"

log "Update complete: $OLD_SHA → $NEW_SHA"
