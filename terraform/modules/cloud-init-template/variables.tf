variable "proxmox_ssh_private_key_file" {
  description = "Path to SSH private key."
  type        = string
}

variable "proxmox_default_gateway" {
  description = "Default gateway IP for nodes (e.g. 10.25.0.1). Root-level override."
  type        = string
  default     = "10.25.0.1"
}

variable "proxmox_nodes" {
  description = "Map of Proxmox nodes (name → config with ip, cluster)."
  type = map(object({
    ip             = string
    cluster        = optional(string)
    vm_id          = optional(number)
    cores          = optional(number)
    sockets        = optional(number)
    memory_mb      = optional(number)
    disk_size_gb   = optional(number)
    disk_datastore = optional(string)
    gateway        = optional(string)
    subnet_mask    = optional(number)
  }))
}

variable "node_defaults" {
  description = "Default node settings."
  type = object({
    cores          = optional(number, 4)
    sockets        = optional(number, 1)
    memory_mb      = optional(number, 8192)
    disk_size_gb   = optional(number, 64)
    disk_datastore = optional(string, "lvm-proxmox")
    gateway        = optional(string)
    subnet_mask    = optional(number, 24)
  })
  default = {}
}

variable "cloud_init_templates" {
  description = "Map of cloud-init template definitions."
  type = map(object({
    vm_id        = number
    name         = string
    image_url    = string
    cores        = optional(number, 2)
    memory_mb    = optional(number, 2048)
    disk_size_gb = optional(number, 20)
    storage      = optional(string, "local-lvm")
  }))
  default = {}
}

variable "runner_ssh_keys" {
  description = "SSH public keys to inject into templates."
  type        = list(string)
  default     = []
}
