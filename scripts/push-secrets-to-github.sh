#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# push-secrets-to-github.sh — Sync .env → GitHub Secrets
#
# USAGE:
#   gh auth login          # if not already authenticated
#   bash scripts/push-secrets-to-github.sh
#
# What this does:
#   Reads all KEY=VALUE pairs from .env and pushes them to GitHub Secrets
#   using the gh CLI. This keeps CI secrets in sync with your local .env.
#
# Requirements:
#   - gh CLI installed and authenticated (gh auth login)
#   - .env file exists and is populated
#   - You have admin rights on the repository
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_NAME="push-secrets-to-github"
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RED='\033[0;31m'; NC='\033[0m'
fail() { echo -e "${RED}❌ $*${NC}"; exit 1; }

if ! command -v gh &>/dev/null; then
  fail "gh CLI not found — install from https://cli.github.com"
fi

if ! gh auth status &>/dev/null; then
  fail "Not authenticated — run: gh auth login"
fi

if [ ! -f ".env" ]; then
  fail ".env not found — run: cp .env.example .env  then fill in your values"
fi

# Detect repo from git remote
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')
echo ""
echo "Syncing .env → GitHub Secrets for repo: ${REPO}"
echo ""

# Only sync variables that are known GitHub Secrets (not local-only vars)
KNOWN_SECRETS=(
  PROXMOX_API_TOKEN
  DEPLOYER_SSH_KEY
  CLOUDFLARE_API_TOKEN
  AGE_SECRET_KEY
  OPENBAO_ROOT_TOKEN
  ARGOCD_GITHUB_TOKEN
  NETBIRD_API_TOKEN
  RUNNER_REGISTRATION_TOKEN
  SMTP_USERNAME
  SMTP_PASSWORD
  SMTP_TO
)

# Parse .env (skip comments and empty lines)
declare -A ENV_VARS
while IFS='=' read -r key value; do
  # Skip comments and empty lines
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  # Handle multi-line values (just take first line for now)
  key=$(echo "$key" | xargs)
  ENV_VARS["$key"]="$value"
done < .env

PUSHED=0
SKIPPED=0

for secret in "${KNOWN_SECRETS[@]}"; do
  val="${ENV_VARS[$secret]:-}"

  if [ -z "$val" ] || [[ "$val" == *"<your"* ]] || [[ "$val" == *"xxxx"* ]] || [[ "$val" == *"XXXXX"* ]]; then
    warn "Skipping ${secret} — empty or still a placeholder"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  echo -n "  Setting ${secret}... "
  echo "$val" | gh secret set "$secret" --repo "$REPO"
  ok "done"
  PUSHED=$((PUSHED+1))
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}Pushed ${PUSHED} secret(s) to GitHub | Skipped ${SKIPPED}${NC}"
if [ "$SKIPPED" -gt 0 ]; then
  warn "Fix placeholder values in .env and re-run to push remaining secrets."
fi
