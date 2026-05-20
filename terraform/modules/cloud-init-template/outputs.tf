output "template_targets" {
  description = "Map of target key → node name/IP where templates were created."
  value = {
    for k, v in local.target_nodes : k => {
      name = v.name
      ip   = v.ip
    }
  }
}
