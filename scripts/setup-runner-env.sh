#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-runner-env.sh — Install .env on the self-hosted runner machine
#
# USAGE (from your workstation, after filling in .env):
#   bash scripts/setup-runner-env.sh [runner-ip] [runner-user]
#
# What this does:
#   1. Copies your local .env to /opt/platform/.env on the runner
#   2. Sets strict permissions (chmod 600, owned by runner user)
#   3. Validates all required keys are present
#
# Requirements:
#   - .env file exists and is populated (cp .env.example .env first)
#   - SSH access to the runner machine
#   - The runner's GitHub Actions service will auto-load from /opt/platform/.env
#     via the load-env composite action called at the top of each workflow job
#
# NOTE: After running this, GitHub Secrets can be left empty or removed entirely.
#       The load-env composite action takes precedence for all self-hosted jobs.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RUNNER_IP="${1:-10.10.0.118}"
RUNNER_USER="${2:-runner}"
RUNNER_PATH="/opt/platform/.env"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deployer_ed25519}"

if [ ! -f ".env" ]; then
  fail ".env not found — run: cp .env.example .env  then fill in your values"
fi

# ── Validate required keys ───────────────────────────────────────────────────
REQUIRED_KEYS=(
  AGE_SECRET_KEY
  ARGOCD_GITHUB_TOKEN
  CLOUDFLARE_API_TOKEN
  DEPLOYER_SSH_KEY
  NETBIRD_API_TOKEN
  PROXMOX_API_TOKEN
  RUNNER_REGISTRATION_TOKEN
  SMTP_PASSWORD
  SMTP_USERNAME
  SMTP_TO
  OPENBAO_ROOT_TOKEN
  ESO_SERVICE_TOKEN
  OPENBAO_CLUSTER_ADDR
)

echo ""
echo "Validating .env keys..."
missing=()
for key in "${REQUIRED_KEYS[@]}"; do
  if ! grep -qE "^${key}=" .env; then
    missing+=("$key")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  warn "Missing keys in .env:"
  for k in "${missing[@]}"; do echo "  - $k"; done
  echo ""
  read -rp "Continue anyway? (y/N) " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

ok "All required keys present"

# ── Copy to runner ───────────────────────────────────────────────────────────
echo ""
info "Copying .env to ${RUNNER_USER}@${RUNNER_IP}:${RUNNER_PATH} ..."

ssh_opts="-o StrictHostKeyChecking=accept-new -o BatchMode=yes"
if [ -f "$SSH_KEY" ]; then
  ssh_opts="$ssh_opts -i $SSH_KEY"
fi

# Create directory on runner
ssh $ssh_opts "${RUNNER_USER}@${RUNNER_IP}" "sudo mkdir -p /opt/platform && sudo chown ${RUNNER_USER}:${RUNNER_USER} /opt/platform"

# Copy the file
scp $ssh_opts .env "${RUNNER_USER}@${RUNNER_IP}:/tmp/platform.env.tmp"

# Move and secure on runner
ssh $ssh_opts "${RUNNER_USER}@${RUNNER_IP}" "
  mv /tmp/platform.env.tmp ${RUNNER_PATH}
  chmod 600 ${RUNNER_PATH}
  echo 'Installed /opt/platform/.env with 600 permissions'
"

ok "Environment installed at ${RUNNER_IP}:${RUNNER_PATH}"
echo ""
info "Next: trigger any workflow — it will load secrets from the runner's .env"
info "You can now optionally remove GitHub Secrets from the repository settings."
echo ""
