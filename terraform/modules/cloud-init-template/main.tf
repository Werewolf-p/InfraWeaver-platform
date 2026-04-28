# Cloud-init template creation on target PVE nodes.
#
# For each cluster, templates are created on the primary node.
# For standalone nodes, templates are created on the node itself.
# This runs an Ansible playbook that handles:
#   - Downloading the cloud image
#   - Creating a VM with cloud-init drive
#   - Converting to template

locals {
  # Compute node IPs
  nodes = {
    for name, cfg in var.proxmox_nodes : name => {
      ip      = length(split("/", cfg.ip)) > 1 ? split("/", cfg.ip)[0] : cfg.ip
      cluster = cfg.cluster
    }
  }

  cluster_names = toset(compact([for _, cfg in local.nodes : cfg.cluster]))

  cluster_primaries = {
    for cn in local.cluster_names : cn => sort([for name, cfg in local.nodes : name if cfg.cluster == cn])[0]
  }

  standalone_nodes = toset([for name, cfg in local.nodes : name if cfg.cluster == null])

  # Target nodes where templates should be created: one per cluster + each standalone
  target_nodes = merge(
    { for cn, primary in local.cluster_primaries : cn => {
      name = primary
      ip   = local.nodes[primary].ip
    } },
    { for name in local.standalone_nodes : name => {
      name = name
      ip   = local.nodes[name].ip
    } }
  )
}

resource "null_resource" "create_templates" {
  for_each = length(var.cloud_init_templates) > 0 ? local.target_nodes : {}

  triggers = {
    templates_hash = sha256(jsonencode(var.cloud_init_templates))
    target_ip      = each.value.ip
    ssh_keys_hash  = sha256(join(",", var.runner_ssh_keys))
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${var.proxmox_ssh_private_key_file}"
      TARGET_IP="${each.value.ip}"
      TARGET_NAME="${each.value.name}"

      echo "==> Creating cloud-init templates on $TARGET_NAME ($TARGET_IP)..."

      # Wait for SSH to be available (node may still be booting after clustering)
      for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
        if ssh $SSH_OPTS root@"$TARGET_IP" true 2>/dev/null; then
          echo "  SSH to $TARGET_IP OK"
          break
        fi
        if [ "$attempt" -eq 12 ]; then
          echo "ERROR: Cannot reach $TARGET_IP via SSH after 120s" >&2
          exit 1
        fi
        echo "  Waiting for SSH on $TARGET_IP (attempt $attempt/12)..."
        sleep 10
      done

      # Write a script to run remotely — avoids heredoc/escaping issues
      SCRIPT=$(mktemp)
      cat > "$SCRIPT" << 'REMOTE_SCRIPT'
#!/bin/bash
set -euo pipefail
%{for tname, tcfg in var.cloud_init_templates}
VMID="${tcfg.vm_id}"
NAME="${tcfg.name}"
IMAGE_URL="${tcfg.image_url}"
CORES="${tcfg.cores}"
MEMORY="${tcfg.memory_mb}"
STORAGE="${tcfg.storage}"
DISK_SIZE="${tcfg.disk_size_gb}"
IMG_FILE="/tmp/${tname}-cloud.img"

echo "  [${tname}] Checking template VM $VMID..."

# Check if template already exists
if qm config "$VMID" 2>/dev/null | grep -q 'template: 1'; then
  echo "  [${tname}] Template VM $VMID already exists — skipping"
else
  echo "  [${tname}] Downloading cloud image..."
  if [ ! -f "$IMG_FILE" ]; then
    wget -q -O "$IMG_FILE" "$IMAGE_URL" 2>&1 || curl -fsSL -o "$IMG_FILE" "$IMAGE_URL"
  fi
  ls -lh "$IMG_FILE"

  # Clean up any existing VM with same ID (handle segfault on inconsistent VMs)
  if qm status "$VMID" &>/dev/null; then
    echo "  [${tname}] Removing existing VM $VMID..."
    qm stop "$VMID" --timeout 10 2>/dev/null || true
    sleep 2
    qm destroy "$VMID" --purge 2>/dev/null || true
    sleep 2
    # Fallback: force-remove config if qm destroy segfaulted
    if qm status "$VMID" &>/dev/null; then
      echo "  [${tname}] Force-removing stale VM $VMID config..."
      rm -f "/etc/pve/qemu-server/$VMID.conf" 2>/dev/null || true
      sleep 2
    fi
  fi

  echo "  [${tname}] Creating template VM $VMID..."
  qm create "$VMID" \
    --name "$NAME" \
    --cpu host \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --net0 virtio,bridge=vmbr0 \
    --scsihw virtio-scsi-pci \
    --serial0 socket \
    --vga serial0 \
    --boot c --bootdisk scsi0 \
    --agent enabled=1

  echo "  [${tname}] Importing disk..."
  qm set "$VMID" --scsi0 "$STORAGE":0,import-from="$IMG_FILE",discard=on

  echo "  [${tname}] Adding cloud-init drive..."
  qm set "$VMID" --ide2 "$STORAGE":cloudinit

  echo "  [${tname}] Resizing disk to $${DISK_SIZE}G..."
  qm resize "$VMID" scsi0 "$${DISK_SIZE}G"

  echo "  [${tname}] Converting to template..."
  qm template "$VMID"

  rm -f "$IMG_FILE"
  echo "  [${tname}] Template VM $VMID created successfully"
fi
%{endfor}
echo "==> All templates ready"
REMOTE_SCRIPT

      # Copy script and execute on target
      scp $SSH_OPTS "$SCRIPT" root@"$TARGET_IP":/tmp/create-templates.sh
      rm -f "$SCRIPT"
      ssh $SSH_OPTS root@"$TARGET_IP" "chmod +x /tmp/create-templates.sh && /tmp/create-templates.sh && rm -f /tmp/create-templates.sh"
      RESULT=$?

      if [ "$RESULT" -ne 0 ]; then
        echo "ERROR: Template creation failed on $TARGET_NAME ($TARGET_IP)" >&2
        exit 1
      fi

      echo "==> Templates ready on $TARGET_NAME ($TARGET_IP)"
    BASH
  }
}
