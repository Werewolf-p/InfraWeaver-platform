# =============================================================================
# Root module — outputs.tf
# =============================================================================

output "cluster_endpoint" {
  description = "Kubernetes API server endpoint URL."
  value       = module.talos_cluster.cluster_endpoint
}

output "node_ips" {
  description = "Map of Talos node names to their IP addresses."
  value       = module.talos_cluster.node_ips
}

output "controlplane_ips" {
  description = "List of control-plane node IP addresses."
  value       = module.talos_cluster.controlplane_ips
}

output "kubeconfig_path" {
  description = "Local path to the generated kubeconfig file."
  value       = "${path.root}/../envs/${var.environment}/generated/kubeconfig"
}

output "talosconfig_path" {
  description = "Local path to the generated talosconfig file."
  value       = "${path.root}/../envs/${var.environment}/generated/talosconfig"
}

output "kubeconfig" {
  description = "Raw kubeconfig YAML (admin credentials — handle with care)."
  value       = module.talos_cluster.kubeconfig
  sensitive   = true
}

output "talosconfig" {
  description = "Raw talosconfig YAML for talosctl."
  value       = module.talos_cluster.talosconfig
  sensitive   = true
}

output "argocd_namespace" {
  description = "Namespace where ArgoCD is deployed (if platform_bootstrap is enabled)."
  value       = var.deploy_platform_bootstrap ? module.platform_bootstrap[0].argocd_namespace : null
}
