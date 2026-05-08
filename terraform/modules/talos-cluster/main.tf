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
      version = "~> 0.104"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.10"
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
  talos_image_url = "https://factory.talos.dev/image/e187c9b90f773cd8c84e5a3265c5554ee787b2fe67b508d9f955e90e7ae8c96c/${var.talos_version}/nocloud-amd64.raw.xz"

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

      # Check if already cached and complete (>= 4 GB) — and verify SHA256 sidecar to
      # guard against silent on-disk corruption that passes the size check but produces
      # a corrupt initramfs (ZSTD checksum mismatch) causing VMs to boot-loop.
      CACHED_SIZE=$(ssh $SSH_OPTS root@"$NODE_IP" \
        "stat -c %s '${local.talos_raw_path}' 2>/dev/null || echo 0" 2>/dev/null || echo 0)
      if [ "$CACHED_SIZE" -ge 4000000000 ]; then
        SIDECAR="${local.talos_raw_path}.sha256"
        INTEGRITY=$(ssh $SSH_OPTS root@"$NODE_IP" "
          if [ -f '$SIDECAR' ]; then
            expected=\$(cat '$SIDECAR')
            actual=\$(sha256sum '${local.talos_raw_path}' | awk '{print \$1}')
            if [ \"\$expected\" = \"\$actual\" ]; then echo valid; else echo invalid; fi
          else
            echo no_sidecar
          fi
        " 2>/dev/null || echo check_failed)
        if [ "$INTEGRITY" = "valid" ]; then
          echo "  [${each.key}] Image cached and SHA256 verified ($(( CACHED_SIZE / 1024 / 1024 )) MiB): ${local.talos_raw_path}"
          exit 0
        else
          echo "  [${each.key}] Cached image integrity check failed ($INTEGRITY) — forcing re-download."
          ssh $SSH_OPTS root@"$NODE_IP" "rm -f '${local.talos_raw_path}' '${local.talos_raw_path}.sha256'" 2>/dev/null || true
        fi
      fi

      echo "  [${each.key}] Downloading Talos image to $NODE_IP (cached_size=$CACHED_SIZE)..."
      # Single SSH command — Terraform expands all dollar-brace references at plan time;
      # bash-level variables use backslash-dollar to defer to the remote shell.
      ssh $SSH_OPTS root@"$NODE_IP" "
        set -euo pipefail
        which wget >/dev/null 2>&1 || apt-get install -y wget >/dev/null 2>&1
        which xz   >/dev/null 2>&1 || apt-get install -y xz-utils >/dev/null 2>&1

        # Remove any incomplete file from a previous failed run before downloading
        rm -f '${local.talos_raw_path}' '${local.talos_raw_path}.xz' '${local.talos_raw_path}.sha256'

        echo '  Downloading Talos factory image...'
        wget -q --show-progress -O '${local.talos_raw_path}.xz' '${local.talos_image_url}'

        echo '  Decompressing (atomic: write to .tmp then rename)...'
        xz --decompress --stdout '${local.talos_raw_path}.xz' > '${local.talos_raw_path}.tmp'
        mv '${local.talos_raw_path}.tmp' '${local.talos_raw_path}'
        rm -f '${local.talos_raw_path}.xz'

        echo '  Computing SHA256 sidecar for future integrity checks...'
        sha256sum '${local.talos_raw_path}' | awk '{print \$1}' > '${local.talos_raw_path}.sha256'

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
      ssh $SSH_OPTS ${self.triggers.ssh_username}@"$NODE_IP" "rm -f '$TALOS_RAW' '$TALOS_RAW.sha256'" 2>/dev/null || true
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

  # Single VirtIO NIC on VLAN 3 — the only network interface for the node.
  # All cluster traffic (API, pod networking, MetalLB) runs on 10.10.0.0/24.
  network_device {
    bridge      = "vmbr0"
    model       = "virtio"
    vlan_id     = var.vlan3_tag
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
    # Store SSH info so destroy provisioner can reference self.triggers.* 
    # (destroy provisioners may not reference vars/locals/other resources)
    node_ip  = var.proxmox_nodes_ips[each.value.proxmox_node]
    ssh_opts = local.ssh_opts
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
    # Explicitly delete the LVM disk to prevent stale disk issues on redeploy.
    # The bpg/proxmox provider with lifecycle.ignore_changes=[disk] does NOT
    # delete the LVM thin volume when the VM is destroyed. If it survives,
    # the next apply's EXISTING check will find virtio0 and skip re-import,
    # causing nodes to boot with old Talos config and old cluster secrets.
    # NOTE: destroy provisioners may only reference self.* and each.* — not
    # var.* or local.* — so SSH opts and node IP are stored in triggers.
    command = <<-BASH
      SSH_OPTS="${self.triggers.ssh_opts}"
      NODE_IP="${self.triggers.node_ip}"
      VMID="${self.triggers.vm_id}"
      echo "==> [${each.key}] Explicitly removing LVM disk for VM $VMID..."
      ssh $SSH_OPTS root@"$NODE_IP" "
        qm stop $VMID --timeout 10 2>/dev/null || qm stop $VMID --skiplock 2>/dev/null || true
        sleep 2
        # Detach virtio0 (makes it unused0)
        qm disk unlink $VMID --idlist virtio0 2>/dev/null || true
        # Delete unused0 (purges the LVM volume)
        qm set $VMID --delete unused0 2>/dev/null || true
        echo '  LVM disk cleanup complete for VM '$VMID
      " 2>&1 || echo '[${each.key}] Note: disk cleanup failed (VM may already be destroyed)'
    BASH
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
          # NOTE: hostname is NOT set here (machine.network.hostname) because Talos v1.12+
          # adds a HostnameConfig document automatically. Having both causes a validation error.
          # The hostname is handled below by post-processing the generated machine config.
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
        # Docker Hub pull-through cache mirror to avoid 429 rate limits.
        # Each unique Docker Hub image is pulled once from the origin and cached;
        # subsequent node pulls are served locally without hitting Docker Hub.
        registries = var.registry_mirror_url != "" ? {
          mirrors = {
            "docker.io" = {
              endpoints = [var.registry_mirror_url]
            }
          }
          config = {
            (trimprefix(trimprefix(var.registry_mirror_url, "https://"), "http://")) = {
              tls = {
                insecureSkipVerify = true
              }
            }
          }
        } : null
      }
      # Allow pods to schedule on control-plane nodes.
      # Required for all-control-plane HA clusters (no separate worker nodes).
      cluster = {
        allowSchedulingOnControlPlanes = true
        # etcd tuning for virtualized homelab (Proxmox VMs on HDD/SSD storage).
        #
        # Default heartbeat-interval=100ms and election-timeout=1000ms assume fast bare-metal I/O.
        # On Proxmox with LVM/ZFS storage, fsync latency can exceed 100ms, causing etcd to miss
        # heartbeats → frequent leader elections → all API server connections drop → all pods
        # restart (exit 255, NodeNotReady). Increasing these values by 3x prevents spurious elections.
        #
        # Formula: election-timeout ≥ 5 × heartbeat-interval (etcd docs requirement).
        # 300ms heartbeat × 5 = 1500ms min; we use 3000ms for extra margin on slow storage.
        etcd = {
          extraArgs = {
            # How often the leader sends heartbeats to followers (ms). Increase on slow storage.
            heartbeat-interval = "300"
            # Time before a follower starts a new election on missing heartbeats (ms).
            election-timeout = "3000"
            # Prevent etcd WAL from exhausting disk space in long-running clusters.
            # 2GB is sufficient for a homelab with <50 apps.
            quota-backend-bytes = "2147483648"
          }
        }
      }
    }),
  ]
}

data "talos_client_configuration" "this" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  nodes                = [for _, cfg in var.nodes : cfg.ip]
  endpoints            = [for _, cfg in var.nodes : cfg.ip if cfg.controlplane]
}

resource "local_sensitive_file" "node_machine_config" {
  for_each = var.nodes
  # Talos provider 0.7.x automatically appends a HostnameConfig document with
  # "auto: stable" for Talos v1.12+ clusters. We post-process the generated config
  # to replace this with an explicit static hostname. Using a config_patch to set
  # the hostname via JSON Merge Patch doesn't work because YAML null on a string
  # enum field is treated as empty string and doesn't clear the auto field.
  content = replace(
    replace(
      data.talos_machine_configuration.this[each.key].machine_configuration,
      "auto: stable\n",
      ""
    ),
    "kind: HostnameConfig\n",
    "kind: HostnameConfig\nhostname: ${each.key}\n"
  )
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
    vm_id   = each.value.vm_id
    node_ip = each.value.ip
    mc_hash = sha256(local_sensitive_file.node_machine_config[each.key].content)
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

      # ── Discover IP: scan VLAN3 from runner, match by MAC ────────────────
      # The runner has a VLAN 3 NIC (eth1/10.10.0.x) so it can reach nodes
      # directly. Scan 10.10.0.0/24 for port 50000, then ip-neigh-match MAC.
      MAC=$(ssh $SSH_OPTS root@"$PVE_IP" \
        "qm config $VMID 2>/dev/null | grep '^net0:' | grep -oiP '(?<=virtio=)[A-Fa-f0-9:]+'" \
        2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")
      echo "==> [${each.key}] VM MAC: $MAC"

      DHCP_IP=""
      echo "==> [${each.key}] Scanning VLAN3 for Talos API (up to 10 min)..."
      for attempt in $(seq 1 40); do
        TMPF=$(mktemp /tmp/talos_XXXXXX)
        for last in $(seq 1 254); do
          ip_="10.10.0.$last"
          (timeout 0.3 bash -c "echo >/dev/tcp/$ip_/50000" 2>/dev/null && echo "$ip_" >> "$TMPF") &
        done
        wait 2>/dev/null; sleep 0.5
        if [ -s "$TMPF" ]; then
          while IFS= read -r cip; do
            # Ping to ensure ARP entry is populated, then check MAC
            ping -c1 -W1 "$cip" >/dev/null 2>&1 || true
            cmac=$(sudo ip neigh show "$cip" 2>/dev/null | awk '{print tolower($5)}' | head -1)
            if [ -n "$cmac" ] && [ "$cmac" = "$MAC" ]; then
              DHCP_IP="$cip"
              break
            fi
          done < "$TMPF"
        fi
        rm -f "$TMPF"

        if [ -n "$DHCP_IP" ]; then
          echo "  [${each.key}] Found at $DHCP_IP (attempt $attempt) ✓"
          break
        fi
        echo "  [${each.key}] Not found yet (attempt $attempt/24), waiting 15s..."
        sleep 15
      done

      if [ -z "$DHCP_IP" ]; then
        echo "ERROR: Could not find Talos API for ${each.key} (MAC: $MAC) on 10.10.0.0/24" >&2
        exit 1
      fi

      echo "==> [${each.key}] Talos API at $DHCP_IP:50000 ✓"

      # ── Apply machine config (sets static IP, triggers reboot) ────────────
      # First try --insecure (maintenance mode, new node). If that fails with a
      # TLS error the node is already running → use authenticated staged apply.
      echo "==> [${each.key}] Applying machine config to $DHCP_IP..."
      TALOSCONFIG_TMP="${local.generated_dir}/talosconfig"
      if talosctl apply-config \
          --insecure \
          --endpoints "$DHCP_IP" \
          --nodes "$DHCP_IP" \
          --file "$MC_FILE" 2>/tmp/talos_apply_err_${each.key}; then
        echo "  Config applied via maintenance mode. Node will reboot to $TARGET_IP..."
      else
        # Node already running — use authenticated apply with --mode=staged
        # so the updated config (e.g. registry mirrors) takes effect on next boot
        # without disrupting the currently-running cluster.
        echo "  Maintenance mode unavailable ($(cat /tmp/talos_apply_err_${each.key} | head -1))."
        echo "  Applying config update to running node $TARGET_IP (staged)..."
        talosctl apply-config \
          --talosconfig "$TALOSCONFIG_TMP" \
          --endpoints "$TARGET_IP" \
          --nodes "$TARGET_IP" \
          --file "$MC_FILE" \
          --mode=staged 2>&1 \
          || echo "  Warning: staged apply failed — config may already match or node unreachable"
        echo "  Config staged. Will take effect on next reboot. Skipping reboot wait."
        rm -f /tmp/talos_apply_err_${each.key}
        exit 0
      fi
      rm -f /tmp/talos_apply_err_${each.key}

      # ── Wait for node to reboot and return on static IP ─────────────────
      # Machine config was applied; node reboots and returns on the same IP.
      sleep 30
      echo "==> [${each.key}] Waiting for Talos API after reboot on $TARGET_IP:50000 (up to 8 min)..."
      DEADLINE=$(( $(date +%s) + 480 ))
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        if timeout 3 bash -c "echo >/dev/tcp/$TARGET_IP/50000" 2>/dev/null; then
          echo "==> [${each.key}] Static IP $TARGET_IP reachable ✓"
          break
        fi
        REMAINING=$(( DEADLINE - $(date +%s) ))
        echo "  Waiting for $TARGET_IP:50000 ($${REMAINING}s remaining)..."
        sleep 10
      done

      if ! timeout 3 bash -c "echo >/dev/tcp/$TARGET_IP/50000" 2>/dev/null; then
        echo "ERROR: [${each.key}] $TARGET_IP:50000 not reachable after reboot" >&2
        exit 1
      fi

      # ── Boot watchdog: detect & recover buffer-overrun stall ─────────────
      # Talos v1.10 can hit a controller-runtime watch buffer overrun
      # (VolumeMountRequests.block.talos.dev) on first boot when partitioning
      # a fresh virtio disk inside nested virtualisation. The symptom is:
      #   stage: booting, unmetCond: waiting on: etc-files
      # The machined controller crashes mid-boot and never clears etc-files.
      # Recovery: a hard reset via Proxmox 'qm reset' forces a clean reboot,
      # after which the controller starts cleanly without the overrun.
      TALOSCONFIG="${local.generated_dir}/talosconfig"
      echo "==> [${each.key}] Boot watchdog: checking for stalled boot (up to 3 min)..."
      STALL_DEADLINE=$(( $(date +%s) + 180 ))
      while [ "$(date +%s)" -lt "$STALL_DEADLINE" ]; do
        STAGE=$(talosctl get machinestatus \
          --talosconfig "$TALOSCONFIG" \
          --endpoints "$TARGET_IP" --nodes "$TARGET_IP" \
          -o yaml 2>/dev/null \
          | grep -oP '(?<=stage: )\S+' | head -1 || echo "unknown")
        UNMET=$(talosctl get machinestatus \
          --talosconfig "$TALOSCONFIG" \
          --endpoints "$TARGET_IP" --nodes "$TARGET_IP" \
          -o yaml 2>/dev/null \
          | grep -oP '(?<=reason: ).*etc-files.*' | head -1 || echo "")

        if [ "$STAGE" = "running" ]; then
          echo "  [${each.key}] Stage: running ✓"
          break
        fi
        if [ -n "$UNMET" ]; then
          echo "  [${each.key}] Detected stalled boot (etc-files unmet). Triggering hard reset via Proxmox..."
          ssh $SSH_OPTS root@"$PVE_IP" "qm reset $VMID" 2>/dev/null || true
          # Wait for node to disappear and reappear
          sleep 20
          REBOOT_DEADLINE=$(( $(date +%s) + 300 ))
          while [ "$(date +%s)" -lt "$REBOOT_DEADLINE" ]; do
            if timeout 3 bash -c "echo >/dev/tcp/$TARGET_IP/50000" 2>/dev/null; then
              echo "  [${each.key}] Back online after reset ✓"
              break
            fi
            echo "  [${each.key}] Waiting for recovery..."
            sleep 10
          done
          # Reset stall deadline to give it another 3 min to clear
          STALL_DEADLINE=$(( $(date +%s) + 180 ))
        else
          echo "  [${each.key}] Stage: $${STAGE:-booting}, not yet stalled. Waiting..."
        fi
        sleep 15
      done
      exit 0
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 8 — Bootstrap etcd via talosctl
# ---------------------------------------------------------------------------

resource "null_resource" "bootstrap_etcd" {
  triggers = {
    cluster_name = var.cluster_name
    first_cp_ip  = local.first_cp_ip
    secrets_hash = sha256(jsonencode(talos_machine_secrets.this.machine_secrets))
  }

  depends_on = [null_resource.start_and_configure_talos]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      TALOS_CONFIG = data.talos_client_configuration.this.talos_config
      # All node IPs (space-separated) for auto-recovery EPHEMERAL reset
      TF_NODE_IPS  = join(" ", [for _, cfg in var.nodes : cfg.ip])
    }
    command = <<-BASH
      set -euo pipefail
      TALOSCONFIG="${local.generated_dir}/talosconfig"
      CP_IP="${local.first_cp_ip}"

      # Always write talosconfig from the provider output so it is never stale
      # after a fresh git checkout (local_sensitive_file is skipped when unchanged).
      mkdir -p "$(dirname "$TALOSCONFIG")"
      printf '%s' "$TALOS_CONFIG" > "$TALOSCONFIG"
      chmod 0600 "$TALOSCONFIG"

      echo "==> Bootstrapping etcd on $CP_IP..."
      talosctl bootstrap \
        --talosconfig "$TALOSCONFIG" \
        --endpoints "$CP_IP" \
        --nodes "$CP_IP" \
        2>&1 || echo "  (bootstrap returned non-zero — may already be bootstrapped, continuing)"

      echo "==> Waiting for Kubernetes API to be healthy (up to 35 min)..."
      # Total deadline: 35 minutes. After 10 minutes, if nodes are still NotReady,
      # attempt to fix stale EPHEMERAL partition (causes 'exec format error' for
      # kube-proxy/flannel on freshly deployed nodes that reused Proxmox storage blocks).
      DEADLINE=$(( $(date +%s) + 2100 ))
      RECOVERY_AFTER=$(( $(date +%s) + 600 ))
      RECOVERY_DONE=""
      KUBE_TMP=$(mktemp)
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        # Get a fresh kubeconfig and check all nodes are Ready.
        # talosctl health requires stage=running which can stay "booting" on
        # already-configured nodes — kubectl get nodes is a reliable substitute.
        if talosctl kubeconfig "$KUBE_TMP" --force \
             --talosconfig "$TALOSCONFIG" \
             --endpoints "$CP_IP" \
             --nodes "$CP_IP" 2>/dev/null; then
          READY=$(KUBECONFIG="$KUBE_TMP" kubectl get nodes --no-headers 2>/dev/null \
                  | grep -c " Ready " || true)
          TOTAL=$(KUBECONFIG="$KUBE_TMP" kubectl get nodes --no-headers 2>/dev/null \
                  | wc -l || true)
          if [ "$TOTAL" -gt 0 ] && [ "$READY" -eq "$TOTAL" ]; then
            echo "==> Cluster healthy ✓ ($READY/$TOTAL nodes Ready)"
            rm -f "$KUBE_TMP"
            exit 0
          fi
          echo "  Nodes ready: $READY/$TOTAL — waiting..."
          # After 10 minutes with NotReady nodes, try resetting EPHEMERAL partition.
          # This fixes 'exec format error' caused by stale containerd image layers
          # that can persist when Proxmox reuses underlying storage blocks for new VMs.
          if [ -z "$RECOVERY_DONE" ] && [ "$(date +%s)" -gt "$RECOVERY_AFTER" ] && [ "$TOTAL" -gt 0 ] && [ "$READY" -lt "$TOTAL" ]; then
            echo "==> Auto-recovery: resetting EPHEMERAL on NotReady nodes..."
            RECOVERY_DONE=1
            # Get all node IPs from talosconfig context
            for NODE_IP in $TF_NODE_IPS; do
              NODE_STATUS=$(KUBECONFIG="$KUBE_TMP" kubectl get node -o wide --no-headers 2>/dev/null \
                | awk -v ip="$NODE_IP" '$6==ip {print $2}')
              if echo "$NODE_STATUS" | grep -q "NotReady"; then
                echo "  Resetting EPHEMERAL on $NODE_IP (NotReady)..."
                talosctl reset \
                  --talosconfig "$TALOSCONFIG" \
                  --endpoints "$CP_IP" \
                  --nodes "$NODE_IP" \
                  --system-labels-to-wipe EPHEMERAL \
                  --reboot \
                  --wait=false 2>&1 || echo "  reset trigger failed for $NODE_IP (may already be resetting)"
                sleep 5
              fi
            done
            echo "  Recovery triggered — waiting 90s for nodes to reboot..."
            sleep 90
          fi
        else
          echo "  Kubernetes API not yet reachable — waiting..."
        fi
        sleep 20
      done
      rm -f "$KUBE_TMP"
      echo "ERROR: Cluster not healthy after 35 minutes" >&2
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


