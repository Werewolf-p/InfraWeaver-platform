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
  talos_image_url = "https://factory.talos.dev/image/376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4b/${var.talos_version}/nocloud-amd64.raw.xz"

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

  triggers = {
    talos_version = var.talos_version
    node_ip       = var.proxmox_nodes_ips[each.key]
    image_url     = local.talos_image_url
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      NODE_IP="${var.proxmox_nodes_ips[each.key]}"
      TALOS_RAW="${local.talos_raw_path}"
      TALOS_URL="${local.talos_image_url}"

      echo "==> [${each.key}] Ensuring Talos ${var.talos_version} image is present on $NODE_IP..."

      ssh $SSH_OPTS root@"$NODE_IP" bash << 'REMOTE'
        set -euo pipefail
        TALOS_RAW="${TALOS_RAW}"
        TALOS_URL="${TALOS_URL}"

        if [ -f "$TALOS_RAW" ]; then
          echo "  Image already cached: $TALOS_RAW"
          exit 0
        fi

        # Ensure wget and xz are available
        which wget >/dev/null 2>&1 || apt-get install -y wget >/dev/null 2>&1
        which xz >/dev/null 2>&1   || apt-get install -y xz-utils >/dev/null 2>&1

        echo "  Downloading Talos image from factory..."
        wget -q --show-progress -O "${TALOS_RAW}.xz" "$TALOS_URL"

        echo "  Decompressing..."
        xz --decompress --keep "${TALOS_RAW}.xz"
        rm -f "${TALOS_RAW}.xz"

        echo "  Image ready: $TALOS_RAW ($(du -sh $TALOS_RAW | cut -f1))"
REMOTE
      echo "==> [${each.key}] Talos image ready on $NODE_IP."
    BASH
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      NODE_IP="${var.proxmox_nodes_ips[self.triggers.node_ip]}"
      TALOS_RAW="${local.talos_raw_path}"
      # Best-effort cleanup — safe to fail if already removed
      ssh $SSH_OPTS root@"$NODE_IP" "rm -f '$TALOS_RAW'" 2>/dev/null || true
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
      VMID="${each.value.vm_id}"
      STORAGE="${each.value.datastore}"
      DISK_GB="${each.value.disk_gb}"
      TALOS_RAW="${local.talos_raw_path}"

      echo "==> [${each.key}] Configuring disk for VM $VMID on $NODE_IP..."

      # Check whether virtio0 is already configured — skip import if so
      EXISTING=$(ssh $SSH_OPTS root@"$NODE_IP" \
        "qm config $VMID 2>/dev/null | grep '^virtio0:' | head -1" || true)

      if [ -n "$EXISTING" ]; then
        echo "  [${each.key}] virtio0 already configured: $EXISTING"
        echo "  [${each.key}] Skipping import (idempotent)."
      else
        # Remove any leftover unused disk from a previous failed run
        ssh $SSH_OPTS root@"$NODE_IP" bash << 'REMOTE_CLEANUP'
          VMID="${VMID}"
          UNUSED_KEY=$(qm config "$VMID" 2>/dev/null | grep '^unused' | awk -F: '{print $1}' | head -1)
          if [ -n "$UNUSED_KEY" ]; then
            echo "  Removing stale unused disk: $UNUSED_KEY"
            qm set "$VMID" --delete "$UNUSED_KEY" 2>/dev/null || true
          fi
REMOTE_CLEANUP

        echo "  [${each.key}] Importing Talos raw image into VM $VMID (storage: $STORAGE)..."
        ssh $SSH_OPTS root@"$NODE_IP" \
          "qm importdisk $VMID $TALOS_RAW $STORAGE --format raw" 2>&1

        echo "  [${each.key}] Attaching imported disk as virtio0..."
        ssh $SSH_OPTS root@"$NODE_IP" bash << 'REMOTE_ATTACH'
          VMID="${VMID}"
          STORAGE="${STORAGE}"
          # qm importdisk always creates unused0 as the next available unused slot
          DISK_ID=$(qm config "$VMID" 2>/dev/null | grep '^unused0:' | awk '{print $2}' | tr -d ' ')
          if [ -z "$DISK_ID" ]; then
            echo "ERROR: Could not find unused0 disk after importdisk" >&2
            exit 1
          fi
          echo "  Attaching disk: $DISK_ID"
          qm set "$VMID" --virtio0 "${DISK_ID},cache=writeback,discard=on"
          qm set "$VMID" --boot order=virtio0
          echo "  Disk attached and boot order set."
REMOTE_ATTACH

        echo "  [${each.key}] Resizing disk to $${DISK_GB}G..."
        # Resize is idempotent when the disk is already >= target size
        ssh $SSH_OPTS root@"$NODE_IP" \
          "qm resize $VMID virtio0 $${DISK_GB}G 2>&1" \
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
# Step 4 — Start VMs and wait for Talos maintenance API (port 50000)
#
# Talos boots into a maintenance mode and listens on port 50000 before any
# machine config has been applied. We poll this port to know when the node
# is ready to receive its configuration.
# ---------------------------------------------------------------------------

resource "null_resource" "start_talos_vms" {
  for_each = var.nodes

  triggers = {
    vm_id         = each.value.vm_id
    proxmox_node  = each.value.proxmox_node
    node_ip       = each.value.ip
    talos_version = var.talos_version
  }

  depends_on = [null_resource.import_talos_disk]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-BASH
      set -euo pipefail
      SSH_OPTS="${local.ssh_opts}"
      NODE_IP="${var.proxmox_nodes_ips[each.value.proxmox_node]}"
      VMID="${each.value.vm_id}"
      TALOS_IP="${each.value.ip}"

      echo "==> [${each.key}] Starting VM $VMID..."
      VM_STATUS=$(ssh $SSH_OPTS root@"$NODE_IP" \
        "qm status $VMID 2>/dev/null | awk '{print \$2}'" || echo "unknown")

      if [ "$VM_STATUS" = "running" ]; then
        echo "  [${each.key}] VM already running."
      else
        ssh $SSH_OPTS root@"$NODE_IP" "qm start $VMID" 2>&1
        echo "  [${each.key}] VM started."
      fi

      echo "==> [${each.key}] Waiting for Talos maintenance API on $TALOS_IP:50000..."
      DEADLINE=$(( $(date +%s) + 600 ))  # 10 minute timeout
      ATTEMPT=0
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        ATTEMPT=$(( ATTEMPT + 1 ))
        if timeout 3 bash -c "echo >/dev/tcp/$TALOS_IP/50000" 2>/dev/null; then
          echo "==> [${each.key}] Talos API reachable (attempt $ATTEMPT) ✓"
          exit 0
        fi
        REMAINING=$(( DEADLINE - $(date +%s) ))
        echo "  [${each.key}] Waiting for Talos API on $TALOS_IP:50000 ($${REMAINING}s remaining)..."
        sleep 10
      done

      echo "ERROR: [${each.key}] Talos API not reachable on $TALOS_IP:50000 after 600s" >&2
      echo "  Check: VM console via Proxmox UI, DHCP reservation for MAC, network path." >&2
      exit 1
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 5 — Generate Talos machine secrets
#
# Secrets are stored in Terraform state (sensitive). They are stable — once
# created they do not change unless the resource is destroyed and recreated.
# ---------------------------------------------------------------------------

resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

# ---------------------------------------------------------------------------
# Step 6 — Generate per-node Talos machine configurations
#
# Each node gets an individualised patch that sets:
#   - Hostname
#   - Static IP address on eth0
#   - Default route via gateway
#   - Nameservers
#
# Controlplane and worker nodes use separate machine_type values, which
# controls which kubelet flags and API server config Talos generates.
# ---------------------------------------------------------------------------

data "talos_machine_configuration" "this" {
  for_each = var.nodes

  cluster_name       = var.cluster_name
  machine_type       = each.value.controlplane ? "controlplane" : "worker"
  cluster_endpoint   = "https://${local.first_cp_ip}:6443"
  machine_secrets    = talos_machine_secrets.this.machine_secrets
  kubernetes_version = var.kubernetes_version
  talos_version      = var.talos_version

  # Per-node network configuration patch applied on top of the base config.
  # We configure a static address on eth0 (VirtIO → eth0 in Talos naming).
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
        # Enable QEMU guest agent (bundled in the factory image)
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

# talosconfig for talosctl — used by operators and by platform-bootstrap
data "talos_client_configuration" "this" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  nodes                = [for _, cfg in var.nodes : cfg.ip]
  endpoints            = [for _, cfg in var.nodes : cfg.ip if cfg.controlplane]
}

# ---------------------------------------------------------------------------
# Step 7 — Apply machine configurations to each node
#
# talos_machine_configuration_apply connects to the node's Talos maintenance
# API on port 50000, pushes the configuration, and waits for the node to
# reboot with the new config applied.
# ---------------------------------------------------------------------------

resource "talos_machine_configuration_apply" "this" {
  for_each = var.nodes

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.this[each.key].machine_configuration
  node                        = each.value.ip
  endpoint                    = each.value.ip

  # "reboot" ensures the node restarts into its final configured state;
  # required the first time for static IP to take effect.
  apply_mode = "reboot"

  depends_on = [null_resource.start_talos_vms]

  timeouts {
    create = "10m"
    update = "10m"
  }
}

# ---------------------------------------------------------------------------
# Step 8 — Bootstrap etcd on the first control-plane node
#
# This is a one-time operation that initialises the etcd cluster. The
# talos_machine_bootstrap resource is idempotent — subsequent applies are
# no-ops if the cluster is already bootstrapped.
# ---------------------------------------------------------------------------

resource "talos_machine_bootstrap" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = local.first_cp_ip
  endpoint             = local.first_cp_ip

  # Wait for ALL nodes to finish applying their config before bootstrapping.
  # If a worker hasn't applied its config yet, that's fine — etcd only needs
  # controlplane nodes, but we wait for all to ensure consistent state.
  depends_on = [talos_machine_configuration_apply.this]

  timeouts {
    create = "15m"
  }
}

# ---------------------------------------------------------------------------
# Step 9 — Retrieve kubeconfig once the cluster is healthy
# ---------------------------------------------------------------------------

data "talos_cluster_kubeconfig" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = local.first_cp_ip
  endpoint             = local.first_cp_ip

  depends_on = [talos_machine_bootstrap.this]

  timeouts {
    read = "15m"
  }
}
