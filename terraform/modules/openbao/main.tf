# OpenBao vault VMs — cloned from cloud-init templates.
#
# For each cluster with an OpenBao instance defined, this module:
#   1. Clones the cloud-init template on the cluster primary
#   2. Configures cloud-init (IP, SSH keys, hostname), starts the VM
#   3. Runs Ansible (in Docker) to install + configure OpenBao

locals {
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

  cluster_primary_ips = {
    for cn, primary in local.cluster_primaries : cn => local.nodes[primary].ip
  }

  valid_instances = {
    for name, ocfg in var.openbao_instances : name => ocfg
    if contains(tolist(local.cluster_names), name)
  }
}

# ---------------------------------------------------------------------------
# Step 1: Create OpenBao VM on cluster primary
# ---------------------------------------------------------------------------
resource "null_resource" "create_openbao_vm" {
  for_each = local.valid_instances

  triggers = {
    instance_hash = sha256(jsonencode(each.value))
    target_ip     = local.cluster_primary_ips[each.key]
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${var.proxmox_ssh_private_key_file}"
      TARGET_IP="${local.cluster_primary_ips[each.key]}"
      TARGET_NAME="${local.cluster_primaries[each.key]}"

      echo "==> Creating OpenBao VM for cluster '${each.key}' on $TARGET_NAME ($TARGET_IP)..."

      for attempt in $(seq 1 12); do
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

      SCRIPT=$(mktemp)
      cat > "$SCRIPT" << 'OPENBAO_SCRIPT'
#!/bin/bash
set -euo pipefail

VMID="${each.value.vm_id}"
TEMPLATE_VMID="${each.value.template_vm_id}"
VM_NAME="openbao-${each.key}"
CORES="${each.value.cores}"
MEMORY="${each.value.memory_mb}"
DISK_SIZE="${each.value.disk_size_gb}"
STORAGE="${each.value.storage}"
BAO_IP="${each.value.ip}"
GATEWAY="${coalesce(each.value.gateway, var.node_defaults.gateway)}"
SUBNET_MASK="${coalesce(each.value.subnet_mask, var.node_defaults.subnet_mask)}"
DNS="${join(" ", var.proxmox_dns_servers)}"
KEYS_FILE="/tmp/openbao-keys.pub"

echo "  Checking if OpenBao VM $VMID exists..."
VM_STATUS=$(qm status "$VMID" 2>/dev/null | awk '{print $2}' || echo "")

if [ -n "$VM_STATUS" ]; then
  echo "  OpenBao VM $VMID already exists (status: $VM_STATUS)"
  if [ "$VM_STATUS" != "running" ]; then
    echo "  Starting OpenBao VM..."
    qm start "$VMID" 2>/dev/null || true
  fi
else
  echo "  Verifying template $TEMPLATE_VMID exists..."
  if ! qm config "$TEMPLATE_VMID" 2>/dev/null | grep -q 'template: 1'; then
    echo "ERROR: Template VM $TEMPLATE_VMID not found or not a template" >&2
    exit 1
  fi

  echo "  Cloning template $TEMPLATE_VMID → VM $VMID ($VM_NAME)..."
  qm clone "$TEMPLATE_VMID" "$VMID" \
    --name "$VM_NAME" \
    --full 1 \
    --storage "$STORAGE"

  echo "  Configuring VM hardware..."
  qm set "$VMID" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --cpu host \
    --onboot 1

  echo "  Configuring cloud-init..."
  qm set "$VMID" \
    --ipconfig0 "ip=$BAO_IP/$SUBNET_MASK,gw=$GATEWAY" \
    --nameserver "$DNS" \
    --ciuser ubuntu \
    --ciupgrade 0

  if [ -f "$KEYS_FILE" ]; then
    echo "  Setting SSH keys..."
    qm set "$VMID" --sshkeys "$KEYS_FILE"
  fi

  echo "  Resizing disk to $${DISK_SIZE}G..."
  qm resize "$VMID" scsi0 "$${DISK_SIZE}G" 2>/dev/null || true

  echo "  Starting OpenBao VM..."
  qm start "$VMID"
fi

echo "  Waiting for SSH port on OpenBao VM ($BAO_IP)..."
for attempt in $(seq 1 30); do
  if bash -c "echo >/dev/tcp/$BAO_IP/22" 2>/dev/null; then
    echo "  SSH port open on OpenBao VM"
    rm -f "$KEYS_FILE"
    exit 0
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "ERROR: OpenBao VM $BAO_IP port 22 not open after 300s" >&2
    exit 1
  fi
  sleep 10
done
OPENBAO_SCRIPT

      scp $SSH_OPTS "$SCRIPT" root@"$TARGET_IP":/tmp/create-openbao.sh
      rm -f "$SCRIPT"

      KEYS_FILE=$(mktemp)
%{for key in var.runner_ssh_keys~}
      echo "${key}" >> "$KEYS_FILE"
%{endfor~}
      scp $SSH_OPTS "$KEYS_FILE" root@"$TARGET_IP":/tmp/openbao-keys.pub
      rm -f "$KEYS_FILE"

      ssh $SSH_OPTS root@"$TARGET_IP" "chmod +x /tmp/create-openbao.sh && /tmp/create-openbao.sh && rm -f /tmp/create-openbao.sh"

      echo "==> OpenBao VM for cluster '${each.key}' ready at ${each.value.ip}"
    BASH
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = "echo 'Note: OpenBao VM cleanup should be done manually or via qm destroy on the cluster primary.'"
  }
}

# ---------------------------------------------------------------------------
# Step 2: Configure OpenBao via Ansible (Docker)
# ---------------------------------------------------------------------------
resource "null_resource" "build_ansible_image" {
  triggers = {
    dockerfile_hash = filesha256("${path.root}/../ansible/Dockerfile")
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      if docker images -q homelab-ansible:latest | grep -q .; then
        echo "homelab-ansible:latest already present"
      else
        echo "Building homelab-ansible Docker image..."
        docker build -t homelab-ansible:latest '${abspath("${path.root}/../ansible")}'
      fi
    BASH
  }
}

resource "null_resource" "configure_openbao" {
  for_each = local.valid_instances

  triggers = {
    instance_hash = sha256(jsonencode(each.value))
    playbook_id   = filesha256("${path.root}/../ansible/playbooks/openbao.yml")
    inventory_id  = filesha256("${path.module}/templates/openbao-hosts.yml.tpl")
    cluster_name  = each.key
  }

  depends_on = [
    null_resource.create_openbao_vm,
    null_resource.build_ansible_image,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      ANSIBLE_INVENTORY = templatefile("${path.module}/templates/openbao-hosts.yml.tpl", {
        cluster_name    = each.key
        openbao_ip      = each.value.ip
        openbao_vm_id   = each.value.vm_id
        ssh_private_key = var.proxmox_ssh_private_key_file
      })
    }
    command = <<-BASH
      set -euo pipefail
      INV="/tmp/infra-openbao-inv-${each.key}.yml"
      printf '%s' "$ANSIBLE_INVENTORY" > "$INV"
      chmod 600 "$INV"
      docker rm -f "ansible-openbao-${each.key}" 2>/dev/null || true

      echo "==> Configuring OpenBao for cluster: ${each.key}"
      docker run --rm \
        --name "ansible-openbao-${each.key}" \
        --network host \
        -e ANSIBLE_PIPELINING=True \
        -e ANSIBLE_REMOTE_TMP=/tmp/.ansible \
        -v "$INV:/ansible/inventory/hosts.yml:ro" \
        -v "${abspath("${path.root}/../ansible/playbooks")}:/ansible/playbooks:ro" \
        -v "${abspath(var.proxmox_ssh_private_key_file)}:/root/.ssh/id_rsa:ro" \
        homelab-ansible:latest \
        ansible-playbook \
          -i /ansible/inventory/hosts.yml \
          /ansible/playbooks/openbao.yml

      rm -f "$INV"
      echo "==> OpenBao for cluster ${each.key} configured."
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 3: Update VM description with access info
# ---------------------------------------------------------------------------
resource "null_resource" "update_openbao_description" {
  for_each = local.valid_instances

  triggers = {
    instance_hash = sha256(jsonencode(each.value))
    target_ip     = local.cluster_primary_ips[each.key]
  }

  depends_on = [null_resource.configure_openbao]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${var.proxmox_ssh_private_key_file}"
      TARGET_IP="${local.cluster_primary_ips[each.key]}"
      BAO_IP="${each.value.ip}"
      VMID="${each.value.vm_id}"

      echo "==> Fetching OpenBao credentials from VM..."
      ROOT_TOKEN=$(ssh $SSH_OPTS ubuntu@"$BAO_IP" "sudo cat /opt/openbao/init-output.json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[\"root_token\"])'" 2>/dev/null || echo "see-vm")
      UNSEAL_KEY=$(ssh $SSH_OPTS ubuntu@"$BAO_IP" "sudo cat /opt/openbao/init-output.json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[\"unseal_keys_b64\"][0])'" 2>/dev/null || echo "see-vm")

      DESC="OpenBao Vault - managed by OpenTofu
URL: http://${each.value.ip}:8200
SSH: ssh ubuntu@${each.value.ip}
Root Token: $ROOT_TOKEN
Unseal Key: $UNSEAL_KEY
Cluster: ${each.key}"

      ssh $SSH_OPTS root@"$TARGET_IP" "qm set $VMID --description \"$DESC\"" 2>&1 || true

      echo "==> OpenBao VM description updated for cluster ${each.key}"
    BASH
  }
}
