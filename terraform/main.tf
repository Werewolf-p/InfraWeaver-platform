# =============================================================================
# Root module — main.tf
#
# Reads cluster topology from envs/ENV/cluster.yaml and wires together the
# talos-cluster and platform-bootstrap modules.
#
# Two-stage apply:
#   Stage 1 — provision the Talos cluster and write generated credentials:
#     tofu apply -target=module.talos_cluster \
#                -target=local_sensitive_file.kubeconfig \
#                -target=local_sensitive_file.talosconfig
#
#   Stage 2 — deploy platform layer (ArgoCD + ApplicationSet):
#     tofu apply
#
# Or set deploy_platform_bootstrap=false in terraform.tfvars to apply both
# stages simultaneously once the cluster is already running.
# =============================================================================

# ---------------------------------------------------------------------------
# Locals — parse cluster.yaml and build derived values
# ---------------------------------------------------------------------------

locals {
  # cluster_config is already read in providers.tf (same locals block would cause
  # a duplicate symbol). We reference it directly here.
  # Note: locals {} in providers.tf defines local.cluster_config; that same
  # local is visible across all files in this root module.

  nodes_raw = local.cluster_config.nodes

  # Normalise node definitions: fill in optional fields from cluster.yaml
  nodes = {
    for name, cfg in local.nodes_raw : name => {
      proxmox_node = cfg.proxmox_node
      ip           = cfg.ip
      mac_address  = try(cfg.mac_address, null)
      controlplane = cfg.controlplane
      cpu          = try(cfg.cpu, 4)
      memory_mb    = try(cfg.memory_mb, 4096)
      disk_gb      = try(cfg.disk_gb, 50)
      datastore    = cfg.datastore
      vm_id        = cfg.vm_id
    }
  }

  # Build proxmox_nodes_ips from cluster.yaml node definitions.
  # In cluster.yaml, the proxmox_node values correspond to PVE nodes that
  # have well-known IPs defined in this map (pve-dev1 → 10.25.0.41, etc.).
  # These IPs are defined per-environment in the cluster.yaml pve_nodes block,
  # or fall back to the static mapping below.
  pve_nodes_ips = try(local.cluster_config.pve_nodes, {})

  # HA mode: productie uses multiple control planes
  ha_mode = var.environment == "productie"
}

# ---------------------------------------------------------------------------
# Talos cluster
# ---------------------------------------------------------------------------

module "talos_cluster" {
  source = "./modules/talos-cluster"

  # Proxmox API connection
  proxmox_endpoint             = "https://${local.proxmox_host}:8006/"
  proxmox_api_token            = var.proxmox_api_token
  proxmox_tls_insecure         = true
  proxmox_ssh_username         = "root"
  proxmox_ssh_private_key_file = "~/.ssh/deployer_ed25519"
  proxmox_nodes_ips            = local.pve_nodes_ips

  # Cluster identity
  cluster_name       = var.cluster_name
  talos_version      = local.cluster_config.talos_version
  kubernetes_version = local.cluster_config.kubernetes_version

  # Node definitions
  nodes = local.nodes

  # Network
  gateway       = local.cluster_config.gateway
  nameservers   = local.cluster_config.nameservers
  subnet_prefix = local.cluster_config.subnet_prefix

  talos_image_datastore = local.cluster_config.talos_image_datastore

  environment = var.environment
}

# ---------------------------------------------------------------------------
# Write generated credentials to envs/ENV/generated/
#
# These files are .gitignored. They feed the kubernetes/helm providers on
# subsequent applies and are used by scripts/get-kubeconfig.sh.
# ---------------------------------------------------------------------------

resource "local_sensitive_file" "kubeconfig" {
  content         = module.talos_cluster.kubeconfig
  filename        = "${path.root}/../envs/${var.environment}/generated/kubeconfig"
  file_permission = "0600"

  depends_on = [module.talos_cluster]
}

resource "local_sensitive_file" "talosconfig" {
  content         = module.talos_cluster.talosconfig
  filename        = "${path.root}/../envs/${var.environment}/generated/talosconfig"
  file_permission = "0600"

  depends_on = [module.talos_cluster]
}

# ---------------------------------------------------------------------------
# Platform bootstrap — ArgoCD + ApplicationSet
#
# Guarded by deploy_platform_bootstrap so the first apply can skip this
# module while the kubeconfig is being created.
# ---------------------------------------------------------------------------

module "platform_bootstrap" {
  count  = var.deploy_platform_bootstrap ? 1 : 0
  source = "./modules/platform-bootstrap"

  cluster_name = var.cluster_name
  environment  = var.environment
  ha_mode      = local.ha_mode
  git_repo_url = var.git_repo_url
  git_revision = var.git_revision

  depends_on = [
    local_sensitive_file.kubeconfig,
    module.talos_cluster,
  ]
}
