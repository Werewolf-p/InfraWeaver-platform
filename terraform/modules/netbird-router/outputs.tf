output "router_ips" {
  description = "Map of router name → IP address."
  value       = { for name, cfg in var.netbird_routers : name => cfg.ip }
}
