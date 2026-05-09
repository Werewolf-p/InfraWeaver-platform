# =============================================================================
# Root module — variables.tf
# =============================================================================

# ---------------------------------------------------------------------------
# Secrets (values come from SOPS-decrypted envs/ENV/secrets.sops.yaml)
# ---------------------------------------------------------------------------

variable "proxmox_api_token" {
  description = <<-EOT
    Proxmox API token in format: <user>@<realm>!<token>=<uuid>.
    Example: terraform@pve!platform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    
    **SECRET SOURCE**: GitHub Actions Secrets → TF_VAR_proxmox_api_token environment variable.
    See .github/workflows/full-redeploy.yml for implementation.
    In workflows, pass as: export TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN"
    
    Supply via TF_VAR_proxmox_api_token or GitHub Secrets.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^.+@.+!.+=.+$", var.proxmox_api_token))
    error_message = "proxmox_api_token must be in format: <user>@<realm>!<token>=<uuid>."
  }
}


variable "openbao_address" {
  description = "OpenBao API address (e.g. https://10.25.0.241:8200). Read from cluster.yaml."
  type        = string
  default     = ""

  validation {
    condition     = var.openbao_address == "" || can(regex("^https?://", var.openbao_address))
    error_message = "openbao_address must be a valid HTTP(S) URL or empty string."
  }
}

variable "github_runner_token" {
  description = <<-EOT
    GitHub Actions runner registration token.
    
    **SECRET SOURCE**: GitHub Actions Secrets → TF_VAR_github_runner_token environment variable.
    See .github/workflows/full-redeploy.yml for implementation.
    In workflows, pass as: export TF_VAR_github_runner_token="$GITHUB_RUNNER_TOKEN"
    
    Supply via TF_VAR_github_runner_token or GitHub Secrets.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

# ---------------------------------------------------------------------------
# Cluster identity (non-sensitive; may be set in terraform.tfvars)
# ---------------------------------------------------------------------------

variable "cluster_name" {
  description = "Kubernetes cluster name. Must match cluster.yaml cluster_name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.cluster_name))
    error_message = "cluster_name must be a lowercase DNS label (2–63 chars, [a-z0-9-])."
  }
}

variable "environment" {
  description = "Deployment environment. Controls HA mode and state backend path."
  type        = string

  validation {
    condition     = contains(["ontwikkel", "productie"], var.environment)
    error_message = "environment must be 'ontwikkel' or 'productie'."
  }
}

# ---------------------------------------------------------------------------
# Platform Git repository (used by ArgoCD ApplicationSet)
# ---------------------------------------------------------------------------

variable "git_repo_url" {
  description = "Git repository URL for the platform kubernetes manifests."
  type        = string
  default     = "https://github.com/Werewolf-p/InfraWeaver-platform"
}

variable "git_revision" {
  description = "Git branch/tag/commit ArgoCD tracks for platform manifests."
  type        = string
  default     = "main"
}

# ---------------------------------------------------------------------------
# Feature flags
# ---------------------------------------------------------------------------

variable "deploy_platform_bootstrap" {
  description = <<-EOT
    Set to true to deploy the platform-bootstrap module (ArgoCD + ApplicationSet).
    On first apply, set to false (or use -target) until the cluster is ready and
    the kubeconfig has been written to envs/ENV/generated/kubeconfig.
  EOT
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Service VMs (cloud-init-template, github-runner, openbao)
# ---------------------------------------------------------------------------

variable "proxmox_nodes" {
  description = "Map of Proxmox nodes (name → config with ip, cluster). Used by service VM modules."
  type = map(object({
    ip             = string
    cluster        = optional(string)
    vm_id          = optional(number)
    cores          = optional(number)
    sockets        = optional(number)
    memory_mb      = optional(number)
    disk_size_gb   = optional(number)
    disk_datastore = optional(string)
    gateway        = optional(string)
    subnet_mask    = optional(number)
  }))
  default = {}
}

variable "node_defaults" {
  description = "Default node settings for service VMs."
  type = object({
    cores          = optional(number, 4)
    sockets        = optional(number, 1)
    memory_mb      = optional(number, 8192)
    disk_size_gb   = optional(number, 64)
    disk_datastore = optional(string, "local-lvm")
    gateway        = optional(string)
    subnet_mask    = optional(number, 24)
  })
  default = {}
}

variable "proxmox_default_gateway" {
  description = "Default gateway for service VMs."
  type        = string
  default     = "10.25.0.1"
}

variable "proxmox_dns_servers" {
  description = "DNS servers for service VMs."
  type        = list(string)
  default     = ["8.8.8.8", "1.1.1.1"]
}

variable "cloud_init_templates" {
  description = "Cloud-init VM templates to create on Proxmox."
  type = map(object({
    vm_id       = number
    name        = string
    image_url   = string
    cores       = optional(number, 2)
    memory_mb   = optional(number, 2048)
    disk_size_gb = optional(number, 20)
    storage     = optional(string, "local-lvm")
  }))
  default = {}
}

variable "github_runners" {
  description = "GitHub Actions self-hosted runner VMs."
  type = map(object({
    vm_id          = number
    ip             = string
    template_vm_id = number
    cores          = optional(number, 2)
    memory_mb      = optional(number, 2048)
    disk_size_gb   = optional(number, 30)
    storage        = optional(string, "local-lvm")
    repo_url       = string
    labels         = optional(list(string), [])
  }))
  default = {}
}

variable "openbao_instances" {
  description = "OpenBao (Vault) VM instances."
  type = map(object({
    vm_id          = number
    ip             = string
    template_vm_id = number
    cores          = optional(number, 2)
    memory_mb      = optional(number, 1024)
    disk_size_gb   = optional(number, 15)
    storage        = optional(string, "local-lvm")
  }))
  default = {}
}

variable "netbird_routers" {
  description = "NetBird routing peer VMs — lightweight VLAN3 VMs running NetBird as a routing peer for 10.10.0.0/24."
  type = map(object({
    vm_id          = number
    ip             = string
    gateway        = string
    template_vm_id = number
    cores          = optional(number, 2)
    memory_mb      = optional(number, 1024)
    disk_size_gb   = optional(number, 20)
    storage        = optional(string, "lvm-proxmox")
    subnet_mask    = optional(number, 24)
  }))
  default = {}
}

variable "proxmox_runner_ssh_public_key" {
  description = "SSH public key for runner VM access."
  type        = string
  default     = ""
}

variable "proxmox_host_ssh_public_key" {
  description = "SSH public key of the Proxmox host (for template deployments)."
  type        = string
  default     = ""
}

variable "proxmox_extra_ssh_public_keys" {
  description = "Additional SSH public keys to inject into service VMs."
  type        = list(string)
  default     = []
}
