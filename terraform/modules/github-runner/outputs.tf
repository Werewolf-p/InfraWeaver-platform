output "runner_info" {
  description = "Map of cluster name → runner VM info."
  value = {
    for name, rcfg in local.valid_runners : name => {
      vm_id    = rcfg.vm_id
      ip       = rcfg.ip
      repo_url = rcfg.repo_url
      labels   = rcfg.labels
    }
  }
}
