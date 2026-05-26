# =============================================================================
# talos-cluster/main.tf
#
# Deploys a Talos Linux Kubernetes cluster on Proxmox VE.
#
# Flow:
#   1. Download Talos disk image onto each unique PVE node via Proxmox API
#   2. Create Proxmox VMs with the downloaded Talos disk attached
#   3. Start VMs, wait for Talos maintenance API (port 50000)
#   4. Generate Talos machine secrets (talos provider)
#   5. Generate per-node machine configs with static IP + hostname patches
#   6. Apply machine configs via Talos API
#   7. Bootstrap etcd on the first control-plane node
#   8. Retrieve kubeconfig once cluster is healthy
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

  # Unique set of PVE node names across all VMs — used to deduplicate downloads
  unique_pve_nodes = toset([for _, cfg in var.nodes : cfg.proxmox_node])

  # Control-plane nodes
  controlplane_nodes = { for n, cfg in var.nodes : n => cfg if cfg.controlplane }

  # First control-plane (alphabetically stable sort) — bootstrap node + API endpoint
  first_cp_name = sort(keys(local.controlplane_nodes))[0]
  first_cp_ip   = local.controlplane_nodes[local.first_cp_name].ip

}

# ---------------------------------------------------------------------------
# Step 1 — Download Talos disk image onto each PVE node via Proxmox API
#          (no SSH required — uses /nodes/{node}/storage/{storage}/download-url)
# ---------------------------------------------------------------------------

resource "proxmox_download_file" "talos_image" {
  for_each = local.unique_pve_nodes

  content_type        = "iso"
  datastore_id        = var.talos_image_datastore
  node_name           = each.key
  url                 = local.talos_image_url
  file_name           = "talos-${var.talos_version}.img"
  # overwrite=false: don't re-download on every apply — the file is stable once
  # decompressed. overwrite_unmanaged=true allows a fresh deployment to overwrite
  # a stale file that exists outside TF state (e.g., from a wiped state).
  # lifecycle.ignore_changes[size]: after null_resource.decompress_talos_image
  # expands the XZ (193 MB) to a raw disk (~4.4 GB), the stored size in state
  # no longer matches; ignoring it prevents spurious VM force-replacements.
  overwrite           = false
  overwrite_unmanaged = true
  upload_timeout      = 1800

  lifecycle {
    ignore_changes = [size]
  }
}

# ---------------------------------------------------------------------------
# Step 1b — Decompress XZ-compressed Talos image on each PVE node
#
# The Talos factory image URL ends in .raw.xz.  The Proxmox download-url API
# stores it as-is; the bpg provider then passes it directly as VM disk bytes,
# resulting in a corrupt (XZ-wrapped) disk unless we decompress first.
#
# This resource SSHes to each PVE node (using the deployer key at
# ~/.ssh/deployer_ed25519) and decompresses the file in-place if XZ magic
# bytes are detected. Idempotent: safe to run on an already-decompressed file.
# ---------------------------------------------------------------------------

resource "null_resource" "decompress_talos_image" {
  for_each = local.unique_pve_nodes

  triggers = {
    node          = each.key
    talos_version = var.talos_version
    # Re-run decompress whenever the download_file resource itself is recreated
    # (e.g. after tofu destroy + re-apply) — the file ID path stays the same but
    # the download_file resource ID changes, forcing re-decompression.
    download_id   = proxmox_download_file.talos_image[each.key].id
  }

  depends_on = [proxmox_download_file.talos_image]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      PROXMOX_TOKEN    = var.proxmox_api_token
      PROXMOX_ENDPOINT = var.proxmox_endpoint
      NODE_NAME        = each.key
      TALOS_VERSION    = var.talos_version
    }
    command = <<-BASH
      set -euo pipefail

      # Discover the actual management IP of the PVE node from the cluster API
      NODE_IP=$(python3 -c "
import urllib.request, ssl, json, sys
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
url = '$${PROXMOX_ENDPOINT}api2/json/cluster/status'
req = urllib.request.Request(url, headers={'Authorization': 'PVEAPIToken=$${PROXMOX_TOKEN}'})
data = json.loads(urllib.request.urlopen(req, context=ctx, timeout=8).read())
for n in (data.get('data') or []):
    if n.get('name') == '$${NODE_NAME}' and n.get('ip'):
        print(n['ip'])
        break
" 2>/dev/null || echo "")

      if [ -z "$NODE_IP" ]; then
        echo "ERROR: Cannot find IP for PVE node '$${NODE_NAME}' in cluster status"
        exit 1
      fi
      echo "==> [decompress] Node $${NODE_NAME} IP: $NODE_IP"

      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ConnectTimeout=15 -o BatchMode=yes \
          -i ~/.ssh/deployer_ed25519 \
          root@"$NODE_IP" \
          "IMG=/var/lib/vz/template/iso/talos-$${TALOS_VERSION}.img; \
           if [ ! -f \"\$IMG\" ]; then echo \"ERROR: Image not found at \$IMG\"; exit 1; fi; \
           MAGIC=\$(od -An -tx1 -N6 \"\$IMG\" | tr -d ' \\n'); \
           if echo \"\$MAGIC\" | grep -qi 'fd377a585a00'; then \
             echo \"XZ detected [\$(du -sh \"\$IMG\" | cut -f1)] — decompressing...\"; \
             xzcat \"\$IMG\" > \"\$IMG.raw.tmp\" && mv \"\$IMG.raw.tmp\" \"\$IMG\"; \
             echo \"Done — raw size: \$(du -sh \"\$IMG\" | cut -f1)\"; \
           else \
             echo \"Image already raw (magic: \$MAGIC) — skipping.\"; \
           fi"
    BASH
  }
}

# ---------------------------------------------------------------------------
# Step 2 — Create Proxmox VMs with the downloaded Talos disk attached
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

  # Do not auto-start on initial creation — Step 4 handles VM startup.
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

  disk {
    datastore_id = each.value.datastore
    file_id      = proxmox_download_file.talos_image[each.value.proxmox_node].id
    interface    = "virtio0"
    discard      = "on"
    size         = each.value.disk_gb
  }

  lifecycle {
    ignore_changes = [
      started,
      description,
    ]
  }

  depends_on = [null_resource.decompress_talos_image]
}

# ---------------------------------------------------------------------------
# Step 3 — Write machine configs and talosconfig to generated/ directory
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
        #
        # Onedev registry mirror: containerd sends the Onedev hostname in the Host
        # header so Traefik can route it correctly. Using HTTP (not HTTPS) avoids
        # the self-signed CA trust issue inside Talos containerd.
        registries = (var.registry_mirror_url != "" || var.onedev_registry_hostname != "") ? {
          mirrors = merge(
            var.registry_mirror_url != "" ? {
              # Mirror docker.io pulls through the local cache first to avoid Hub rate limits.
              # Falls back to registry-1.docker.io if the mirror is unavailable or returns errors.
              "docker.io" = {
                endpoints = [var.registry_mirror_url, "https://registry-1.docker.io"]
              }
            } : {},
            var.onedev_registry_hostname != "" ? {
              # Onedev acts as the registry for InfraWeaver-built images.
              # Use HTTP so containerd sends the correct Host header; Traefik routes to Onedev.
              (var.onedev_registry_hostname) = {
                endpoints = ["http://${var.onedev_registry_hostname}"]
              }
            } : {}
          )
          config = merge(
            var.registry_mirror_url != "" ? {
              (trimprefix(trimprefix(var.registry_mirror_url, "https://"), "http://")) = {
                tls = {
                  insecureSkipVerify = true
                }
              }
            } : {},
            var.onedev_registry_hostname != "" ? {
              (var.onedev_registry_hostname) = {
                tls = {
                  insecureSkipVerify = true
                }
              }
            } : {}
          )
        } : null
        kubelet = {
          extraArgs = {
            # kube-reserved accounts for static control-plane pods (kube-apiserver ~1.6Gi,
            # etcd ~300Mi, kube-scheduler, kube-controller-manager) + kubelet + containerd.
            # These run outside the pod cgroup so must be reserved explicitly.
            kube-reserved               = "memory=2Gi,cpu=500m"
            # system-reserved covers Talos OS, kernel, and system daemons (iscsid, etc.)
            system-reserved             = "memory=512Mi,cpu=200m"
            # Hard eviction: kubelet force-kills pods at 800Mi available to prevent kernel OOM.
            # Soft eviction: graceful 2-minute window starts at 1.5Gi to avoid abrupt kills.
            eviction-hard               = "memory.available<800Mi,nodefs.available<10%"
            eviction-soft               = "memory.available<1.5Gi,nodefs.available<15%"
            eviction-soft-grace-period  = "memory.available=2m,nodefs.available=5m"
            # Enforce reserved memory via cgroups so pods cannot consume system memory.
            enforce-node-allocatable    = "pods"
          }
        }
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
            # Auto-compact the etcd keyspace every hour to prevent fragmentation buildup.
            # Without compaction, revisions accumulate → large DB → slow fsync → leader elections.
            # Periodic mode compacts all revisions older than 1h (retains latest state).
            auto-compaction-mode      = "periodic"
            auto-compaction-retention = "1h"
            # NOTE: experimental-compact-hash-check-enabled and experimental-initial-corrupt-check
            # are reserved flags managed internally by Talos (both v1.12 and v1.13). They CANNOT be
            # set via extraArgs — Talos rejects them with "extra arg is not allowed".
            # Talos v1.13.0 no longer hardcodes these as true; they default to false, which
            # resolves the ~71-min node reboot cycle that occurred on Proxmox VMs in v1.12.7.
            # See: kubernetes/core/argocd/manifests/etcd-healer.yaml for full incident history.
          }
        }
        # Tune kube-apiserver to reduce memory pressure on all-control-plane homelab clusters.
        # Default max-requests-inflight=800 can cause OOM when 40+ pods run on the same node.
        # Reducing in-flight limits cuts peak memory by ~30% with negligible latency impact.
        apiServer = {
          extraArgs = {
            max-requests-inflight         = "400"
            max-mutating-requests-inflight = "200"
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
    # Include the VM's MAC address so this null_resource is re-triggered whenever
    # the VM is replaced (MAC is randomly re-assigned on recreation even if VMID
    # stays the same — ensuring Talos is reconfigured on the fresh VM).
    vm_mac  = proxmox_virtual_environment_vm.talos[each.key].network_device[0].mac_address
  }

  depends_on = [
    proxmox_virtual_environment_vm.talos,
    local_sensitive_file.node_machine_config,
    local_sensitive_file.talosconfig_generated,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      PROXMOX_TOKEN    = var.proxmox_api_token
      PROXMOX_ENDPOINT = var.proxmox_endpoint
    }
    command = <<-BASH
      set -euo pipefail
      PVE_NODE="${each.value.proxmox_node}"
      VMID="${each.value.vm_id}"
      TARGET_IP="${each.value.ip}"
      MC_FILE="${local.generated_dir}/mc-${each.key}.yaml"

      # ── Start VM ────────────────────────────────────────────────────────────
      VM_STATUS=$(curl -sk \
        -H "Authorization: PVEAPIToken=$PROXMOX_TOKEN" \
        "$${PROXMOX_ENDPOINT}api2/json/nodes/$PVE_NODE/qemu/$VMID/status/current" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status','stopped'))" 2>/dev/null || echo "stopped")
      if [ "$VM_STATUS" != "running" ]; then
        echo "==> [${each.key}] Starting VM $VMID on $PVE_NODE..."
        curl -sk -X POST \
          -H "Authorization: PVEAPIToken=$PROXMOX_TOKEN" \
          "$${PROXMOX_ENDPOINT}api2/json/nodes/$PVE_NODE/qemu/$VMID/status/start" > /dev/null
        echo "  VM started."
      else
        echo "==> [${each.key}] VM $VMID already running."
      fi

      # ── Discover IP: scan cluster network from init VM, match by MAC ────────
      # Init VM has a NIC on the cluster VLAN (ens19/10.x.x.50) so it can
      # reach nodes directly. Derive scan subnet from gateway (first 3 octets).
      # Scan for port 50000 (Talos API in maintenance mode), then ARP-match MAC.
      CLUSTER_SUBNET=$(echo "${var.gateway}" | cut -d. -f1-3)
      MAC=$(curl -sk \
        -H "Authorization: PVEAPIToken=$PROXMOX_TOKEN" \
        "$${PROXMOX_ENDPOINT}api2/json/nodes/$PVE_NODE/qemu/$VMID/config" \
        | python3 -c "
import sys, json, re
cfg = json.load(sys.stdin).get('data', {})
net = cfg.get('net0', '')
m = re.search(r'virtio=([0-9a-fA-F:]+)', net, re.IGNORECASE)
print(m.group(1).lower() if m else '')
" 2>/dev/null || echo "")
      echo "==> [${each.key}] VM MAC: $MAC"

      DHCP_IP=""
      echo "==> [${each.key}] Scanning $${CLUSTER_SUBNET}.0/24 for Talos API (up to 10 min)..."
      for attempt in $(seq 1 40); do
        TMPF=$(mktemp /tmp/talos_XXXXXX)
        for last in $(seq 1 254); do
          ip_="$${CLUSTER_SUBNET}.$last"
          (timeout 0.3 bash -c "echo >/dev/tcp/$ip_/50000" 2>/dev/null && echo "$ip_" >> "$TMPF") &
        done
        wait 2>/dev/null; sleep 0.5
        if [ -s "$TMPF" ]; then
          while IFS= read -r cip; do
            # Ping to ensure ARP entry is populated, then check MAC
            ping -c1 -W1 "$cip" >/dev/null 2>&1 || true
            cmac=$(ip neigh show "$cip" 2>/dev/null | awk '{print tolower($5)}' | head -1)
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
        echo "ERROR: Could not find Talos API for ${each.key} (MAC: $MAC) on $${CLUSTER_SUBNET}.0/24" >&2
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
          curl -sk -X POST \
            -H "Authorization: PVEAPIToken=$PROXMOX_TOKEN" \
            "$${PROXMOX_ENDPOINT}api2/json/nodes/$PVE_NODE/qemu/$VMID/status/reset" > /dev/null || true
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
    cluster_name    = var.cluster_name
    first_cp_ip     = local.first_cp_ip
    secrets_hash    = sha256(jsonencode(talos_machine_secrets.this.machine_secrets))
    # Re-bootstrap whenever any node's configure step was re-triggered (e.g.
    # after VM replacement). Without this, bootstrap_etcd keeps its old state
    # even if the VMs are fresh and un-bootstrapped.
    configure_ids   = join(",", [for k, v in null_resource.start_and_configure_talos : v.id])
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


