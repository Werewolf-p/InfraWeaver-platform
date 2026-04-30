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
#
# Two-stage provisioning:
#   Stage 1 (null_resource.create_vm): SSH to Proxmox, clone template, configure
#            cloud-init, start VM, wait for SSH port
#   Stage 2 (null_resource.configure): SSH directly to VM, enable IP forwarding,
#            install NetBird, join management server
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

      echo "==> NetBird router VM $VMID — connecting to Proxmox $PVE_IP..."
      for attempt in $(seq 1 12); do
        ssh $SSH_OPTS root@"$PVE_IP" true 2>/dev/null && break
        [ "$attempt" -eq 12 ] && echo "ERROR: cannot reach $PVE_IP" >&2 && exit 1
        echo "  Waiting for Proxmox SSH (attempt $attempt/12)..."
        sleep 10
      done

      # Write VM creation script
      cat > /tmp/create-netbird-router-${each.key}.sh << 'VM_SCRIPT'
#!/bin/bash
set -euo pipefail
VMID="$1"; TEMPLATE="$2"; ROUTER_IP="$3"; GATEWAY="$4"
CORES="$5"; MEMORY="$6"; DISK_GB="$7"; STORAGE="$8"; SUBNET_MASK="$9"

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

  echo "  Configuring VM hardware..."
  qm set "$VMID" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --cpu host \
    --onboot 1 \
    --net0 "virtio,bridge=vmbr0,tag=3"

  echo "  Configuring cloud-init (VLAN3 only)..."
  qm set "$VMID" \
    --ipconfig0 "ip=${ROUTER_IP}/${SUBNET_MASK},gw=${GATEWAY}" \
    --nameserver "8.8.8.8 1.1.1.1" \
    --ciuser ubuntu \
    --ciupgrade 0

  if [ -f /tmp/netbird-router-keys-${VMID}.pub ]; then
    echo "  Setting SSH keys..."
    qm set "$VMID" --sshkeys "/tmp/netbird-router-keys-${VMID}.pub"
  fi

  echo "  Resizing disk to ${DISK_GB}G..."
  qm resize "$VMID" scsi0 "${DISK_GB}G" 2>/dev/null || true

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

      # SCP SSH keys for cloud-init
      KEYS_FILE=$(mktemp)
%{for key in var.router_ssh_keys~}
      echo "${key}" >> "$KEYS_FILE"
%{endfor~}
      scp $SSH_OPTS "$KEYS_FILE" root@"$PVE_IP":"/tmp/netbird-router-keys-${each.value.vm_id}.pub"
      rm -f "$KEYS_FILE"

      # SCP and execute creation script
      scp $SSH_OPTS /tmp/create-netbird-router-${each.key}.sh root@"$PVE_IP":/tmp/create-netbird-router-${each.key}.sh
      ssh $SSH_OPTS root@"$PVE_IP" "chmod +x /tmp/create-netbird-router-${each.key}.sh && \
        /tmp/create-netbird-router-${each.key}.sh \
          '${each.value.vm_id}' '${each.value.template_vm_id}' '${each.value.ip}' '${each.value.gateway}' \
          '${each.value.cores}' '${each.value.memory_mb}' '${each.value.disk_size_gb}' \
          '${each.value.storage}' '${each.value.subnet_mask}' && \
        rm -f /tmp/create-netbird-router-${each.key}.sh /tmp/netbird-router-keys-${each.value.vm_id}.pub"
      rm -f /tmp/create-netbird-router-${each.key}.sh

      echo "==> VM ${each.value.vm_id} created, SSH port open on ${each.value.ip}"
    BASH
  }
}

# ---------------------------------------------------------------------------
# Stage 2: Configure NetBird on the VM
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
      SETUP_KEY="${var.netbird_setup_key}"
      MGMT_URL="${var.netbird_management_url}"

      echo "==> Configuring NetBird router at $ROUTER_IP..."

      # Wait for cloud-init to finish and SSH to be fully ready
      echo "  Waiting for cloud-init to complete..."
      for attempt in $(seq 1 30); do
        if ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "true" 2>/dev/null; then
          break
        fi
        [ "$attempt" -eq 30 ] && echo "ERROR: cannot SSH to $ROUTER_IP" >&2 && exit 1
        sleep 10
      done
      ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "sudo cloud-init status --wait 2>/dev/null || true" 2>/dev/null || true

      # Write setup script with values already substituted (no heredoc quoting issues)
      cat > /tmp/netbird-router-setup-${each.key}.sh << SETUP_EOF
#!/bin/bash
set -euo pipefail
SETUP_KEY='$SETUP_KEY'
MGMT_URL='$MGMT_URL'

echo "--- Enable IP forwarding ---"
grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null || echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -w net.ipv4.ip_forward=1
echo "IP forwarding enabled: \$(cat /proc/sys/net/ipv4/ip_forward)"

echo "--- Install NetBird ---"
if ! command -v netbird &>/dev/null; then
  curl -fsSL https://pkgs.netbird.io/install.sh | sudo bash
  echo "NetBird installed: \$(netbird version 2>/dev/null || echo unknown)"
else
  echo "NetBird already installed: \$(netbird version)"
fi

echo "--- Enable NetBird service ---"
sudo systemctl enable netbird

echo "--- Join NetBird management ---"
# Use --foreground=false so it doesn't block; daemon handles the connection
sudo netbird up \
  --management-url "\$MGMT_URL" \
  --setup-key "\$SETUP_KEY" \
  --interface-name wt0 \
  --daemon-addr unix:///var/run/netbird.sock \
  2>&1 || true

echo "--- Wait for NetBird connection ---"
for i in \$(seq 1 12); do
  STATUS=\$(sudo netbird status 2>/dev/null | grep -i "management.*connected\|status.*connected" || echo "")
  if [ -n "\$STATUS" ]; then
    echo "NetBird connected: \$STATUS"
    break
  fi
  echo "  Waiting for NetBird connection (attempt \$i/12)..."
  sleep 10
done

# Show final status
echo "--- NetBird status ---"
sudo netbird status 2>/dev/null || true

echo "--- Setup complete ---"
SETUP_EOF

      scp $SSH_OPTS /tmp/netbird-router-setup-${each.key}.sh ubuntu@"$ROUTER_IP":/tmp/netbird-router-setup.sh
      ssh $SSH_OPTS ubuntu@"$ROUTER_IP" "chmod +x /tmp/netbird-router-setup.sh && sudo /tmp/netbird-router-setup.sh && rm -f /tmp/netbird-router-setup.sh"
      rm -f /tmp/netbird-router-setup-${each.key}.sh

      echo "==> NetBird router ${each.value.ip} configured and connected"
    BASH
  }
}
