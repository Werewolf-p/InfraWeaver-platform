# GitHub Actions self-hosted runner VMs — cloned from cloud-init templates.
#
# For each cluster with a runner defined, this module:
#   1. Clones the cloud-init template on the cluster primary (SCP + qm commands)
#   2. Configures cloud-init (IP, SSH keys, hostname), starts the VM
#   3. Runs Ansible (in Docker) to install + register the GitHub Actions runner
#      and distribute the runner's SSH key to cluster nodes

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

  # Only create runners where the cluster key matches an existing cluster
  valid_runners = {
    for name, rcfg in var.github_runners : name => rcfg
    if contains(tolist(local.cluster_names), name)
  }

  # Cluster nodes grouped by cluster name
  cluster_node_ips = {
    for cn in local.cluster_names : cn => {
      for name, cfg in local.nodes : name => cfg.ip if cfg.cluster == cn
    }
  }
}

# ---------------------------------------------------------------------------
# Step 1: Create runner VM on cluster primary
# ---------------------------------------------------------------------------
resource "null_resource" "create_runner_vm" {
  for_each = local.valid_runners

  triggers = {
    runner_hash = sha256(jsonencode(each.value))
    target_ip   = local.cluster_primary_ips[each.key]
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${var.proxmox_ssh_private_key_file}"
      TARGET_IP="${local.cluster_primary_ips[each.key]}"
      TARGET_NAME="${local.cluster_primaries[each.key]}"

      echo "==> Creating runner VM for cluster '${each.key}' on $TARGET_NAME ($TARGET_IP)..."

      # Wait for SSH to cluster primary
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

      # Write creation script
      SCRIPT=$(mktemp)
      cat > "$SCRIPT" << 'RUNNER_SCRIPT'
#!/bin/bash
set -euo pipefail

VMID="${each.value.vm_id}"
TEMPLATE_VMID="${each.value.template_vm_id}"
VM_NAME="github-runner-${each.key}"
CORES="${each.value.cores}"
MEMORY="${each.value.memory_mb}"
DISK_SIZE="${each.value.disk_size_gb}"
STORAGE="${each.value.storage}"
RUNNER_IP="${each.value.ip}"
VLAN3_IP="${each.value.vlan3_ip != null ? each.value.vlan3_ip : ""}"
GATEWAY="${coalesce(each.value.gateway, var.node_defaults.gateway)}"
SUBNET_MASK="${coalesce(each.value.subnet_mask, var.node_defaults.subnet_mask)}"
DNS="${join(" ", var.proxmox_dns_servers)}"
KEYS_FILE="/tmp/runner-keys.pub"

echo "  Checking if runner VM $VMID exists..."
VM_STATUS=$(qm status "$VMID" 2>/dev/null | awk '{print $2}' || echo "")

if [ -n "$VM_STATUS" ]; then
  echo "  Runner VM $VMID already exists (status: $VM_STATUS)"
  if [ "$VM_STATUS" != "running" ]; then
    echo "  Starting runner VM..."
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
    --ipconfig0 "ip=$RUNNER_IP/$SUBNET_MASK,gw=$GATEWAY" \
    --nameserver "$DNS" \
    --ciuser ubuntu \
    --ciupgrade 0

  # Add VLAN 3 NIC for direct cluster access (bypasses NetBird requirement)
  if [ -n "$VLAN3_IP" ]; then
    echo "  Adding VLAN 3 NIC (eth1) at $VLAN3_IP/24..."
    qm set "$VMID" --net1 "virtio,bridge=vmbr0,tag=3"
    qm set "$VMID" --ipconfig1 "ip=$VLAN3_IP/24"
  fi

  # Set SSH keys BEFORE first boot so cloud-init picks them up
  if [ -f "$KEYS_FILE" ]; then
    echo "  Setting SSH keys..."
    qm set "$VMID" --sshkeys "$KEYS_FILE"
  fi

  echo "  Resizing disk to $${DISK_SIZE}G..."
  qm resize "$VMID" scsi0 "$${DISK_SIZE}G" 2>/dev/null || true

  echo "  Starting runner VM..."
  qm start "$VMID"
fi

# Wait for SSH port on runner VM (not auth, just port open)
echo "  Waiting for SSH port on runner VM ($RUNNER_IP)..."
for attempt in $(seq 1 30); do
  if bash -c "echo >/dev/tcp/$RUNNER_IP/22" 2>/dev/null; then
    echo "  SSH port open on runner VM"
    rm -f "$KEYS_FILE"
    exit 0
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "ERROR: Runner VM $RUNNER_IP port 22 not open after 300s" >&2
    exit 1
  fi
  sleep 10
done
RUNNER_SCRIPT

      # SCP and execute
      scp $SSH_OPTS "$SCRIPT" root@"$TARGET_IP":/tmp/create-runner.sh
      rm -f "$SCRIPT"

      # SCP the SSH keys for cloud-init
      KEYS_FILE=$(mktemp)
%{for key in var.runner_ssh_keys~}
      echo "${key}" >> "$KEYS_FILE"
%{endfor~}
      scp $SSH_OPTS "$KEYS_FILE" root@"$TARGET_IP":/tmp/runner-keys.pub
      rm -f "$KEYS_FILE"

      ssh $SSH_OPTS root@"$TARGET_IP" "chmod +x /tmp/create-runner.sh && /tmp/create-runner.sh && rm -f /tmp/create-runner.sh"

      echo "==> Runner VM for cluster '${each.key}' ready at ${each.value.ip}"
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 2: Configure runner via Ansible (Docker)
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

resource "null_resource" "configure_runner" {
  for_each = local.valid_runners

  triggers = {
    runner_hash         = sha256(jsonencode(each.value))
    playbook_id         = filesha256("${path.root}/../ansible/playbooks/github-runner.yml")
    inventory_id        = filesha256("${path.module}/templates/runner-hosts.yml.tpl")
    cluster_name        = each.key
    runner_repo_url     = each.value.repo_url
    github_runner_token = var.github_runner_token
  }

  depends_on = [
    null_resource.create_runner_vm,
    null_resource.build_ansible_image,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      ANSIBLE_INVENTORY = templatefile("${path.module}/templates/runner-hosts.yml.tpl", {
        cluster_name        = each.key
        runner_ip           = each.value.ip
        runner_vm_id        = each.value.vm_id
        runner_repo_url     = each.value.repo_url
        additional_repos    = join(",", each.value.additional_repos)
        runner_labels       = join(",", each.value.labels)
        github_runner_token = var.github_runner_token
        cluster_nodes       = local.cluster_node_ips[each.key]
        ssh_private_key     = var.proxmox_ssh_private_key_file
      })
    }
    command = <<-BASH
      set -euo pipefail
      INV="/tmp/infra-runner-inv-${each.key}.yml"
      printf '%s' "$ANSIBLE_INVENTORY" > "$INV"
      chmod 600 "$INV"
      docker rm -f "ansible-runner-${each.key}" 2>/dev/null || true

      echo "==> Configuring GitHub runner for cluster: ${each.key}"

      docker run --rm \
        --name "ansible-runner-${each.key}" \
        --network host \
        -e ANSIBLE_PIPELINING=True \
        -e ANSIBLE_REMOTE_TMP=/tmp/.ansible \
        -v "$INV:/ansible/inventory/hosts.yml:ro" \
        -v "${abspath("${path.root}/../ansible/playbooks")}:/ansible/playbooks:ro" \
        -v "${abspath(var.proxmox_ssh_private_key_file)}:/root/.ssh/id_rsa:ro" \
        homelab-ansible:latest \
        ansible-playbook \
          -i /ansible/inventory/hosts.yml \
          /ansible/playbooks/github-runner.yml

      rm -f "$INV"
      echo "==> Runner for cluster ${each.key} configured and registered."
    BASH
  }

  # Deregister runner from GitHub on destroy
  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      RUNNER_NAME="${self.triggers.cluster_name}"
      REPO_URL="${self.triggers.runner_repo_url}"
      TOKEN="${self.triggers.github_runner_token}"
      API_REPO=$(echo "$REPO_URL" | sed 's|https://github.com/||')

      echo "==> Deregistering runner '$RUNNER_NAME' from $API_REPO..."

      # Find runner by name
      RUNNERS_JSON=$(curl -fsSL \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/$API_REPO/actions/runners" 2>/dev/null || echo '{}')

      RUNNER_ID=$(echo "$RUNNERS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('runners', []):
    if r.get('name') == '$RUNNER_NAME':
        print(r['id'])
        break
" 2>/dev/null || echo "")

      if [ -z "$RUNNER_ID" ]; then
        echo "  Runner '$RUNNER_NAME' not found on GitHub (may already be removed)."
        exit 0
      fi

      echo "  Found runner ID: $RUNNER_ID — removing..."
      HTTP_CODE=$(curl -sS -o /dev/null -w "%%{http_code}" \
        -X DELETE \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/$API_REPO/actions/runners/$RUNNER_ID" 2>/dev/null || echo "000")

      if [ "$HTTP_CODE" = "204" ]; then
        echo "==> Runner '$RUNNER_NAME' successfully removed from GitHub."
      else
        echo "  Warning: GitHub API returned HTTP $HTTP_CODE (runner may need manual cleanup)."
      fi
    BASH
  }
}
