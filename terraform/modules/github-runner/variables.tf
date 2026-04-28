# ---------------------------------------------------------------------------
# GitHub Runner module — input variables
# ---------------------------------------------------------------------------

variable "proxmox_ssh_private_key_file" {
  description = "Path to SSH private key for the Proxmox nodes."
  type        = string
}

variable "proxmox_nodes" {
  description = "Map of Proxmox VE nodes (name → config)."
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
  description = "Default settings for all nodes."
  type = object({
    cores          = optional(number, 4)
    sockets        = optional(number, 1)
    memory_mb      = optional(number, 8192)
    disk_size_gb   = optional(number, 64)
    disk_datastore = optional(string, "lvm-proxmox")
    gateway        = optional(string)
    subnet_mask    = optional(number, 24)
  })
}

variable "github_runners" {
  description = "Map of GitHub Actions runners. Key = cluster name."
  type = map(object({
    vm_id            = number
    ip               = string
    template_vm_id   = optional(number, 9000)
    cores            = optional(number, 2)
    memory_mb        = optional(number, 2048)
    disk_size_gb     = optional(number, 30)
    storage          = optional(string, "local-lvm")
    repo_url         = string
    additional_repos = optional(list(string), [])
    labels           = optional(list(string), ["self-hosted", "Linux", "X64"])
    gateway          = optional(string)
    subnet_mask      = optional(number)
  }))
  default = {}
}

variable "github_runner_token" {
  description = "GitHub PAT or registration token for runner registration."
  type        = string
  sensitive   = true
}

variable "runner_ssh_keys" {
  description = "SSH public keys to authorize on runner VMs (deployer + host)."
  type        = list(string)
}

variable "proxmox_dns_servers" {
  description = "DNS servers for runner VMs."
  type        = list(string)
  default     = ["10.25.0.43"]
}

variable "proxmox_default_gateway" {
  description = "Default gateway IP for nodes (e.g. 10.25.0.1). Root-level override."
  type        = string
  default     = "10.25.0.1"
}
