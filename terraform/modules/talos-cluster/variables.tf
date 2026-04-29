# =============================================================================
# talos-cluster module — variables.tf
# =============================================================================

# ---------------------------------------------------------------------------
# Proxmox connection
# ---------------------------------------------------------------------------

variable "proxmox_endpoint" {
  description = "Proxmox API endpoint URL (e.g. https://10.25.0.3:8006/)."
  type        = string

  validation {
    condition     = can(regex("^https?://", var.proxmox_endpoint))
    error_message = "proxmox_endpoint must be a valid HTTP(S) URL."
  }
}

variable "proxmox_api_token" {
  description = "Proxmox API token in format: <user>@<realm>!<token>=<uuid>."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^.+@.+!.+=.+$", var.proxmox_api_token))
    error_message = "proxmox_api_token must be in format: <user>@<realm>!<token>=<uuid>."
  }
}

variable "proxmox_tls_insecure" {
  description = "Skip TLS verification for Proxmox API (required for self-signed certs)."
  type        = bool
  default     = true
}

variable "proxmox_ssh_username" {
  description = "SSH username on Proxmox nodes (must have qm/pvesm access)."
  type        = string
  default     = "root"
}

variable "proxmox_ssh_private_key_file" {
  description = "Path to the SSH private key used to connect to Proxmox nodes."
  type        = string
  default     = "~/.ssh/deployer_ed25519"
}

variable "proxmox_nodes_ips" {
  description = <<-EOT
    Map of Proxmox node names to their management SSH IP addresses.
    Required so disk import operations (qm importdisk) can be run via SSH on
    the correct PVE node, which must host the VM being configured.

    Example:
      {
        "pve-dev1" = "10.25.0.41"
        "pve-dev2" = "10.25.0.42"
      }
  EOT
  type        = map(string)

  validation {
    condition = alltrue([
      for name, ip in var.proxmox_nodes_ips :
      can(regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", ip))
    ])
    error_message = "All proxmox_nodes_ips values must be valid IPv4 addresses."
  }
}

# ---------------------------------------------------------------------------
# Cluster identity
# ---------------------------------------------------------------------------

variable "cluster_name" {
  description = "Kubernetes cluster name (used in Talos config and kubeconfig context)."
  type        = string
}

variable "talos_version" {
  description = "Talos Linux version to deploy (e.g. v1.10.0)."
  type        = string
  default     = "v1.10.9"

  validation {
    condition     = can(regex("^v\\d+\\.\\d+\\.\\d+", var.talos_version))
    error_message = "talos_version must be in the format v<major>.<minor>.<patch>."
  }
}

variable "kubernetes_version" {
  description = "Kubernetes version to run inside Talos (e.g. v1.33.0)."
  type        = string
  default     = "v1.33.0"

  validation {
    condition     = can(regex("^v\\d+\\.\\d+\\.\\d+", var.kubernetes_version))
    error_message = "kubernetes_version must be in the format v<major>.<minor>.<patch>."
  }
}

# ---------------------------------------------------------------------------
# Node definitions
# ---------------------------------------------------------------------------

variable "nodes" {
  description = <<-EOT
    Map of Talos cluster nodes. Key = hostname used inside the OS.

    Schema per node:
      proxmox_node  – required: name of the PVE cluster node to place the VM on
      ip            – required: static IP address for the Talos node (VLAN 3)
      mac_address   – optional: fixed MAC address; configure a DHCP reservation on
                      the VLAN 3 router so the node always receives this IP on first boot
      controlplane  – required: true for control-plane / etcd nodes, false for workers
      cpu           – optional: vCPU count (default 4)
      memory_mb     – optional: RAM in MB (default 4096)
      disk_gb       – optional: root disk size in GB (default 50)
      datastore     – required: Proxmox storage ID where the disk is created
      vm_id         – required: Proxmox VM ID (must be unique in the cluster)
  EOT
  type = map(object({
    proxmox_node = string
    ip           = string
    mac_address  = optional(string)
    controlplane = bool
    cpu          = optional(number, 4)
    memory_mb    = optional(number, 4096)
    disk_gb      = optional(number, 50)
    datastore    = string
    vm_id        = number
  }))

  validation {
    condition = alltrue([
      for name, cfg in var.nodes :
      can(regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", cfg.ip))
    ])
    error_message = "All node IPs must be valid IPv4 addresses."
  }

  validation {
    condition = alltrue([
      for name, cfg in var.nodes : cfg.vm_id >= 100 && cfg.vm_id <= 999999999
    ])
    error_message = "All node vm_id values must be valid Proxmox VM IDs (>= 100)."
  }

  validation {
    condition     = length([for name, cfg in var.nodes : name if cfg.controlplane]) >= 1
    error_message = "At least one node must have controlplane = true."
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "gateway" {
  description = "Default gateway for all Talos nodes (eth0)."
  type        = string

  validation {
    condition     = can(regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", var.gateway))
    error_message = "gateway must be a valid IPv4 address."
  }
}

variable "nameservers" {
  description = "List of DNS nameservers written into each node's Talos machine config."
  type        = list(string)
  default     = ["8.8.8.8", "1.1.1.1"]

  validation {
    condition     = length(var.nameservers) >= 1
    error_message = "At least one nameserver is required."
  }
}

variable "subnet_prefix" {
  description = "CIDR prefix length for node addresses on eth0 (e.g. 24 → /24)."
  type        = number
  default     = 24

  validation {
    condition     = var.subnet_prefix >= 8 && var.subnet_prefix <= 30
    error_message = "subnet_prefix must be between 8 and 30."
  }
}

# ---------------------------------------------------------------------------
# VLAN 3 tag for the single node NIC
# ---------------------------------------------------------------------------

variable "vlan3_tag" {
  description = "VLAN ID for the node NIC (NetBird-only network)."
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------
# Talos image
# ---------------------------------------------------------------------------

variable "talos_image_datastore" {
  description = <<-EOT
    Proxmox storage ID used only for staging the raw Talos disk image during
    import. The final VM disk lands on each node's per-node `datastore`.
    Defaults to the first node's datastore if not set explicitly.
  EOT
  type        = string
  default     = "local"
}

variable "environment" {
  description = "Deployment environment name (e.g. 'productie', 'ontwikkel'). Used to locate the generated/ directory for machine configs."
  type        = string
}
variable "registry_mirror_url" {
  description = "Optional Docker Hub pull-through cache URL (e.g. http://10.25.0.3:5000). When set, Talos nodes use this mirror for docker.io images to avoid rate limits."
  type        = string
  default     = ""
}

