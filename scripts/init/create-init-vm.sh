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

# ── Hardcoded non-interactive defaults ───────────────────────────────────────
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
echo ""
echo -e "${C}${B}"
echo "  +==============================================================+"
echo "  |          InfraWeaver -- Init VM Deployer                    |"
echo "  |          Creates a lightweight bootstrap VM on Proxmox      |"
echo "  +==============================================================+"
echo -e "${NC}"
echo -e "  ${D}This wizard will create a small Ubuntu VM that hosts the${NC}"
echo -e "  ${D}InfraWeaver web UI and deploys your Kubernetes cluster.${NC}"
echo ""

# ── Pre-flight (must run on Proxmox) ─────────────────────────────────────────
command -v qm &>/dev/null || die "This script must run on a Proxmox VE host (qm not found)"

# ── Auto-detect Proxmox environment ──────────────────────────────────────────

# Available storages that can hold VM images
mapfile -t AVAIL_STORAGES_ARR < <(pvesm status --content images 2>/dev/null \
  | awk 'NR>1 && $3=="active" {print $1}' || echo "lvm-proxmox")
[[ ${#AVAIL_STORAGES_ARR[@]} -eq 0 ]] && AVAIL_STORAGES_ARR=("lvm-proxmox")

# Available bridges with IP/subnet info for display
mapfile -t AVAIL_BRIDGES_ARR < <(ip link show type bridge 2>/dev/null \
  | awk -F: '/^[0-9]+:/{gsub(/ /,"",$2); print $2}' | sort)
[[ ${#AVAIL_BRIDGES_ARR[@]} -eq 0 ]] && AVAIL_BRIDGES_ARR=("vmbr0")

# Build human-readable bridge labels: "vmbr0 (10.25.0.1/24)" or "vmbr0 (no IP)"
declare -A BRIDGE_SUBNET    # bridge → subnet CIDR (for IP suggestion)
BRIDGE_LABELS=()
for _br in "${AVAIL_BRIDGES_ARR[@]}"; do
  _bip=$(ip -o -4 addr show dev "$_br" 2>/dev/null | awk '{print $4}' | head -1)
  if [[ -n "$_bip" ]]; then
    BRIDGE_LABELS+=("${_br} (${_bip})")
    BRIDGE_SUBNET[$_br]="$_bip"
  else
    BRIDGE_LABELS+=("${_br} (no IP)")
    BRIDGE_SUBNET[$_br]=""
  fi
done

# VLANs defined in /etc/network/interfaces — extract unique VLAN IDs
mapfile -t AVAIL_VLANS_ARR < <(grep -oP 'vlan-id \K[0-9]+' /etc/network/interfaces 2>/dev/null \
  | sort -un)
# Also detect from VLAN sub-interfaces (e.g. vmbr0.3)
mapfile -t _extra_vlans < <(ip -d link show 2>/dev/null \
  | awk '/802.1Q.*id [0-9]/{match($0,/id ([0-9]+)/,a); print a[1]}' | sort -un)
for v in "${_extra_vlans[@]}"; do
  [[ ! " ${AVAIL_VLANS_ARR[*]} " =~ " $v " ]] && AVAIL_VLANS_ARR+=("$v")
done
# Common VLAN options to always offer
for v in 1 2 3 10 20 100; do
  [[ ! " ${AVAIL_VLANS_ARR[*]} " =~ " $v " ]] && AVAIL_VLANS_ARR+=("$v")
done
mapfile -t AVAIL_VLANS_ARR < <(printf '%s\n' "${AVAIL_VLANS_ARR[@]}" | sort -n)
VLAN_OPTS=("none (untagged)" "${AVAIL_VLANS_ARR[@]}")

# Management network (default route interface)
MGMT_GW=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
MGMT_IFACE=$(ip route 2>/dev/null | awk '/^default/{print $5; exit}')

# Next free VMID ≥ 9000
NEXT_VMID=9000
while qm status "$NEXT_VMID" &>/dev/null 2>&1; do (( NEXT_VMID++ )); done

# ── Helper: suggest a free IP in a subnet ──────────────────────────────────────
suggest_free_ip() {
  # suggest_free_ip <cidr>  e.g. "10.10.0.1/24"
  # Returns an IP in the .50-.99 range that does not respond to ping
  local _cidr="$1"
  local _base; _base=$(echo "$_cidr" | cut -d/ -f1 | cut -d. -f1-3)
  for _last in $(seq 50 99); do
    local _ip="${_base}.${_last}"
    if ! ping -c1 -W1 "$_ip" &>/dev/null; then
      echo "$_ip"; return
    fi
  done
  echo "${_base}.50"  # fallback
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

hdr "Management Network  (net0 — web UI access)"

# Bridge — numbered choice with IP info
if [[ -z "$BRIDGE" ]]; then
  choose _BRIDGE_LABEL "Management bridge:" "${BRIDGE_LABELS[@]}"
  BRIDGE=$(echo "$_BRIDGE_LABEL" | awk '{print $1}')
fi

# VLAN — numbered choice (none or detected VLANs)
if [[ "$VLAN_TAG" == "_ask_" ]]; then
  choose _VLAN_CHOICE "VLAN tag:" "${VLAN_OPTS[@]}"
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

hdr "Cluster Network  (net1 — Talos node communication)"
echo -e "  ${D}A second NIC on your Talos node network lets the init VM${NC}"
echo -e "  ${D}discover and configure cluster nodes directly.${NC}"
echo ""

if [[ "$CLUSTER_NIC" == "_ask_" ]]; then
  if askyn "Add a cluster NIC?" "Y"; then CLUSTER_NIC="yes"; else CLUSTER_NIC="no"; fi
fi

if [[ "$CLUSTER_NIC" == "yes" ]]; then
  # Cluster bridge — numbered choice
  if [[ -z "$CLUSTER_BRIDGE" ]]; then
    choose _CBR_LABEL "Cluster bridge:" "${BRIDGE_LABELS[@]}"
    CLUSTER_BRIDGE=$(echo "$_CBR_LABEL" | awk '{print $1}')
  fi

  # Cluster VLAN — numbered choice
  if [[ -z "$CLUSTER_VLAN" ]]; then
    choose _CVLAN_CHOICE "Cluster VLAN tag:" "${VLAN_OPTS[@]}"
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
  echo -e "  ${G}✓${NC} Auto-detected: ${D}${DEPLOYER_SSH_PUBKEY:0:60}...${NC}"
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
    log "Stopping and destroying VM $VMID..."
    qm stop "$VMID" --skiplock 2>/dev/null || true
    sleep 2
    qm destroy "$VMID" --purge --skiplock 2>/dev/null || true
    ok "VM $VMID destroyed"
  else
    die "Aborting. Use a different --vmid or remove the existing VM."
  fi
fi

# ── Download cloud image (cached) ─────────────────────────────────────────────
if [[ -f "$IMAGE_CACHE" ]]; then
  ok "Cloud image already cached at $IMAGE_CACHE"
else
  log "Downloading Ubuntu 24.04 cloud image..."
  mkdir -p "$(dirname "$IMAGE_CACHE")"
  wget -q --show-progress -O "$IMAGE_CACHE" "$IMAGE_URL" \
    || curl -fL --progress-bar -o "$IMAGE_CACHE" "$IMAGE_URL"
  ok "Cloud image downloaded"
fi

# ── Build cloud-init user-data ────────────────────────────────────────────────
log "Generating cloud-init user-data..."

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
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  InfraWeaver Init VM is ready!                              ║"
    echo "║                                                              ║"
    echo "║  Web UI → http://\${IP}:8080                    ║"
    echo "║  Login  → iw / infraweaver                                  ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
  - echo "iw-init ready" > /var/lib/cloud/instance/init-done

final_message: "InfraWeaver init VM ready. Access web UI at http://DHCP-IP:8080"
CLOUDINIT

log "Cloud-init user-data written to $USERDATA_FILE"

# ── Create VM ──────────────────────────────────────────────────────────────────
log "Creating VM $VMID ($VM_NAME)..."

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
  --description "InfraWeaver Init VM — web UI at :8080"

# Set management network (net0)
NET_OPTS="virtio,bridge=${BRIDGE}"
[[ -n "$VLAN_TAG" ]] && NET_OPTS="${NET_OPTS},tag=${VLAN_TAG}"
qm set "$VMID" --net0 "$NET_OPTS"

# Set cluster network (net1) — only if requested
if [[ "$CLUSTER_NIC" == "yes" ]]; then
  CLUSTER_NET_OPTS="virtio,bridge=${CLUSTER_BRIDGE:-$BRIDGE},tag=${CLUSTER_VLAN}"
  qm set "$VMID" --net1 "$CLUSTER_NET_OPTS"
  log "Cluster NIC (net1): bridge=${CLUSTER_BRIDGE:-$BRIDGE} VLAN=${CLUSTER_VLAN} IP=${CLUSTER_IP:-DHCP}"
fi

# Import cloud image disk
log "Importing disk image to storage $STORAGE..."
qm importdisk "$VMID" "$IMAGE_CACHE" "$STORAGE" --format raw 2>&1 | tail -3
qm set "$VMID" --scsi0 "${STORAGE}:vm-${VMID}-disk-0,size=${DISK}G"

# Resize disk to requested size
qm resize "$VMID" scsi0 "${DISK}G" 2>/dev/null || true

# Cloud-init drive
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

ok "VM $VMID created"

# ── Start VM ──────────────────────────────────────────────────────────────────
log "Starting VM $VMID..."
qm start "$VMID"

echo ""
log "Waiting for VM to boot and start init server (this takes ~60s)..."

# Wait for VM to get an IP (max 90s)
VM_IP_FINAL=""
for i in $(seq 1 18); do
  sleep 5
  AGENT_IP=$(qm guest exec "$VMID" -- hostname -I 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('out-data','').strip().split()[0] if d.get('out-data') else '')" 2>/dev/null || true)
  if [[ -n "$AGENT_IP" ]] && [[ "$AGENT_IP" != "127.0.0.1" ]]; then
    VM_IP_FINAL="$AGENT_IP"
    break
  fi
  echo "  Waiting for IP... ($i/18)"
done

if [[ -z "$VM_IP_FINAL" ]] && [[ -n "$VM_IP" ]]; then
  VM_IP_FINAL="$VM_IP"
fi

echo ""
echo -e "${G}${B}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${G}${B}  ✅ InfraWeaver Init VM is starting up!${NC}"
echo ""
if [[ -n "$VM_IP_FINAL" ]]; then
  echo -e "  🌐 Web UI   → ${C}${B}http://${VM_IP_FINAL}:8080${NC}"
  echo -e "  🔑 SSH      → ${C}ssh iw@${VM_IP_FINAL}${NC} (password: infraweaver)"
else
  echo -e "  🌐 Web UI   → ${C}${B}http://<vm-ip>:8080${NC} (check Proxmox DHCP for IP)"
fi
echo ""
echo -e "  The init server will be ready in ~60 seconds."
echo -e "  Open the web UI, fill in your .env values, then click Deploy."
echo ""
echo -e "  ${Y}Alternative (no web UI):${NC}"
echo -e "  SSH into the VM and run:"
echo -e "  ${C}  cp /opt/infraweaver/.env.example /opt/infraweaver/.env"
echo -e "  nano /opt/infraweaver/.env${NC}"
echo -e "  ${C}  bash /opt/infraweaver/scripts/deploy-local.sh${NC}"
echo -e "${G}${B}═══════════════════════════════════════════════════════════════${NC}"
echo ""
