variable "proxmox_node_ip" {
  description = "IP address of the Proxmox node to SSH into for VM creation."
  type        = string
}

variable "proxmox_ssh_private_key_file" {
  description = "Path to SSH private key for authenticating to Proxmox and to the new VM."
  type        = string
}

variable "netbird_routers" {
  description = "Map of NetBird routing peer VMs to create."
  type = map(object({
    vm_id          = number
    ip             = string
    gateway        = string
    template_vm_id = number
    cores          = optional(number, 2)
    memory_mb      = optional(number, 1024)
    disk_size_gb   = optional(number, 20)
    storage        = optional(string, "lvm-proxmox")
    subnet_mask    = optional(number, 24)
  }))
}

variable "netbird_setup_key" {
  description = "NetBird setup key used by the routing peer to register with management."
  type        = string
  sensitive   = true
  # A1B2C3D4-E5F6-7890-ABCD-EF1234567890 is the bootstrap key set in bootstrap-job.yaml
  default     = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
}

variable "netbird_management_url" {
  description = "NetBird management server URL (must be reachable from VLAN3)."
  type        = string
  default     = "https://netbird.int.rlservers.com"
}

variable "router_ssh_keys" {
  description = "SSH public keys to inject into the routing peer VM via cloud-init."
  type        = list(string)
  default     = []
}
