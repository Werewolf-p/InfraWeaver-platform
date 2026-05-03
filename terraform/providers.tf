# =============================================================================
# Root module — providers.tf
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.104"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.10"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.1"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Proxmox provider
#
# Connects to the Proxmox cluster management API at proxmox_host:8006.
# SSH is configured with the deployer key; the provider resolves per-node SSH
# connections via the Proxmox API for operations that require node-level SSH.
# ---------------------------------------------------------------------------

locals {
  cluster_config               = yamldecode(file("${path.root}/../envs/${var.environment}/cluster.yaml"))
  proxmox_host                 = local.cluster_config.proxmox_host
  proxmox_ssh_private_key_file = pathexpand("~/.ssh/deployer_ed25519")

  # Generated kubeconfig path — written by local_sensitive_file.kubeconfig
  kubeconfig_path = "${path.root}/../envs/${var.environment}/generated/kubeconfig"
}

provider "proxmox" {
  endpoint  = "https://${local.proxmox_host}:8006/"
  api_token = var.proxmox_api_token
  insecure  = true # Proxmox commonly uses self-signed certs in homelab

  ssh {
    agent       = false
    username    = "root"
    private_key = file(local.proxmox_ssh_private_key_file)
  }
}

# ---------------------------------------------------------------------------
# Talos provider — no configuration needed; all parameters are passed per-resource
# ---------------------------------------------------------------------------

provider "talos" {}

# ---------------------------------------------------------------------------
# Kubernetes provider
#
# Reads the kubeconfig written by the talos-cluster module into
# envs/ENV/generated/kubeconfig.
#
# IMPORTANT: On first apply, run with -target=module.talos_cluster first so
# this file is created before the kubernetes/helm providers are used:
#
#   tofu apply -target=module.talos_cluster
#   tofu apply
# ---------------------------------------------------------------------------

provider "kubernetes" {
  config_path = local.kubeconfig_path
}

# ---------------------------------------------------------------------------
# Helm provider — same kubeconfig as kubernetes provider
# ---------------------------------------------------------------------------

provider "helm" {
  kubernetes {
    config_path = local.kubeconfig_path
  }
}

# ---------------------------------------------------------------------------
# Null, local, time providers — no configuration required
# ---------------------------------------------------------------------------

provider "null" {}
provider "local" {}
provider "time" {}
provider "random" {}
