# =============================================================================
# platform-bootstrap module — outputs.tf
# =============================================================================

output "argocd_namespace" {
  description = "Namespace where ArgoCD was installed."
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "app_project_name" {
  description = "ArgoCD AppProject name created for this cluster."
  value       = kubernetes_manifest.app_project.manifest.metadata.name
}

output "applicationset_name" {
  description = "ArgoCD ApplicationSet name that drives platform app deployments."
  value       = kubernetes_manifest.platform_applicationset.manifest.metadata.name
}
