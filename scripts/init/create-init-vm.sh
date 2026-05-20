#!/usr/bin/env bash
# =============================================================================
# create-init-vm.sh — Deploy InfraWeaver Init VM on Proxmox
#
# USAGE (run this ON the Proxmox host, or via SSH):
#   bash create-init-vm.sh
#   bash create-init-vm.sh --vmid 9001 --storage lvm-proxmox --repo https://github.com/yourorg/InfraWeaver-platform
#
# WHAT THIS DOES:
#   1. Downloads Ubuntu 24.04 cloud image (cached)
#   2. Creates a minimal VM (1 CPU, 1GB RAM, 8GB disk)
#   3. Cloud-init: auto-installs tools, clones repo, starts init web server
#   4. Prints the VM IP and web UI URL when done
#
# RESULT:
#   → http://<vm-ip>:8080  — web UI to configure .env and trigger deployment
#   → Or just: cp .env.example .env && nano .env && bash scripts/deploy-local.sh
# =============================================================================
set -euo pipefail
set +x   # force xtrace OFF — bash inherits SHELLOPTS=xtrace from parent shells
          # which causes every command to be printed, garbling wizard output

# Disable bracketed paste mode — prevents $'\E[200~' artifacts when pasting
# into Proxmox noVNC / shell consoles that have it enabled
printf '\e[?2004l' 2>/dev/null || true

# ── Colors (defined early — used in wizard) ───────────────────────────────────
# Detect if the terminal supports colors; fall back to plain output if not
if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
  G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'
  D='\033[2m'; NC='\033[0m'; B='\033[1m'; M='\033[0;35m'
else
  G=''; Y=''; R=''; C=''; D=''; NC=''; B=''; M=''
fi
log()  { echo -e "${G}>>${NC} $*"; }
warn() { echo -e "${Y}WARN:${NC} $*"; }
die()  { echo -e "${R}ERROR:${NC} $*" >&2; exit 1; }
ok()   { echo -e "${G}OK:${NC} $*"; }
hdr()  { echo -e "\n${C}${B}=== $* ===${NC}"; }
ask()  {
  # ask VAR "Question" "default"  → reads into VAR, shows default in brackets
  # Reads from /dev/tty so it works correctly when the script is piped via wget|bash
  local _var="$1" _prompt="$2" _default="${3:-}"
  local _display="${_default:+${D} [${_default}]${NC}}"
  printf "%b  %s%b: " "${M}" "$_prompt" "${_display}${NC}" >/dev/tty
  IFS= read -r _input </dev/tty
  printf -v "$_var" '%s' "${_input:-$_default}"
}
askyn() {
  # askyn "Question" "Y/n"  → returns 0=yes 1=no
  # Reads from /dev/tty so it works correctly when the script is piped via wget|bash
  local _prompt="$1" _default="${2:-Y}"
  printf "%b  %s %b[%s]%b: " "${M}" "$_prompt" "${D}" "$_default" "${NC}" >/dev/tty
  IFS= read -r _yn </dev/tty
  _yn="${_yn:-$_default}"
  [[ "${_yn,,}" == "y" || "${_yn,,}" == "yes" ]]
}
choose() {
  # choose VAR "Header line" item1 item2 item3...
  # Shows a numbered list; user picks by number or types a value; Enter = item 1
  local _var="$1" _header="$2"; shift 2
  local _opts=("$@") _n="$#"
  echo -e "  ${C}${_header}${NC}" >/dev/tty
  local i; for (( i=0; i<_n; i++ )); do
    local _mark=""; (( i == 0 )) && _mark=" ${D}(default)${NC}"
    printf "    %b%d)%b %s%b\n" "${B}" "$((i+1))" "${NC}" "${_opts[$i]}" "${_mark}" >/dev/tty
  done
  printf "  %bChoice [1]:%b " "${M}" "${NC}" >/dev/tty
  local _input; IFS= read -r _input </dev/tty
  _input="${_input:-1}"
  local _choice
  if [[ "$_input" =~ ^[0-9]+$ ]] && (( _input >= 1 && _input <= _n )); then
    _choice="${_opts[$(( _input - 1 ))]}"
  else
    _choice="$_input"   # allow typing a value directly
  fi
  printf -v "$_var" '%s' "$_choice"
}

# ── Animation helpers ─────────────────────────────────────────────────────────
_SP_PID=""
_SP_CHARS='|/-\'

spin_start() {
  # spin_start "message" — starts a background spinner; call spin_stop when done
  local _msg="$1"
  ( local _i=0
    while true; do
      printf '\r  [%s] %s  ' "${_SP_CHARS:$((_i%4)):1}" "$_msg"
      ((_i++)); sleep 0.1
    done
  ) &
  _SP_PID=$!
}

spin_stop() {
  # spin_stop "done message" — kills spinner and prints final OK line
  if [[ -n "$_SP_PID" ]]; then
    kill "$_SP_PID" 2>/dev/null; wait "$_SP_PID" 2>/dev/null || true; _SP_PID=""
  fi
  printf '\r  %b[OK]%b  %s        \n' "$G" "$NC" "${1:-done}"
}

spin_fail() {
  if [[ -n "$_SP_PID" ]]; then
    kill "$_SP_PID" 2>/dev/null; wait "$_SP_PID" 2>/dev/null || true; _SP_PID=""
  fi
  printf '\r  %b[FAIL]%b %s      \n' "$R" "$NC" "${1:-failed}"
}

# Step counter for the VM creation phase
_STEP_N=0
_STEP_TOTAL=7
step() {
  (( _STEP_N++ )) || true
  printf '\n  %b[%d/%d]%b %s\n' "$C" "$_STEP_N" "$_STEP_TOTAL" "$NC" "$1"
}

# Kill any running spinner on Ctrl+C or exit
trap '[[ -n "$_SP_PID" ]] && kill "$_SP_PID" 2>/dev/null; printf "\r\n"' EXIT


IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
IMAGE_CACHE="/var/lib/vz/template/iso/ubuntu-24.04-cloud.img"

# Env-var overrides (non-interactive mode when all IW_* vars are set)
VMID="${IW_VMID:-}"
VM_NAME="${IW_VM_NAME:-}"
STORAGE="${IW_STORAGE:-}"
BRIDGE="${IW_BRIDGE:-}"
VLAN_TAG="${IW_VLAN_TAG:-_ask_}"        # sentinel: always ask unless env-set
VM_IP="${IW_VM_IP:-_ask_}"
VM_GW="${IW_VM_GW:-}"
VM_CIDR="${IW_VM_CIDR:-}"
CLUSTER_NIC="${IW_CLUSTER_NIC:-_ask_}"  # yes/no
CLUSTER_BRIDGE="${IW_CLUSTER_BRIDGE:-}"
CLUSTER_VLAN="${IW_CLUSTER_VLAN:-}"
CLUSTER_IP="${IW_CLUSTER_IP:-_ask_}"
CLUSTER_CIDR="${IW_CLUSTER_CIDR:-}"
REPO_URL="${IW_REPO_URL:-}"
REPO_BRANCH="${IW_REPO_BRANCH:-}"
CPU="${IW_CPU:-}"
MEM="${IW_MEM:-}"
DISK="${IW_DISK:-}"
if [[ -n "${IW_SSH_PUBKEY:-}" ]]; then
  DEPLOYER_SSH_PUBKEY="$IW_SSH_PUBKEY"
elif [[ -f /root/.ssh/id_ed25519.pub ]]; then
  DEPLOYER_SSH_PUBKEY="$(cat /root/.ssh/id_ed25519.pub)"
elif [[ -f /root/.ssh/id_rsa.pub ]]; then
  DEPLOYER_SSH_PUBKEY="$(cat /root/.ssh/id_rsa.pub)"
elif [[ -f /root/.ssh/authorized_keys ]]; then
  DEPLOYER_SSH_PUBKEY="$(head -1 /root/.ssh/authorized_keys)"
else
  DEPLOYER_SSH_PUBKEY=""
fi

# ── Parse CLI args (override env vars / skip wizard fields) ──────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --vmid)           VMID="$2";            shift 2 ;;
    --storage)        STORAGE="$2";         shift 2 ;;
    --bridge)         BRIDGE="$2";          shift 2 ;;
    --vlan)           VLAN_TAG="$2";        shift 2 ;;
    --ip)             VM_IP="$2";           shift 2 ;;
    --gw)             VM_GW="$2";           shift 2 ;;
    --cluster-vlan)   CLUSTER_VLAN="$2";    shift 2 ;;
    --cluster-ip)     CLUSTER_IP="$2";      shift 2 ;;
    --cluster-cidr)   CLUSTER_CIDR="$2";    shift 2 ;;
    --no-cluster-nic) CLUSTER_NIC="no";     shift   ;;
    --repo)           REPO_URL="$2";        shift 2 ;;
    --branch)         REPO_BRANCH="$2";     shift 2 ;;
    --cpu)            CPU="$2";             shift 2 ;;
    --mem)            MEM="$2";             shift 2 ;;
    --disk)           DISK="$2";            shift 2 ;;
    --ssh-pubkey)     DEPLOYER_SSH_PUBKEY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Banner ────────────────────────────────────────────────────────────────────
# ── Banner (line-by-line reveal) ─────────────────────────────────────────────
echo ""
echo -e "${C}${B}"
sleep 0.05; echo "  +==============================================================+"
sleep 0.05; echo "  |          InfraWeaver -- Init VM Deployer                    |"
sleep 0.05; echo "  |          Creates a lightweight bootstrap VM on Proxmox      |"
sleep 0.05; echo "  +==============================================================+"
echo -e "${NC}"
echo -e "  ${D}This wizard will create a small Ubuntu VM that hosts the${NC}"
echo -e "  ${D}InfraWeaver web UI and deploys your Kubernetes cluster.${NC}"
echo ""

# ── Pre-flight (must run on Proxmox) ─────────────────────────────────────────
command -v qm &>/dev/null || die "This script must run on a Proxmox VE host (qm not found)"

# ── Auto-detect Proxmox environment ──────────────────────────────────────────
PVE_NODE=$(hostname -s)

# Available storages that can hold VM images
mapfile -t AVAIL_STORAGES_ARR < <(pvesm status --content images 2>/dev/null \
  | awk 'NR>1 && $3=="active" {print $1}' || echo "lvm-proxmox")
[[ ${#AVAIL_STORAGES_ARR[@]} -eq 0 ]] && AVAIL_STORAGES_ARR=("lvm-proxmox")

# ── Bridge detection via pvesh (Proxmox-native API) ──────────────────────────
# pvesh returns only Proxmox-managed interfaces — excludes docker0, fwbr*, virbr*
# Each bridge entry has: iface, type=bridge, address, cidr, bridge_vids (VLAN IDs)
declare -A BRIDGE_IP      # bridge → "addr/cidr" or ""
declare -A BRIDGE_SUBNET  # bridge → same as BRIDGE_IP (for suggest_free_ip)
declare -A BRIDGE_VIDS    # bridge → space-separated list of VLAN IDs (empty = not VLAN-aware)

# Expand VLAN range strings like "2-3 10 20-22" → "2 3 10 20 21 22"
_expand_vids() {
  python3 -c "
import sys
result = []
for tok in sys.argv[1].split():
    tok = tok.strip()
    if '-' in tok:
        a, b = tok.split('-', 1)
        result.extend(range(int(a), int(b)+1))
    elif tok.isdigit():
        result.append(int(tok))
print(' '.join(str(x) for x in sorted(set(result))))
" "$1" 2>/dev/null || echo ""
}

# Query pvesh; fall back to ip-link if pvesh unavailable
_pvesh_json=$(pvesh get /nodes/"$PVE_NODE"/network --output-format json 2>/dev/null || echo "[]")

mapfile -t _pvesh_bridges < <(echo "$_pvesh_json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    data = []
for iface in data:
    if iface.get('type') == 'bridge':
        name  = iface.get('iface', '')
        ip    = iface.get('address', '')
        cidr  = iface.get('cidr', '')
        vids  = iface.get('bridge_vids', iface.get('vids', ''))
        addr  = f'{ip}/{cidr}' if ip and cidr else ''
        print(f'{name}|{addr}|{vids}')
")

AVAIL_BRIDGES_ARR=()
for _entry in "${_pvesh_bridges[@]}"; do
  IFS='|' read -r _br _addr _vids <<< "$_entry"
  [[ -z "$_br" ]] && continue
  AVAIL_BRIDGES_ARR+=("$_br")
  BRIDGE_IP[$_br]="$_addr"
  BRIDGE_SUBNET[$_br]="$_addr"
  BRIDGE_VIDS[$_br]="$(_expand_vids "$_vids")"
done

# Fallback: scan ip link for vmbr* bridges if pvesh gave nothing
if [[ ${#AVAIL_BRIDGES_ARR[@]} -eq 0 ]]; then
  while IFS= read -r _br; do
    AVAIL_BRIDGES_ARR+=("$_br")
    _bip=$(ip -o -4 addr show dev "$_br" 2>/dev/null | awk '{print $4}' | head -1)
    BRIDGE_IP[$_br]="${_bip:-}"
    BRIDGE_SUBNET[$_br]="${_bip:-}"
    _vids_raw=$(grep -A5 "iface $_br" /etc/network/interfaces 2>/dev/null \
      | grep 'bridge-vids' | awk '{$1=""; print $0}')
    BRIDGE_VIDS[$_br]="$(_expand_vids "${_vids_raw:-}")"
  done < <(ip link show type bridge 2>/dev/null \
    | awk -F: '/^[0-9]+:/{gsub(/ /,"",$2); print $2}' | grep '^vmbr' | sort)
  [[ ${#AVAIL_BRIDGES_ARR[@]} -eq 0 ]] && AVAIL_BRIDGES_ARR=("vmbr0")
fi

# Identify the management bridge: the one hosting this Proxmox node's own IP
MGMT_GW=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
_MGMT_BRIDGE=""
_MGMT_BRIDGE_IDX=0
for _i in "${!AVAIL_BRIDGES_ARR[@]}"; do
  _br="${AVAIL_BRIDGES_ARR[$_i]}"
  if [[ -n "${BRIDGE_IP[$_br]:-}" ]]; then
    _MGMT_BRIDGE="$_br"
    _MGMT_BRIDGE_IDX=$_i
    break
  fi
done

# Build human-readable labels; management bridge sorted first
BRIDGE_LABELS=()
_sorted_bridges=()
[[ -n "$_MGMT_BRIDGE" ]] && _sorted_bridges+=("$_MGMT_BRIDGE")
for _br in "${AVAIL_BRIDGES_ARR[@]}"; do
  [[ "$_br" == "$_MGMT_BRIDGE" ]] && continue
  _sorted_bridges+=("$_br")
done
AVAIL_BRIDGES_ARR=("${_sorted_bridges[@]}")

for _br in "${AVAIL_BRIDGES_ARR[@]}"; do
  _addr="${BRIDGE_IP[$_br]:-}"
  _vids="${BRIDGE_VIDS[$_br]:-}"
  _label="$_br"
  if [[ -n "$_addr" ]]; then
    _label+=" (${_addr})"
  else
    _label+=" (no IP)"
  fi
  if [[ -n "$_vids" ]]; then
    _label+=" [VLAN-aware: ${_vids// /,}]"
  fi
  [[ "$_br" == "$_MGMT_BRIDGE" ]] && _label+=" [this host]"
  BRIDGE_LABELS+=("$_label")
done

# Build VLAN option list for a given bridge
# Sets global _VLAN_OPTS_ARR
_build_vlan_opts() {
  local _br="$1"
  local _vids="${BRIDGE_VIDS[$_br]:-}"
  _VLAN_OPTS_ARR=("none (untagged)")
  if [[ -n "$_vids" ]]; then
    for _v in $_vids; do
      _VLAN_OPTS_ARR+=("$_v")
    done
  fi
}

# Next free VMID >= 9000
NEXT_VMID=9000
while qm status "$NEXT_VMID" &>/dev/null 2>&1; do (( NEXT_VMID++ )); done


# ── Helper: suggest a free IP in a subnet ──────────────────────────────────────
suggest_free_ip() {
  # suggest_free_ip <cidr> — returns first free IP in .50-.99; shows scan progress
  local _cidr="$1"
  local _base; _base=$(echo "$_cidr" | cut -d/ -f1 | cut -d. -f1-3)
  printf '  Scanning %s.50-%s.99 for a free IP ' "$_base" "$_base"
  for _last in $(seq 50 99); do
    local _ip="${_base}.${_last}"
    printf '.'
    if ! ping -c1 -W1 "$_ip" &>/dev/null; then
      printf ' found: %s\n' "$_ip"
      echo "$_ip"; return
    fi
  done
  printf ' using fallback\n'
  echo "${_base}.50"
}

# ── Interactive Wizard ────────────────────────────────────────────────────────
hdr "VM Settings"

# VMID — just show and confirm
if [[ -z "$VMID" ]]; then
  echo -e "  Next available VM ID: ${B}${NEXT_VMID}${NC}" >/dev/tty
  printf "  %bVM ID [%d]:%b " "${M}" "$NEXT_VMID" "${NC}" >/dev/tty
  IFS= read -r _vmid_in </dev/tty
  VMID="${_vmid_in:-$NEXT_VMID}"
fi

# VM name — default, just confirm
[[ -z "$VM_NAME" ]] && ask VM_NAME "VM name" "infraweaver-init"

# Storage — numbered choice
if [[ -z "$STORAGE" ]]; then
  choose STORAGE "Storage pool:" "${AVAIL_STORAGES_ARR[@]}"
fi

# Resources — sane defaults, just confirm
[[ -z "$CPU"  ]] && ask CPU  "CPU cores" "2"
[[ -z "$MEM"  ]] && ask MEM  "RAM (MB)"  "1024"
[[ -z "$DISK" ]] && ask DISK "Disk (GB)" "8"

hdr "Management Network  (net0 - web UI access)"

# Bridge — management bridge auto-selected as default (first in list = [this host])
if [[ -z "$BRIDGE" ]]; then
  choose _BRIDGE_LABEL "Management bridge:" "${BRIDGE_LABELS[@]}"
  BRIDGE=$(echo "$_BRIDGE_LABEL" | awk '{print $1}')
fi

# VLAN — options derived from the selected bridge's configured VIDs
if [[ "$VLAN_TAG" == "_ask_" ]]; then
  _build_vlan_opts "$BRIDGE"
  if [[ ${#_VLAN_OPTS_ARR[@]} -gt 1 ]]; then
    echo -e "  ${D}Bridge ${BRIDGE} is VLAN-aware with VIDs: ${BRIDGE_VIDS[$BRIDGE]// /,}${NC}" >/dev/tty
    choose _VLAN_CHOICE "VLAN tag for management NIC:" "${_VLAN_OPTS_ARR[@]}"
  else
    echo -e "  ${D}Bridge ${BRIDGE} is not VLAN-aware -- using untagged (no VLAN).${NC}" >/dev/tty
    _VLAN_CHOICE="none (untagged)"
  fi
  if [[ "$_VLAN_CHOICE" == "none (untagged)" || -z "$_VLAN_CHOICE" ]]; then
    VLAN_TAG=""
  else
    VLAN_TAG="$_VLAN_CHOICE"
  fi
fi

# Management IP — DHCP or static with subnet suggestion
if [[ "$VM_IP" == "_ask_" ]]; then
  if askyn "Use DHCP for the management IP?" "Y"; then
    VM_IP=""; VM_GW=""; VM_CIDR=""
  else
    _br_subnet="${BRIDGE_SUBNET[$BRIDGE]:-}"
    _suggested_ip=""
    if [[ -n "$_br_subnet" ]]; then
      log "Scanning for a free IP in ${_br_subnet%/*}/24 (this takes a few seconds)..."
      _suggested_ip=$(suggest_free_ip "$_br_subnet")
    fi
    ask VM_IP  "Static IP address" "${_suggested_ip:-}"
    [[ -z "$VM_CIDR" ]] && ask VM_CIDR "Prefix length" "24"
    [[ -z "$VM_GW"   ]] && ask VM_GW   "Gateway"       "${MGMT_GW:-}"
  fi
fi

hdr "Cluster Network  (net1 - Talos node communication)"
echo -e "  ${D}A second NIC on your Talos node network lets the init VM${NC}"
echo -e "  ${D}discover and configure cluster nodes directly.${NC}"
echo ""

if [[ "$CLUSTER_NIC" == "_ask_" ]]; then
  if askyn "Add a cluster NIC?" "Y"; then CLUSTER_NIC="yes"; else CLUSTER_NIC="no"; fi
fi

if [[ "$CLUSTER_NIC" == "yes" ]]; then
  # Cluster bridge — same list; default to management bridge (usually the only VLAN-aware one)
  if [[ -z "$CLUSTER_BRIDGE" ]]; then
    choose _CBR_LABEL "Cluster bridge:" "${BRIDGE_LABELS[@]}"
    CLUSTER_BRIDGE=$(echo "$_CBR_LABEL" | awk '{print $1}')
  fi

  # Cluster VLAN — options derived from the selected cluster bridge's VIDs
  if [[ -z "$CLUSTER_VLAN" ]]; then
    _build_vlan_opts "$CLUSTER_BRIDGE"
    if [[ ${#_VLAN_OPTS_ARR[@]} -gt 1 ]]; then
      echo -e "  ${D}Bridge ${CLUSTER_BRIDGE} VIDs: ${BRIDGE_VIDS[$CLUSTER_BRIDGE]// /,}${NC}" >/dev/tty
      choose _CVLAN_CHOICE "Cluster VLAN tag (for Talos node traffic):" "${_VLAN_OPTS_ARR[@]}"
    else
      echo -e "  ${D}Bridge ${CLUSTER_BRIDGE} is not VLAN-aware -- cluster NIC will be untagged.${NC}" >/dev/tty
      _CVLAN_CHOICE="none (untagged)"
    fi
    if [[ "$_CVLAN_CHOICE" == "none (untagged)" || -z "$_CVLAN_CHOICE" ]]; then
      CLUSTER_VLAN=""
    else
      CLUSTER_VLAN="$_CVLAN_CHOICE"
    fi
  fi

  if [[ "$CLUSTER_IP" == "_ask_" ]]; then
    if askyn "Use DHCP for the cluster NIC?" "N"; then
      CLUSTER_IP=""; CLUSTER_CIDR=""
    else
      # Suggest a free IP on the cluster bridge subnet
      _cbr_subnet="${BRIDGE_SUBNET[$CLUSTER_BRIDGE]:-}"
      _suggested_cluster_ip=""
      if [[ -n "$_cbr_subnet" ]]; then
        log "Scanning for a free cluster IP in ${_cbr_subnet%/*}/24..."
        _suggested_cluster_ip=$(suggest_free_ip "$_cbr_subnet")
      fi
      [[ -z "$_suggested_cluster_ip" ]] && _suggested_cluster_ip="10.10.0.50"
      ask CLUSTER_IP  "Static IP for cluster NIC" "$_suggested_cluster_ip"
      [[ -z "$CLUSTER_CIDR" ]] && ask CLUSTER_CIDR "Prefix length" "24"
    fi
  fi
fi

hdr "Repository"
[[ -z "$REPO_URL"    ]] && ask REPO_URL    "Git repo URL" \
  "https://github.com/Werewolf-p/InfraWeaver-platform"
[[ -z "$REPO_BRANCH" ]] && ask REPO_BRANCH "Branch"       "main"

hdr "SSH Access"
echo -e "  ${D}Public key injected into the 'iw' user on the VM.${NC}"
echo ""
if [[ -z "$DEPLOYER_SSH_PUBKEY" ]]; then
  ask DEPLOYER_SSH_PUBKEY "SSH public key (paste full key)" ""
  [[ -z "$DEPLOYER_SSH_PUBKEY" ]] && die "An SSH public key is required."
else
  echo -e "  ${G}[OK]${NC} Auto-detected: ${D}${DEPLOYER_SSH_PUBKEY:0:60}...${NC}"
fi

# ── Confirm summary ───────────────────────────────────────────────────────────
echo ""
echo "  +-----------------------------------------------------------+"
echo "  |  SUMMARY                                                  |"
echo "  +-----------------------------------------------------------+"
echo -e "  |  VM ID      : ${B}${VMID}${NC} / ${VM_NAME}"
echo -e "  |  Resources  : ${B}${CPU} CPU / ${MEM} MB RAM / ${DISK} GB${NC}"
echo -e "  |  Storage    : ${B}${STORAGE}${NC}"
echo -e "  |  net0 (mgmt): bridge=${B}${BRIDGE}${NC}${VLAN_TAG:+, VLAN=${VLAN_TAG}} -> ${B}${VM_IP:-DHCP}${NC}"
if [[ "$CLUSTER_NIC" == "yes" ]]; then
  echo -e "  |  net1 (k8s) : bridge=${B}${CLUSTER_BRIDGE}${NC}, VLAN=${B}${CLUSTER_VLAN}${NC} -> ${B}${CLUSTER_IP:-DHCP}${NC}${CLUSTER_CIDR:+/${CLUSTER_CIDR}}"
fi
echo -e "  |  Repo       : ${B}${REPO_URL}${NC} @ ${REPO_BRANCH}"
echo "  +-----------------------------------------------------------+"
echo ""
askyn "Proceed with these settings?" "Y" || die "Aborted."
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
if qm status "$VMID" &>/dev/null; then
  warn "VM $VMID already exists!"
  read -rp "  Destroy and recreate it? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    spin_start "Stopping and destroying VM $VMID"
    qm stop "$VMID" --skiplock 2>/dev/null || true
    sleep 2
    qm destroy "$VMID" --purge --skiplock 2>/dev/null || true
    spin_stop "VM $VMID removed"
  else
    die "Aborting. Use a different --vmid or remove the existing VM."
  fi
fi

echo ""
echo -e "  ${B}Creating your InfraWeaver Init VM -- ${_STEP_TOTAL} steps${NC}"

# ── Download cloud image (cached) ─────────────────────────────────────────────
step "Checking cloud image cache"
if [[ -f "$IMAGE_CACHE" ]]; then
  echo "    Cloud image already cached at $IMAGE_CACHE"
else
  spin_start "Downloading Ubuntu 24.04 cloud image (~500 MB)"
  mkdir -p "$(dirname "$IMAGE_CACHE")"
  spin_stop ""  # stop spinner before wget takes over terminal output
  wget -q --show-progress -O "$IMAGE_CACHE" "$IMAGE_URL" \
    || curl -fL --progress-bar -o "$IMAGE_CACHE" "$IMAGE_URL"
  echo -e "  ${G}[OK]${NC}  Cloud image saved to $IMAGE_CACHE"
fi

# ── Build cloud-init user-data ────────────────────────────────────────────────
step "Generating cloud-init user-data"

USERDATA_FILE="$(mktemp /tmp/iw-userdata-XXXXX.yaml)"

# Build cluster NIC netplan snippet (only if requested)
if [[ "$CLUSTER_NIC" == "yes" ]]; then
  if [[ -n "$CLUSTER_IP" ]]; then
    CLUSTER_NETPLAN_CMD="cat > /etc/netplan/60-cluster.yaml << 'NETPLAN'
network:
  version: 2
  ethernets:
    ens19:
      addresses: [${CLUSTER_IP}/${CLUSTER_CIDR:-24}]
NETPLAN
chmod 600 /etc/netplan/60-cluster.yaml
netplan apply || true"
  else
    CLUSTER_NETPLAN_CMD="cat > /etc/netplan/60-cluster.yaml << 'NETPLAN'
network:
  version: 2
  ethernets:
    ens19:
      dhcp4: true
NETPLAN
chmod 600 /etc/netplan/60-cluster.yaml
netplan apply || true"
  fi
else
  CLUSTER_NETPLAN_CMD="# No cluster NIC configured"
fi

cat > "$USERDATA_FILE" << CLOUDINIT
#cloud-config
hostname: ${VM_NAME}
manage_etc_hosts: true

ssh_pwauth: false

users:
  - name: iw
    groups: [sudo]
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    lock_passwd: true
    ssh_authorized_keys:
      - ${DEPLOYER_SSH_PUBKEY}

package_update: true
package_upgrade: false
packages:
  - python3
  - python3-pip
  - git
  - curl
  - wget
  - jq
  - openssh-server
  - nano
  - qemu-guest-agent

runcmd:
  # Wait for network
  - sleep 5
  # Configure cluster NIC (ens19 / net1) if requested
  - |
    ${CLUSTER_NETPLAN_CMD}
  # Clone the InfraWeaver repository
  - GIT_TERMINAL_PROMPT=0 git clone --branch ${REPO_BRANCH} --depth=1 ${REPO_URL} /opt/infraweaver 2>&1 | tee /var/log/iw-clone.log
  - chown -R iw:iw /opt/infraweaver
  # Install Python dependencies for the init server
  - pip3 install --quiet --break-system-packages 2>/dev/null || pip3 install --quiet || true
  # Create systemd service for the init web server
  - |
    cat > /etc/systemd/system/iw-init.service << 'SVC'
    [Unit]
    Description=InfraWeaver Init Web Server
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=iw
    WorkingDirectory=/opt/infraweaver
    ExecStart=/usr/bin/python3 scripts/init/server.py
    Restart=on-failure
    RestartSec=5
    Environment=IW_REPO_DIR=/opt/infraweaver

    [Install]
    WantedBy=multi-user.target
    SVC
  - systemctl daemon-reload
  - systemctl enable iw-init
  - systemctl start iw-init
  # Print IP and access URL to console
  - sleep 3
  - |
    IP=$(hostname -I | awk '{print $1}')
    echo ""
    echo "+==============================================================+"
    echo "| InfraWeaver Init VM is ready!                              |"
    echo "|                                                             |"
    echo "| Web UI -> http://\${IP}:8080                                |"
    echo "| Login  -> iw / infraweaver                                 |"
    echo "+==============================================================+"
    echo ""
  - echo "iw-init ready" > /var/lib/cloud/instance/init-done

final_message: "InfraWeaver init VM ready. Access web UI at http://DHCP-IP:8080"
CLOUDINIT

log "Cloud-init user-data written to $USERDATA_FILE"

# ── Create VM ──────────────────────────────────────────────────────────────────
step "Creating VM configuration"
spin_start "Running qm create $VMID"

qm create "$VMID" \
  --name "$VM_NAME" \
  --memory "$MEM" \
  --cores "$CPU" \
  --sockets 1 \
  --cpu host \
  --ostype l26 \
  --boot c \
  --bootdisk scsi0 \
  --scsihw virtio-scsi-pci \
  --agent enabled=1 \
  --serial0 socket \
  --vga serial0 \
  --onboot 1 \
  --tablet 0 \
  --description "InfraWeaver Init VM - web UI at :8080"

# Set management network (net0)
NET_OPTS="virtio,bridge=${BRIDGE}"
[[ -n "$VLAN_TAG" ]] && NET_OPTS="${NET_OPTS},tag=${VLAN_TAG}"
qm set "$VMID" --net0 "$NET_OPTS"

# Set cluster network (net1) — only if requested
if [[ "$CLUSTER_NIC" == "yes" ]]; then
  CLUSTER_NET_OPTS="virtio,bridge=${CLUSTER_BRIDGE:-$BRIDGE},tag=${CLUSTER_VLAN}"
  qm set "$VMID" --net1 "$CLUSTER_NET_OPTS"
fi
spin_stop "VM $VMID configured"

# ── Import disk ──────────────────────────────────────────────────────────────
step "Importing disk image to storage $STORAGE"
spin_start "Importing disk (this may take 15-30s)"
qm importdisk "$VMID" "$IMAGE_CACHE" "$STORAGE" --format raw &>/dev/null
qm set "$VMID" --scsi0 "${STORAGE}:vm-${VMID}-disk-0,size=${DISK}G"
qm resize "$VMID" scsi0 "${DISK}G" 2>/dev/null || true
spin_stop "Disk imported and resized to ${DISK}G"

# ── Cloud-init drive ─────────────────────────────────────────────────────────
step "Writing cloud-init configuration"
spin_start "Attaching cloud-init drive"
qm set "$VMID" --ide2 "${STORAGE}:cloudinit"
qm set "$VMID" --cicustom "user=local:snippets/iw-init-${VMID}.yaml"

# Copy user-data to Proxmox snippets
mkdir -p /var/lib/vz/snippets
cp "$USERDATA_FILE" "/var/lib/vz/snippets/iw-init-${VMID}.yaml"
rm -f "$USERDATA_FILE"

# Set static IP or DHCP
if [[ -n "$VM_IP" ]]; then
  qm set "$VMID" --ipconfig0 "ip=${VM_IP}/${VM_CIDR},gw=${VM_GW}"
else
  qm set "$VMID" --ipconfig0 "ip=dhcp"
fi

qm set "$VMID" --nameserver "8.8.8.8 1.1.1.1"
qm set "$VMID" --searchdomain "local"
spin_stop "Cloud-init configured"

# ── Start VM ──────────────────────────────────────────────────────────────────
step "Starting VM"
spin_start "Sending start command to VM $VMID"
qm start "$VMID"
spin_stop "VM $VMID started"

# ── Wait for IP ───────────────────────────────────────────────────────────────
step "Waiting for VM to come online"
echo ""
VM_IP_FINAL=""
_WAIT_SECS=90
_ELAPSED=0
printf '  Waiting for guest agent IP  (timeout %ds)\n' "$_WAIT_SECS"
while (( _ELAPSED < _WAIT_SECS )); do
  sleep 5; _ELAPSED=$((_ELAPSED+5))
  # Draw a simple progress bar: filled with # based on time
  _pct=$(( _ELAPSED * 30 / _WAIT_SECS ))
  _bar=$(printf '#%.0s' $(seq 1 $_pct))
  printf '\r  [%-30s] %3ds ' "$_bar" "$_ELAPSED"
  AGENT_IP=$(qm guest exec "$VMID" -- hostname -I 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('out-data','').strip().split()[0] if d.get('out-data') else '')" 2>/dev/null || true)
  if [[ -n "$AGENT_IP" ]] && [[ "$AGENT_IP" != "127.0.0.1" ]]; then
    VM_IP_FINAL="$AGENT_IP"
    printf '\r  [%-30s] found! -> %s\n' "##############################" "$VM_IP_FINAL"
    break
  fi
done
[[ -z "$VM_IP_FINAL" ]] && printf '\r  [%-30s] timeout, using static config\n' "##############################"

if [[ -z "$VM_IP_FINAL" ]] && [[ -n "$VM_IP" ]]; then
  VM_IP_FINAL="$VM_IP"
fi

step "All done!"
echo ""
# Wait a moment, then display the ready banner with a brief animated reveal
sleep 0.2
echo -e "${G}${B}+===============================================================+${NC}"
sleep 0.05
echo -e "${G}${B}  InfraWeaver Init VM is starting up!${NC}"
echo ""
sleep 0.05
if [[ -n "$VM_IP_FINAL" ]]; then
  echo -e "  Web UI  ->  ${C}${B}http://${VM_IP_FINAL}:8080${NC}"
  echo -e "  SSH     ->  ${C}ssh iw@${VM_IP_FINAL}${NC}  (password: infraweaver)"
else
  echo -e "  Web UI  ->  ${C}${B}http://<vm-ip>:8080${NC}  (check Proxmox DHCP for IP)"
fi
echo ""
sleep 0.05
echo -e "  The init server will be ready in ~60 seconds."
echo -e "  Open the web UI, fill in your .env values, then click Deploy."
echo ""
sleep 0.05
echo -e "  ${Y}Alternative (no web UI):${NC}"
echo -e "  SSH into the VM and run:"
echo -e "  ${C}  cp /opt/infraweaver/.env.example /opt/infraweaver/.env && \\"
echo -e "     nano /opt/infraweaver/.env && \\"
echo -e "     bash /opt/infraweaver/scripts/deploy-local.sh${NC}"
echo ""
sleep 0.05
echo -e "${G}${B}+===============================================================+${NC}"
echo ""
