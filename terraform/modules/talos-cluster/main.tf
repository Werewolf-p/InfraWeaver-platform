# =============================================================================
# talos-cluster/main.tf
#
# Deploys a Talos Linux Kubernetes cluster on Proxmox VE.
#
# Flow:
#   1. Download + cache Talos disk image on each unique PVE node (SSH)
#   2. Create Proxmox VMs (bpg/proxmox provider) — no disk yet
#   3. Import Talos disk image into each VM via qm importdisk (SSH)
#   4. Start VMs, wait for Talos maintenance API (port 50000)
#   5. Generate Talos machine secrets (talos provider)
#   6. Generate per-node machine configs with static IP + hostname patches
#   7. Apply machine configs via Talos API
#   8. Bootstrap etcd on the first control-plane node
#   9. Retrieve kubeconfig once cluster is healthy
# =============================================================================

terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.78"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.7"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Locals — derived values used throughout the module
# ---------------------------------------------------------------------------

locals {
  # Canonical Talos factory image URL (includes siderolabs/qemu-guest-agent)
  talos_image_url = "https://factory.talos.dev/image/ce4c980550dd2ab1b17bbf2b08801c7eb59418eafe8f279833297925d67c7515/${var.talos_version}/nocloud-amd64.raw.xz"

  # Stable remote path for the decompressed raw image on each PVE node
  talos_raw_path = "/tmp/talos-${var.talos_version}.raw"

  # Unique set of PVE node names across all VMs — used to deduplicate downloads
  unique_pve_nodes = toset([for _, cfg in var.nodes : cfg.proxmox_node])

  # Control-plane nodes
  controlplane_nodes = { for n, cfg in var.nodes : n => cfg if cfg.controlplane }

  # First control-plane (alphabetically stable sort) — bootstrap node + API endpoint
  first_cp_name = sort(keys(local.controlplane_nodes))[0]
  first_cp_ip   = local.controlplane_nodes[local.first_cp_name].ip

  # SSH options reused across all local-exec provisioners
  ssh_opts = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${pathexpand(var.proxmox_ssh_private_key_file)}"
}

# ---------------------------------------------------------------------------
# Step 1 — Download and decompress Talos disk image onto each PVE node
#
# This runs once per unique PVE node and caches the raw image at
# /tmp/talos-<version>.raw. The file persists between Terraform runs so
# subsequent applies are fast when the image is already present.
# ---------------------------------------------------------------------------

resource "null_resource" "download_talos_image" {
  for_each = local.unique_pve_nodes

  # Store all values that destroy provisioners need — destroy provisioners may
  # only reference self.triggers.*, self.id, count.index, or each.key/value.
  triggers = {
    talos_version  = var.talos_version
    node_ip        = var.proxmox_nodes_ips[each.key]
    image_url      = local.talos_image_url
    talos_raw_path = local.talos_raw_path
    ssh_key_file   = pathexpand(var.proxmox_ssh_private_key_file)
    ssh_username   = var.proxmox_ssh_username
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      NODE_IP="${var.proxmox_nodes_ips[each.key]}"

      echo "==> [${each.key}] Ensuring Talos ${var.talos_version} image is present on $NODE_IP..."

      # Check if already cached — exit early to avoid re-download
      if ssh $SSH_OPTS root@"$NODE_IP" "test -f '${local.talos_raw_path}'" 2>/dev/null; then
        echo "  [${each.key}] Image already cached: ${local.talos_raw_path}"
        exit 0
      fi

      echo "  [${each.key}] Downloading Talos image to $NODE_IP..."
      # Single SSH command — Terraform expands all dollar-brace references at plan time;
      # bash-level variables use backslash-dollar to defer to the remote shell.
      ssh $SSH_OPTS root@"$NODE_IP" "
        set -euo pipefail
        which wget >/dev/null 2>&1 || apt-get install -y wget >/dev/null 2>&1
        which xz   >/dev/null 2>&1 || apt-get install -y xz-utils >/dev/null 2>&1

        echo '  Downloading Talos factory image...'
        wget -q --show-progress -O '${local.talos_raw_path}.xz' '${local.talos_image_url}'

        echo '  Decompressing...'
        xz --decompress '${local.talos_raw_path}.xz'

        echo \"  Image ready: ${local.talos_raw_path} (\$(du -sh '${local.talos_raw_path}' | cut -f1))\"
      "

      echo "==> [${each.key}] Talos image ready on $NODE_IP."
    BASH
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    # Destroy provisioners may ONLY reference self.triggers.*, each.key, self.id.
    # All dynamic values are stored in triggers above.
    command = <<-BASH
      SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ${self.triggers.ssh_key_file}"
      NODE_IP="${self.triggers.node_ip}"
      TALOS_RAW="${self.triggers.talos_raw_path}"
      # Best-effort cleanup — acceptable to fail if already removed
      ssh $SSH_OPTS ${self.triggers.ssh_username}@"$NODE_IP" "rm -f '$TALOS_RAW'" 2>/dev/null || true
      echo "  [${each.key}] Cleaned up Talos image on $NODE_IP."
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 2 — Create Proxmox VMs (disk-less; disk is imported in Step 3)
#
# We intentionally omit the disk block here. The Talos raw image is imported
# via qm importdisk in the next step and becomes virtio0. Using
# lifecycle.ignore_changes on [disk, boot_order] prevents Terraform from
# trying to reconcile our externally-managed disk configuration.
# ---------------------------------------------------------------------------

resource "proxmox_virtual_environment_vm" "talos" {
  for_each = var.nodes

  name      = each.key
  node_name = each.value.proxmox_node
  vm_id     = each.value.vm_id

  description = <<-EOT
    Talos Linux ${var.talos_version} — managed by OpenTofu
    Cluster:      ${var.cluster_name}
    Role:         ${each.value.controlplane ? "control-plane" : "worker"}
    IP:           ${each.value.ip}/${var.subnet_prefix}
    Gateway:      ${var.gateway}
    k8s version:  ${var.kubernetes_version}
  EOT

  # Do not auto-start on initial creation — Step 4 handles VM startup
  # after the disk has been imported.
  on_boot = true
  started = false

  # Use legacy BIOS (SeaBIOS) — simpler for Talos raw images and avoids the
  # extra EFI disk that OVMF/UEFI requires on Proxmox.
  bios = "seabios"

  cpu {
    cores = each.value.cpu
    type  = "host"
    numa  = true
  }

  memory {
    dedicated = each.value.memory_mb
  }

  operating_system {
    type = "l26"
  }

  # VirtIO NIC — required by Talos; optional fixed MAC for DHCP reservations
  network_device {
    bridge      = "vmbr0"
    model       = "virtio"
    mac_address = each.value.mac_address != null ? each.value.mac_address : null
  }

  # Serial console — essential for Talos API and console access
  serial_device {}

  # VGA required alongside serial for some Proxmox versions
  vga {
    type = "serial0"
  }

  # Disk and boot_order are managed externally via qm importdisk / qm set.
  # ignore_changes prevents Terraform from removing or overwriting the disk
  # configuration that our null_resource provisioner sets up.
  lifecycle {
    ignore_changes = [
      disk,
      boot_order,
      started,
      description,
    ]
  }

  depends_on = [null_resource.download_talos_image]
}

# ---------------------------------------------------------------------------
# Step 3 — Import Talos disk image into each VM and configure boot
#
# For each VM this:
#   a) Detects if virtio0 is already configured (idempotent re-runs)
#   b) Cleans up any leftover unused disk from a prior failed attempt
#   c) Runs: qm importdisk <vmid> talos.raw <storage>
#   d) Attaches the imported disk as virtio0 with discard + writeback
#   e) Resizes the disk to the requested disk_gb
#   f) Sets boot order: virtio0
# ---------------------------------------------------------------------------

resource "null_resource" "import_talos_disk" {
  for_each = var.nodes

  triggers = {
    vm_id         = each.value.vm_id
    proxmox_node  = each.value.proxmox_node
    datastore     = each.value.datastore
    disk_gb       = each.value.disk_gb
    talos_version = var.talos_version
  }

  depends_on = [
    proxmox_virtual_environment_vm.talos,
    null_resource.download_talos_image,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      NODE_IP="${var.proxmox_nodes_ips[each.value.proxmox_node]}"

      echo "==> [${each.key}] Configuring disk for VM ${each.value.vm_id} on $NODE_IP..."

      # All values below are Terraform-expanded at template time (no SSH heredoc needed).
      # Bash-level variables use \$ to defer expansion to the remote shell.

      # Check whether virtio0 is already configured — skip import if so (idempotent)
      EXISTING=$(ssh $SSH_OPTS root@"$NODE_IP" \
        "qm config ${each.value.vm_id} 2>/dev/null | grep '^virtio0:' | head -1" || true)

      if [ -n "$EXISTING" ]; then
        echo "  [${each.key}] virtio0 already configured: $EXISTING"
        echo "  [${each.key}] Skipping import (idempotent)."
      else
        # Remove any leftover unused disk from a previous failed run
        ssh $SSH_OPTS root@"$NODE_IP" "
          UNUSED_KEY=\$(qm config ${each.value.vm_id} 2>/dev/null | grep '^unused' | awk -F: '{print \$1}' | head -1)
          if [ -n \"\$UNUSED_KEY\" ]; then
            echo '  Removing stale unused disk: '\"\$UNUSED_KEY\"
            qm set ${each.value.vm_id} --delete \"\$UNUSED_KEY\" 2>/dev/null || true
          fi
        "

        echo "  [${each.key}] Importing Talos raw image into VM ${each.value.vm_id} (storage: ${each.value.datastore})..."
        ssh $SSH_OPTS root@"$NODE_IP" \
          "qm importdisk ${each.value.vm_id} '${local.talos_raw_path}' ${each.value.datastore} --format raw" 2>&1

        echo "  [${each.key}] Attaching imported disk as virtio0..."
        ssh $SSH_OPTS root@"$NODE_IP" "
          set -euo pipefail
          DISK_ID=\$(qm config ${each.value.vm_id} 2>/dev/null | grep '^unused0:' | awk '{print \$2}' | tr -d ' ')
          if [ -z \"\$DISK_ID\" ]; then
            echo 'ERROR: Could not find unused0 disk after importdisk' >&2
            exit 1
          fi
          echo '  Attaching disk: '\"\$DISK_ID\"
          qm set ${each.value.vm_id} --virtio0 \"\$DISK_ID,cache=writeback,discard=on\"
          qm set ${each.value.vm_id} --boot order=virtio0
          echo '  Disk attached and boot order set.'
        "

        echo "  [${each.key}] Resizing disk to ${each.value.disk_gb}G..."
        # Resize is idempotent when the disk is already >= target size
        ssh $SSH_OPTS root@"$NODE_IP" \
          "qm resize ${each.value.vm_id} virtio0 ${each.value.disk_gb}G 2>&1" \
          || echo "  [${each.key}] Note: resize returned non-zero (disk may already be correct size)"
      fi

      echo "==> [${each.key}] Disk configuration complete."
    BASH
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    # VM destruction (proxmox_virtual_environment_vm) handles disk removal.
    command = "echo '[${each.key}] Disk cleanup delegated to VM destroy.'"
  }
}

# ---------------------------------------------------------------------------
# Step 5 — Write machine configs and talosconfig to generated/ directory
#
# Machine configs are written here so the start_and_configure_talos step
# can pass them directly to talosctl apply-config.
# ---------------------------------------------------------------------------

locals {
  generated_dir = "${path.module}/../../../envs/${var.environment}/generated"
}

resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

data "talos_machine_configuration" "this" {
  for_each = var.nodes

  cluster_name       = var.cluster_name
  machine_type       = each.value.controlplane ? "controlplane" : "worker"
  cluster_endpoint   = "https://${local.first_cp_ip}:6443"
  machine_secrets    = talos_machine_secrets.this.machine_secrets
  kubernetes_version = var.kubernetes_version
  talos_version      = var.talos_version

  config_patches = [
    yamlencode({
      machine = {
        network = {
          hostname = each.key
          interfaces = [
            {
              interface = "eth0"
              addresses = ["${each.value.ip}/${var.subnet_prefix}"]
              routes = [
                {
                  network = "0.0.0.0/0"
                  gateway = var.gateway
                }
              ]
            }
          ]
          nameservers = var.nameservers
        }
        features = {
          hostDNS = {
            enabled              = true
            forwardKubeDNSToHost = true
          }
        }
      }
    })
  ]
}

data "talos_client_configuration" "this" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  nodes                = [for _, cfg in var.nodes : cfg.ip]
  endpoints            = [for _, cfg in var.nodes : cfg.ip if cfg.controlplane]
}

resource "local_sensitive_file" "node_machine_config" {
  for_each        = var.nodes
  content         = data.talos_machine_configuration.this[each.key].machine_configuration
  filename        = "${local.generated_dir}/mc-${each.key}.yaml"
  file_permission = "0600"
}

resource "local_sensitive_file" "talosconfig_generated" {
  content         = data.talos_client_configuration.this.talos_config
  filename        = "${local.generated_dir}/talosconfig"
  file_permission = "0600"
}

# ---------------------------------------------------------------------------
# Step 4 (revised) — Start VMs, discover DHCP IP, apply machine config,
# then wait for static IP.
#
# Talos boots in maintenance mode with a DHCP-assigned IP. We must:
#   1. Discover the DHCP IP by querying ARP on the PVE node (by VM MAC).
#   2. Apply the machine config (which sets the static IP) via talosctl.
#   3. Wait for the node to reboot and become reachable on its static IP.
# ---------------------------------------------------------------------------

resource "null_resource" "start_and_configure_talos" {
  for_each = var.nodes

  triggers = {
    vm_id    = each.value.vm_id
    node_ip  = each.value.ip
    mc_hash  = sha256(data.talos_machine_configuration.this[each.key].machine_configuration)
  }

  depends_on = [
    null_resource.import_talos_disk,
    local_sensitive_file.node_machine_config,
    local_sensitive_file.talosconfig_generated,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      PVE_IP="${var.proxmox_nodes_ips[each.value.proxmox_node]}"
      VMID="${each.value.vm_id}"
      TARGET_IP="${each.value.ip}"
      MC_FILE="${local.generated_dir}/mc-${each.key}.yaml"

      # ── Start VM ────────────────────────────────────────────────────────────
      VM_STATUS=$(ssh $SSH_OPTS root@"$PVE_IP" \
        "qm status $VMID 2>/dev/null | awk '{print \$2}'" || echo "unknown")
      if [ "$VM_STATUS" != "running" ]; then
        echo "==> [${each.key}] Starting VM $VMID on $PVE_IP..."
        ssh $SSH_OPTS root@"$PVE_IP" "qm start $VMID"
        echo "  VM started."
      else
        echo "==> [${each.key}] VM $VMID already running."
      fi

      # ── Discover DHCP IP by scanning subnet from runner ───────────────────
      # Get VM MAC from PVE node (reliable — directly from VM config)
      MAC=$(ssh $SSH_OPTS root@"$PVE_IP" \
        "qm config $VMID 2>/dev/null | grep '^net0:' | grep -oiP '(?<=virtio=)[A-Fa-f0-9:]+'" \
        2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")
      echo "==> [${each.key}] VM MAC: $MAC"

      # Derive subnet from gateway (e.g. 10.25.0.1 -> 10.25.0)
      SUBNET=$(echo "${var.gateway}" | sed 's/\.[0-9]*$//')

      DHCP_IP=""
      echo "==> [${each.key}] Scanning $SUBNET.0/24 for Talos API (port 50000)..."
      for attempt in $(seq 1 20); do
        TMPFILE=$(mktemp /tmp/talos_scan_XXXXXX)
        # Parallel TCP probe for port 50000 across full subnet
        for last in $(seq 1 254); do
          ip="$SUBNET.$last"
          (timeout 0.5 bash -c "echo >/dev/tcp/$ip/50000" 2>/dev/null && echo "$ip" >> "$TMPFILE") &
        done
        wait

        if [ -s "$TMPFILE" ]; then
          while IFS= read -r candidate; do
            # Ping to ensure ARP entry is populated
            ping -c 1 -W 1 "$candidate" >/dev/null 2>&1 || true
            FOUND_MAC=$(ip neigh show "$candidate" 2>/dev/null \
              | grep -oiP '[0-9a-f]{2}(:[0-9a-f]{2}){5}' | head -1 \
              | tr '[:upper:]' '[:lower:]')
            if [ "$FOUND_MAC" = "$MAC" ]; then
              DHCP_IP="$candidate"
              break
            fi
          done < "$TMPFILE"
        fi
        rm -f "$TMPFILE"

        if [ -n "$DHCP_IP" ]; then
          echo "  Found DHCP IP: $DHCP_IP (attempt $attempt)"
          break
        fi
        echo "  [${each.key}] No match yet (attempt $attempt/20), waiting 15s..."
        sleep 15
      done

      if [ -z "$DHCP_IP" ]; then
        echo "ERROR: Could not discover DHCP IP for ${each.key} (MAC: $MAC)" >&2
        exit 1
      fi

      # ── Talos API is already reachable (we found it via port 50000 scan) ───
      echo "==> [${each.key}] Talos maintenance API reachable at $DHCP_IP:50000 ✓"

      # ── Apply machine config (sets static IP, triggers reboot) ────────────
      echo "==> [${each.key}] Applying machine config to $DHCP_IP..."
      talosctl apply-config \
        --insecure \
        --endpoints "$DHCP_IP" \
        --nodes "$DHCP_IP" \
        --file "$MC_FILE"
      echo "  Config applied. Node will reboot to $TARGET_IP..."

      # ── Wait for static IP ────────────────────────────────────────────────
      sleep 30
      echo "==> [${each.key}] Waiting for Talos API on static IP $TARGET_IP:50000 (up to 8 min)..."
      DEADLINE=$(( $(date +%s) + 480 ))
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        if timeout 3 bash -c "echo >/dev/tcp/$TARGET_IP/50000" 2>/dev/null; then
          echo "==> [${each.key}] Static IP $TARGET_IP reachable ✓"
          exit 0
        fi
        REMAINING=$(( DEADLINE - $(date +%s) ))
        echo "  Waiting for $TARGET_IP:50000 ($${REMAINING}s remaining)..."
        sleep 10
      done

      echo "ERROR: [${each.key}] $TARGET_IP:50000 not reachable after reboot" >&2
      exit 1
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 8 — Bootstrap etcd via talosctl
# ---------------------------------------------------------------------------

resource "null_resource" "bootstrap_etcd" {
  triggers = {
    cluster_name  = var.cluster_name
    first_cp_ip   = local.first_cp_ip
    secrets_hash  = sha256(jsonencode(talos_machine_secrets.this.machine_secrets))
  }

  depends_on = [null_resource.start_and_configure_talos]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      TALOSCONFIG="${local.generated_dir}/talosconfig"
      CP_IP="${local.first_cp_ip}"

      echo "==> Bootstrapping etcd on $CP_IP..."
      talosctl bootstrap \
        --talosconfig "$TALOSCONFIG" \
        --endpoints "$CP_IP" \
        --nodes "$CP_IP" \
        2>&1 || echo "  (bootstrap returned non-zero — may already be bootstrapped, continuing)"

      echo "==> Waiting for Kubernetes API to be healthy (up to 10 min)..."
      DEADLINE=$(( $(date +%s) + 600 ))
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        if talosctl health \
          --talosconfig "$TALOSCONFIG" \
          --endpoints "$CP_IP" \
          --nodes "$CP_IP" \
          --wait-timeout 30s \
          2>/dev/null; then
          echo "==> Cluster healthy ✓"
          exit 0
        fi
        echo "  Waiting for cluster health..."
        sleep 20
      done
      echo "ERROR: Cluster not healthy after 10 minutes" >&2
      exit 1
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 9 — Retrieve kubeconfig once the cluster is healthy
# ---------------------------------------------------------------------------

resource "talos_cluster_kubeconfig" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = local.first_cp_ip
  endpoint             = local.first_cp_ip

  depends_on = [null_resource.bootstrap_etcd]
}
