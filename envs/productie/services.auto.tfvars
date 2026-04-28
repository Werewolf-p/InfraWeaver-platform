# =============================================================================
# Service VMs — productie environment
# Deployed on Proxmox node at 10.25.0.3 (node name: "proxmox")
# =============================================================================

proxmox_nodes = {
  proxmox = { ip = "10.25.0.3", cluster = "productie" }
}

node_defaults = {
  cores          = 4
  sockets        = 1
  memory_mb      = 8192
  disk_size_gb   = 32
  disk_datastore = "lvm-proxmox"
  gateway        = "10.25.0.1"
  subnet_mask    = 24
}

proxmox_dns_servers = ["8.8.8.8", "1.1.1.1"]

cloud_init_templates = {
  ubuntu-2404 = {
    vm_id        = 9000
    name         = "ubuntu-24.04-cloudinit"
    image_url    = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
    cores        = 2
    memory_mb    = 2048
    disk_size_gb = 20
    storage      = "lvm-proxmox"
  }
}

github_runners = {
  productie = {
    vm_id          = 9100
    ip             = "10.25.0.85"
    template_vm_id = 9000
    cores          = 4
    memory_mb      = 4096
    disk_size_gb   = 60
    storage        = "lvm-proxmox"
    repo_url       = "https://github.com/Werewolf-p/InfraWeaver-platform"
    labels         = ["prod-worker", "self-hosted", "Linux", "X64"]
  }
}
