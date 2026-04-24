# =============================================================================
# platform-bootstrap module — variables.tf
# =============================================================================

variable "cluster_name" {
  description = "Kubernetes cluster name — used as the ArgoCD AppProject name."
  type        = string
}

variable "environment" {
  description = "Deployment environment (ontwikkel | productie)."
  type        = string

  validation {
    condition     = contains(["ontwikkel", "productie"], var.environment)
    error_message = "environment must be 'ontwikkel' or 'productie'."
  }
}

variable "ha_mode" {
  description = <<-EOT
    Enable HA mode for ArgoCD (replicas=2 for server and applicationSet).
    Set to true for productie, false for ontwikkel.
  EOT
  type        = bool
  default     = false
}

variable "argocd_chart_version" {
  description = "ArgoCD Helm chart version (argo/argo-cd). Pinned for reproducibility."
  type        = string
  default     = "7.8.23"

  validation {
    condition     = can(regex("^\\d+\\.\\d+\\.\\d+", var.argocd_chart_version))
    error_message = "argocd_chart_version must be a valid semver string."
  }
}

variable "git_repo_url" {
  description = <<-EOT
    Git repository URL containing the platform's Kubernetes manifests.
    ArgoCD's ApplicationSet git generator scans the `kubernetes/` directory
    of this repo and creates an Application per subdirectory.
  EOT
  type        = string
  default     = "https://github.com/Werewolf-p/InfraWeaver-platform"

  validation {
    condition     = can(regex("^https?://|^git@", var.git_repo_url))
    error_message = "git_repo_url must be a valid HTTP(S) or SSH Git URL."
  }
}

variable "git_revision" {
  description = "Git branch, tag, or commit SHA that ArgoCD tracks."
  type        = string
  default     = "HEAD"
}

variable "argocd_namespace" {
  description = "Kubernetes namespace where ArgoCD is installed."
  type        = string
  default     = "argocd"
}

variable "kubernetes_apps_path" {
  description = "Path inside the git repo where per-application directories live."
  type        = string
  default     = "kubernetes"
}
