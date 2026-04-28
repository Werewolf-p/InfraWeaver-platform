output "openbao_info" {
  description = "Map of cluster name → OpenBao VM info."
  value = {
    for name, ocfg in local.valid_instances : name => {
      vm_id = ocfg.vm_id
      ip    = ocfg.ip
      url   = "http://${ocfg.ip}:8200"
    }
  }
}
