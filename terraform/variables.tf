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

variable "openbao_token" {
  description = <<-EOT
    OpenBao (Vault) root or platform service token.
    
    **SECRET SOURCE**: GitHub Actions Secrets → TF_VAR_openbao_token environment variable.
    See .github/workflows/full-redeploy.yml for implementation.
    In workflows, pass as: export TF_VAR_openbao_token="$OPENBAO_TOKEN"
    
    Supply via TF_VAR_openbao_token or GitHub Secrets.
  EOT
  type        = string
  sensitive   = true
  default     = ""
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
  default     = "HEAD"
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
