#!/usr/bin/env bash
# =============================================================================
# start-local.sh — Start InfraWeaver Init Wizard on any Linux / macOS machine
#
# Run this on a spare Ubuntu VM, your laptop, WSL, or any machine that has
# network access to your Proxmox API (port 8006).  No Proxmox shell needed.
#
# USAGE:
#   wget -qO- https://raw.githubusercontent.com/Werewolf-p/InfraWeaver-platform/main/scripts/init/start-local.sh | bash
#   curl -sSL https://raw.githubusercontent.com/Werewolf-p/InfraWeaver-platform/main/scripts/init/start-local.sh | bash
#
# ENV OVERRIDES:
#   IW_WORK_DIR   — where to clone the repo  (default: ~/.infraweaver)
#   IW_REPO_URL   — git URL to clone          (default: GitHub repo)
#   IW_REPO_BRANCH— branch to check out       (default: main)
#   IW_PORT       — web UI port               (default: 8080)
#   IW_HOST       — bind address              (default: 0.0.0.0)
# =============================================================================
set -euo pipefail

REPO_URL="${IW_REPO_URL:-https://github.com/Werewolf-p/InfraWeaver-platform}"
REPO_BRANCH="${IW_REPO_BRANCH:-main}"
WORK_DIR="${IW_WORK_DIR:-$HOME/.infraweaver}"
PORT="${IW_PORT:-8080}"
HOST="${IW_HOST:-0.0.0.0}"

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
  G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'
  D='\033[2m'; NC='\033[0m'; B='\033[1m'
else
  G=''; Y=''; R=''; C=''; D=''; NC=''; B=''
fi
log()  { echo -e "${G}  >>${NC} $*"; }
warn() { echo -e "${Y}  WARN:${NC} $*"; }
die()  { echo -e "${R}  ERROR:${NC} $*" >&2; exit 1; }

echo -e ""
echo -e "${C}${B}  +============================================================+${NC}"
echo -e "${C}${B}  |         InfraWeaver — Local Init Starter                   |${NC}"
echo -e "${C}${B}  +============================================================+${NC}"
echo -e "${D}  Starts the InfraWeaver wizard on this machine.${NC}"
echo -e "${D}  Needs network access to your Proxmox API (port 8006).${NC}"
echo -e ""

# ── 1. Check prerequisites ────────────────────────────────────────────────────
log "Checking prerequisites..."

PY=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    ver=$("$cmd" -c 'import sys; print(sys.version_info[:2] >= (3,8))' 2>/dev/null)
    if [[ "$ver" == "True" ]]; then PY="$cmd"; break; fi
  fi
done
[[ -z "$PY" ]] && die "Python 3.8+ is required. Install it with: sudo apt install python3  (or brew install python3)"
log "Python OK: $($PY --version)"

command -v git &>/dev/null || die "git is required. Install it with: sudo apt install git  (or brew install git)"
log "git OK: $(git --version)"

# ── 2. Clone or update the repo ──────────────────────────────────────────────
if [[ -d "$WORK_DIR/.git" ]]; then
  log "Repo already at ${B}${WORK_DIR}${NC} — pulling latest ${REPO_BRANCH}..."
  git -C "$WORK_DIR" fetch --quiet origin
  git -C "$WORK_DIR" checkout --quiet "$REPO_BRANCH"
  git -C "$WORK_DIR" reset --quiet --hard "origin/$REPO_BRANCH"
  log "Repo updated."
else
  log "Cloning ${B}${REPO_URL}${NC} (branch: ${REPO_BRANCH}) → ${WORK_DIR} ..."
  mkdir -p "$(dirname "$WORK_DIR")"
  git clone --quiet --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$WORK_DIR"
  log "Clone complete."
fi

# ── 3. Detect local IP for display ───────────────────────────────────────────
_local_ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
[[ -z "$_local_ip" ]] && _local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[[ -z "$_local_ip" ]] && _local_ip="<this-machine-ip>"

# ── 4. Start the init server ──────────────────────────────────────────────────
echo -e ""
echo -e "  ${C}${B}Starting InfraWeaver Init Server...${NC}"
echo -e ""
echo -e "  ${G}${B}+----------------------------------------------------------+${NC}"
echo -e "  ${G}${B}|  Web UI  →  http://${_local_ip}:${PORT}                  ${NC}"
echo -e "  ${G}${B}+----------------------------------------------------------+${NC}"
echo -e ""
echo -e "  ${D}Open the URL above in your browser, fill in your settings,${NC}"
echo -e "  ${D}then click Deploy.  Press Ctrl+C to stop.${NC}"
echo -e ""

# Try to open browser automatically (non-blocking, ignore errors)
if command -v xdg-open &>/dev/null; then
  (sleep 2 && xdg-open "http://localhost:${PORT}") &>/dev/null &
elif command -v open &>/dev/null; then
  (sleep 2 && open "http://localhost:${PORT}") &>/dev/null &
fi

export IW_REPO_DIR="$WORK_DIR"
export IW_PORT="$PORT"
export IW_HOST="$HOST"

exec "$PY" "$WORK_DIR/scripts/init/server.py" --port "$PORT" --host "$HOST"
