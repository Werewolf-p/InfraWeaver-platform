# =============================================================================
# NetBird Routing Peer VMs
#
# Creates lightweight Ubuntu VMs on VLAN3 that run the NetBird client as
# routing peers. Each VM:
#   - Lives exclusively on VLAN3 (vmbr0, tag 3) with a static IP
#   - Has IP forwarding enabled (net.ipv4.ip_forward=1)
#   - Runs the NetBird client joined to the management server
#
# When the NetBird client starts, it picks up the routes assigned to the
# "routing-peers-vlan3" peer group (configured in the bootstrap job) and sets
# up iptables MASQUERADE rules. Other VPN peers then route 10.10.0.0/24
# traffic through this VM.
#
# Traffic flow for VPN clients accessing *.int.rlservers.com:
#   Client → WireGuard tunnel → routing peer (10.10.0.10)
#   → masquerade → Traefik (10.10.0.200) → backend service
#   Traefik sees source IP = 10.10.0.10 (the routing peer)
# =============================================================================

locals {
  ssh_opts = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o ServerAliveInterval=15 -i ${var.proxmox_ssh_private_key_file}"
}

# ---------------------------------------------------------------------------
# Stage 1: Create VM on Proxmox
# ---------------------------------------------------------------------------
resource "null_resource" "create_vm" {
  for_each = var.netbird_routers

  triggers = {
    router_hash = sha256(jsonencode(each.value))
    proxmox_ip  = var.proxmox_node_ip
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      PVE_IP="${var.proxmox_node_ip}"
      VMID="${each.value.vm_id}"
      TEMPLATE="${each.value.template_vm_id}"
      ROUTER_IP="${each.value.ip}"
      GATEWAY="${each.value.gateway}"
      CORES="${each.value.cores}"
      MEMORY="${each.value.memory_mb}"
      DISK="${each.value.disk_size_gb}"
      STORAGE="${each.value.storage}"
      SUBNET_MASK="${each.value.subnet_mask}"
      KEYFILE="/tmp/netbird-router-keys-${each.value.vm_id}.pub"

      echo "==> NetBird router VM $VMID — connecting to Proxmox $PVE_IP..."
      for attempt in $(seq 1 12); do
        ssh $SSH_OPTS root@"$PVE_IP" true 2>/dev/null && break
        [ "$attempt" -eq 12 ] && echo "ERROR: cannot reach $PVE_IP" >&2 && exit 1
        echo "  Waiting for Proxmox SSH (attempt $attempt/12)..."
        sleep 10
      done

      # Inner script uses positional params ($1..$9) to avoid $${VAR} interpolation issues
      cat > /tmp/create-nb-router-${each.key}.sh << 'VM_SCRIPT'
#!/bin/bash
set -euo pipefail
VMID=$1; TEMPLATE=$2; ROUTER_IP=$3; GATEWAY=$4
CORES=$5; MEMORY=$6; DISK_GB=$7; STORAGE=$8; SUBNET_MASK=$9

echo "  Checking VM $VMID..."
VM_STATUS=$(qm status "$VMID" 2>/dev/null | awk '{print $2}' || echo "")
if [ -n "$VM_STATUS" ]; then
  echo "  VM $VMID already exists (status: $VM_STATUS) — ensuring it's running"
  [ "$VM_STATUS" != "running" ] && qm start "$VMID" 2>/dev/null || true
else
  echo "  Cloning template $TEMPLATE → VM $VMID (netbird-router-vlan3)..."
  qm clone "$TEMPLATE" "$VMID" \
    --name "netbird-router-vlan3" \
    --full 1 \
    --storage "$STORAGE"

  echo "  Configuring VM hardware (VLAN3-only, no VLAN2)..."
  qm set "$VMID" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --cpu host \
    --onboot 1 \
    --net0 "virtio,bridge=vmbr0,tag=3"

  echo "  Configuring cloud-init..."
  qm set "$VMID" \
    --ipconfig0 "ip=$ROUTER_IP/$SUBNET_MASK,gw=$GATEWAY" \
    --nameserver "8.8.8.8 1.1.1.1" \
    --ciuser ubuntu \
    --ciupgrade 0

  if [ -f "/tmp/netbird-router-keys-$VMID.pub" ]; then
    echo "  Setting SSH keys..."
    qm set "$VMID" --sshkeys "/tmp/netbird-router-keys-$VMID.pub"
  fi

  echo "  Resizing disk to $DISK_GB G..."
  qm resize "$VMID" scsi0 "$DISK_GB"G 2>/dev/null || true

  echo "  Starting VM..."
  qm start "$VMID"
fi

echo "  Waiting for SSH port on $ROUTER_IP..."
for i in $(seq 1 30); do
  bash -c "echo >/dev/tcp/$ROUTER_IP/22" 2>/dev/null && echo "  SSH port open!" && exit 0
  [ "$i" -eq 30 ] && echo "ERROR: SSH port never opened on $ROUTER_IP" >&2 && exit 1
  sleep 10
done
VM_SCRIPT

      # SCP SSH public keys for cloud-init
      KEYS_FILE=$(mktemp)
%{for key in var.router_ssh_keys~}
      echo "${key}" >> "$KEYS_FILE"
%{endfor~}
      scp $SSH_OPTS "$KEYS_FILE" root@"$PVE_IP":"$KEYFILE"
      rm -f "$KEYS_FILE"

      # SCP and execute creation script (values passed as positional args)
      scp $SSH_OPTS /tmp/create-nb-router-${each.key}.sh root@"$PVE_IP":/tmp/create-nb-router-${each.key}.sh
      ssh $SSH_OPTS root@"$PVE_IP" "chmod +x /tmp/create-nb-router-${each.key}.sh && \
        /tmp/create-nb-router-${each.key}.sh \
          '$VMID' '$TEMPLATE' '$ROUTER_IP' '$GATEWAY' \
          '$CORES' '$MEMORY' '$DISK' '$STORAGE' '$SUBNET_MASK' && \
        rm -f /tmp/create-nb-router-${each.key}.sh $KEYFILE"
      rm -f /tmp/create-nb-router-${each.key}.sh

      echo "==> VM $VMID created, SSH port open on $ROUTER_IP"
    BASH
  }
}

# ---------------------------------------------------------------------------
# Stage 2: Install and configure NetBird on the VM
# ---------------------------------------------------------------------------
resource "null_resource" "configure" {
  for_each = var.netbird_routers

  depends_on = [null_resource.create_vm]

  triggers = {
    router_hash    = sha256(jsonencode(each.value))
    setup_key_hash = sha256(var.netbird_setup_key)
    mgmt_url       = var.netbird_management_url
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      ROUTER_IP="${each.value.ip}"

      echo "==> Configuring NetBird router at $ROUTER_IP..."

      # Wait for SSH to be ready
      echo "  Waiting for SSH on $ROUTER_IP..."
      for attempt in $(seq 1 30); do
        if ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "true" 2>/dev/null; then
          break
        fi
        [ "$attempt" -eq 30 ] && echo "ERROR: cannot SSH to $ROUTER_IP" >&2 && exit 1
        sleep 10
      done
      ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "sudo cloud-init status --wait 2>/dev/null || true" 2>/dev/null || true

      # Write setup script — SETUP_EOF is not single-quoted so Terraform expands $${var.*}
      # Use \$() and \$VAR to prevent local shell from expanding (they run on the remote VM)
      cat > /tmp/nb-router-setup-${each.key}.sh << SETUP_EOF
#!/bin/bash
set -euo pipefail
SETUP_KEY='${var.netbird_setup_key}'
MGMT_URL='${var.netbird_management_url}'

echo "--- Enable IP forwarding ---"
grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null || echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -w net.ipv4.ip_forward=1
echo "IP forwarding enabled"

echo "--- Persistent MASQUERADE for VPN routing ---"
sudo tee /etc/systemd/system/netbird-masq.service > /dev/null << 'MASQ_EOF'
[Unit]
Description=NetBird MASQUERADE rules for VPN routing
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'iptables -t nat -C POSTROUTING -s 100.64.0.0/10 ! -d 100.64.0.0/10 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 100.64.0.0/10 ! -d 100.64.0.0/10 -j MASQUERADE'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
MASQ_EOF
sudo systemctl daemon-reload
sudo systemctl enable --now netbird-masq.service
echo "MASQUERADE service enabled"

echo "--- Install NetBird ---"
if ! command -v netbird &>/dev/null; then
  curl -fsSL https://pkgs.netbird.io/install.sh | sudo bash
else
  echo "NetBird already installed"
fi

echo "--- Enable NetBird service ---"
sudo systemctl enable netbird

echo "--- Join NetBird management ---"
sudo netbird down 2>/dev/null || true
sudo netbird up \
  --management-url "\$MGMT_URL" \
  --setup-key "\$SETUP_KEY" \
  --interface-name wt0 \
  2>&1 || true

echo "--- Wait for NetBird connection ---"
for i in \$(seq 1 12); do
  STATUS=\$(sudo netbird status 2>/dev/null | grep -i "Management.*Connected\|Status:.*Connected" || echo "")
  if [ -n "\$STATUS" ]; then
    echo "NetBird connected: \$STATUS"
    break
  fi
  echo "  Waiting (attempt \$i/12)..."
  sleep 10
done

echo "--- Install NetBird reconnect watchdog ---"
# Watchdog: if management disconnects (e.g. after cluster redeploy wipes DB),
# automatically re-enroll using the setup key so routing resumes without manual intervention.
sudo tee /usr/local/bin/netbird-reconnect.sh > /dev/null << 'WATCHDOG_EOF'
#!/bin/bash
# Re-enroll NetBird if management is disconnected
MGMT_URL="MGMT_URL_PLACEHOLDER"
SETUP_KEY="SETUP_KEY_PLACEHOLDER"
CHECK_INTERVAL=60

while true; do
  sleep $CHECK_INTERVAL
  STATUS=$(netbird status 2>/dev/null | grep -i "Management.*Connected" || echo "")
  if [ -z "$STATUS" ]; then
    logger -t netbird-watchdog "Management disconnected, attempting re-enroll..."
    netbird down 2>/dev/null || true
    sleep 3
    netbird up --management-url "$MGMT_URL" --setup-key "$SETUP_KEY" --interface-name wt0 2>&1 | logger -t netbird-watchdog || true
    sleep 30
  fi
done
WATCHDOG_EOF
sudo chmod +x /usr/local/bin/netbird-reconnect.sh
sudo sed -i "s|MGMT_URL_PLACEHOLDER|\$MGMT_URL|g" /usr/local/bin/netbird-reconnect.sh
sudo sed -i "s|SETUP_KEY_PLACEHOLDER|\$SETUP_KEY|g" /usr/local/bin/netbird-reconnect.sh

sudo tee /etc/systemd/system/netbird-watchdog.service > /dev/null << 'SVC_EOF'
[Unit]
Description=NetBird management reconnect watchdog
After=netbird.service
Requires=netbird.service

[Service]
ExecStart=/usr/local/bin/netbird-reconnect.sh
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
SVC_EOF
sudo systemctl daemon-reload
sudo systemctl enable --now netbird-watchdog.service
echo "NetBird watchdog service enabled"

echo "--- NetBird status ---"
sudo netbird status 2>/dev/null || true
echo "--- Setup complete ---"
SETUP_EOF

      scp $SSH_OPTS /tmp/nb-router-setup-${each.key}.sh ubuntu@"$ROUTER_IP":/tmp/nb-router-setup.sh
      ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "chmod +x /tmp/nb-router-setup.sh && sudo /tmp/nb-router-setup.sh && rm -f /tmp/nb-router-setup.sh"
      rm -f /tmp/nb-router-setup-${each.key}.sh

      echo "==> NetBird router $ROUTER_IP configured"
    BASH
  }
}
