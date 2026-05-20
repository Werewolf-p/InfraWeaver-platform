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

# ── Defaults (override via args or env) ──────────────────────────────────────
VMID="${IW_VMID:-9001}"
VM_NAME="${IW_VM_NAME:-infraweaver-init}"
STORAGE="${IW_STORAGE:-lvm-proxmox}"
BRIDGE="${IW_BRIDGE:-vmbr0}"
VLAN_TAG="${IW_VLAN_TAG:-}"          # leave empty for no VLAN tag
VM_IP="${IW_VM_IP:-}"                # leave empty for DHCP
VM_GW="${IW_VM_GW:-}"
VM_CIDR="${IW_VM_CIDR:-24}"
REPO_URL="${IW_REPO_URL:-https://github.com/your-org/your-repo}"
REPO_BRANCH="${IW_REPO_BRANCH:-main}"
IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
IMAGE_CACHE="/var/lib/vz/template/iso/ubuntu-24.04-cloud.img"
CPU="${IW_CPU:-2}"
MEM="${IW_MEM:-1024}"
DISK="${IW_DISK:-8}"
# SSH public key to inject into the iw user (for remote access)
# Auto-detects from common locations if not set via IW_SSH_PUBKEY
if [[ -n "${IW_SSH_PUBKEY:-}" ]]; then
  DEPLOYER_SSH_PUBKEY="$IW_SSH_PUBKEY"
elif [[ -f /root/.ssh/id_ed25519.pub ]]; then
  DEPLOYER_SSH_PUBKEY="$(cat /root/.ssh/id_ed25519.pub)"
elif [[ -f /root/.ssh/id_rsa.pub ]]; then
  DEPLOYER_SSH_PUBKEY="$(cat /root/.ssh/id_rsa.pub)"
elif [[ -f /root/.ssh/authorized_keys ]]; then
  DEPLOYER_SSH_PUBKEY="$(head -1 /root/.ssh/authorized_keys)"
else
  DEPLOYER_SSH_PUBKEY="ssh-ed25519 AAAA# no-key-found"
fi

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --vmid)       VMID="$2"; shift 2 ;;
    --storage)    STORAGE="$2"; shift 2 ;;
    --bridge)     BRIDGE="$2"; shift 2 ;;
    --vlan)       VLAN_TAG="$2"; shift 2 ;;
    --ip)         VM_IP="$2"; shift 2 ;;
    --gw)         VM_GW="$2"; shift 2 ;;
    --repo)       REPO_URL="$2"; shift 2 ;;
    --branch)     REPO_BRANCH="$2"; shift 2 ;;
    --cpu)        CPU="$2"; shift 2 ;;
    --mem)        MEM="$2"; shift 2 ;;
    --disk)       DISK="$2"; shift 2 ;;
    --ssh-pubkey) DEPLOYER_SSH_PUBKEY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; NC='\033[0m'; B='\033[1m'
log()  { echo -e "${G}▶${NC} $*"; }
warn() { echo -e "${Y}⚠${NC} $*"; }
die()  { echo -e "${R}✗${NC} $*" >&2; exit 1; }
ok()   { echo -e "${G}✅${NC} $*"; }

echo ""
echo -e "${C}${B}"
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║          InfraWeaver — Init VM Deployer                     ║"
echo "  ║          Creates a lightweight bootstrap VM on Proxmox      ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  VM ID    : ${B}${VMID}${NC}"
echo -e "  VM Name  : ${B}${VM_NAME}${NC}"
echo -e "  Storage  : ${B}${STORAGE}${NC}"
echo -e "  Bridge   : ${B}${BRIDGE}${NC}${VLAN_TAG:+ (VLAN ${VLAN_TAG})}"
echo -e "  Resources: ${B}${CPU} CPU / ${MEM}MB RAM / ${DISK}GB disk${NC}"
echo -e "  Repo     : ${B}${REPO_URL}${NC} @ ${REPO_BRANCH}"
echo -e "  IP       : ${B}${VM_IP:-DHCP}${NC}"
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
command -v qm &>/dev/null || die "This script must run on a Proxmox VE host (qm not found)"

# Check VMID is not in use
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

# Build network config string
if [[ -n "$VM_IP" ]]; then
  STATIC_IP_BLOCK="
    - type: static
      address: ${VM_IP}/${VM_CIDR}
      gateway: ${VM_GW}"
else
  STATIC_IP_BLOCK="
    - type: dhcp"
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

# Set network
NET_OPTS="virtio,bridge=${BRIDGE}"
[[ -n "$VLAN_TAG" ]] && NET_OPTS="${NET_OPTS},tag=${VLAN_TAG}"
qm set "$VMID" --net0 "$NET_OPTS"

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
