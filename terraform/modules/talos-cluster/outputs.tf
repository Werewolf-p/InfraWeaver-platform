# =============================================================================
# talos-cluster module — outputs.tf
# =============================================================================

output "kubeconfig" {
  description = "Raw kubeconfig YAML for the deployed cluster (admin credentials)."
  value       = data.talos_cluster_kubeconfig.this.kubeconfig_raw
  sensitive   = true
}

output "talosconfig" {
  description = "Raw talosconfig YAML for talosctl access to the cluster."
  value       = data.talos_client_configuration.this.talos_config
  sensitive   = true
}

output "cluster_endpoint" {
  description = "Kubernetes API server endpoint (https://<first-CP-IP>:6443)."
  value       = "https://${local.first_cp_ip}:6443"
}

output "node_ips" {
  description = "Map of node names to their assigned IP addresses."
  value       = { for name, cfg in var.nodes : name => cfg.ip }
}

output "controlplane_ips" {
  description = "List of control plane node IP addresses."
  value       = [for name, cfg in var.nodes : cfg.ip if cfg.controlplane]
}

output "talos_machine_secrets" {
  description = "Talos machine secrets resource (for cross-module reference)."
  value       = talos_machine_secrets.this
  sensitive   = true
}
