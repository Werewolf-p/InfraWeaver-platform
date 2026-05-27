<p align="center">
  <img src="images/logo.png" alt="InfraWeaver" width="120" />
</p>

<h1 align="center">InfraWeaver Platform</h1>

<p align="center">
  A self-hosted, GitOps-driven Kubernetes platform that deploys itself on your Proxmox homelab.<br/>
  One command. Zero hardcoded secrets. Fully automated from bare Proxmox to running cluster.
</p>

<p align="center">
  <a href="#-quick-start"><strong>Quick Start</strong></a> ·
  <a href="#-how-it-works"><strong>How It Works</strong></a> ·
  <a href="#-whats-included"><strong>What's Included</strong></a> ·
  <a href="#%EF%B8%8F-configuration"><strong>Configuration</strong></a> ·
  <a href="#-after-deployment"><strong>After Deployment</strong></a>
</p>

---

## What is InfraWeaver?

InfraWeaver is a complete, production-grade homelab platform that turns a Proxmox host into a fully managed Kubernetes environment. It is designed to be:

- **One-command deployable** — run a single script on Proxmox to start an init website, fill in your settings, and click deploy
- **Fully local after setup** — GitHub is only used to clone the template once. Everything after that (git, CI/CD, secrets) runs inside your cluster
- **Secrets-zero-trust** — all credentials are randomly generated at deploy time and stored in OpenBao (open-source Vault). Nothing is hardcoded in this repository
- **Modular** — toggle optional components (VPN, monitoring, backup, etc.) via `platform.yaml` or the init website
- **GitOps-native** — ArgoCD continuously reconciles your cluster state against a local Onedev git server

### What it deploys

| Layer | Technology | Purpose |
|---|---|---|
| **Hypervisor** | Proxmox VE | VM host — you manage this |
| **OS / Kubernetes** | Talos Linux | Immutable, API-driven K8s nodes (3-node control-plane) |
| **Infrastructure** | OpenTofu (Terraform) | Provisions VMs + bootstraps the cluster |
| **GitOps** | ArgoCD | Continuously syncs cluster state from local git |
| **Secrets** | OpenBao | All platform credentials live here, never in git |
| **Ingress** | Traefik | Routes all HTTP/S traffic; gRPC + WebSocket support |
| **Load Balancer** | MetalLB | Bare-metal LoadBalancer IP assignment |
| **TLS** | cert-manager | Automated Let's Encrypt certificates (DNS-01 wildcard) |
| **Secret Sync** | External Secrets Operator | Bridges OpenBao secrets → Kubernetes Secrets |
| **Storage** | Longhorn | Distributed, replicated block storage across nodes |
| **Identity** | Authentik | SSO/OIDC provider — single login for all apps |
| **Local Git + CI** | Onedev | Self-hosted Git, issue tracker, and CI/CD pipelines |

---

## ✅ Prerequisites

Before you start, you need:

- **Proxmox VE 8.x** host (bare metal or nested) with:
  - At least **32 GB RAM** free for the 3 Kubernetes nodes
  - At least **300 GB storage** free (LVM or ZFS)
  - A network bridge accessible from the internet (or just your LAN)
- **A domain name** you control (e.g. `yourdomain.com`) with DNS managed by one of the [supported providers](#-dns-provider--tls-certificates)
- **SSH key pair** — the deploy script will use this to provision VMs

> **Minimum hardware per Kubernetes node:** 4 vCPUs, 8 GB RAM, 100 GB disk  
> Default: 3 nodes × (4 CPU / 8 GB / 100 GB) = 12 vCPU, 24 GB RAM, 300 GB storage

---

## 🚀 Quick Start

Choose the method that fits your setup — all three end up at the same web UI:

### One command, works anywhere

```bash
wget -qO- https://raw.githubusercontent.com/Werewolf-p/InfraWeaver-platform/main/scripts/init/setup.sh | bash
# or
curl -sSL https://raw.githubusercontent.com/Werewolf-p/InfraWeaver-platform/main/scripts/init/setup.sh | bash
```

**On a Proxmox host:** the script detects Proxmox and asks you to choose:
- `1` — Create a dedicated lightweight init VM *(recommended — keeps host clean)*
- `2` — Run the wizard directly on this Proxmox host *(no VM created)*

**On any other Linux/macOS machine:** the wizard starts immediately on port 8080. Your machine needs network access to the Proxmox API (port 8006).

> **ENV overrides:** `IW_WORK_DIR`, `IW_REPO_URL`, `IW_REPO_BRANCH`, `IW_PORT`, `IW_HOST`, `IW_YES=1` (skip prompts)

---

### Option C — Already have the repo cloned

```bash
git clone https://github.com/Werewolf-p/InfraWeaver-platform
cd InfraWeaver-platform
python3 scripts/init/server.py
# open http://localhost:8080
```

---

Open the URL in your browser. The init website guides you through:

| Step | What you configure |
|---|---|
| **1. Welcome** | Overview and prerequisites check |
| **2. Domain** | Base domain, admin email |
| **3. Proxmox** | Host IP + API token (or auto-create one from root credentials) |
| **4. Cluster** | Node IPs, VMIDs, per-node CPU/RAM/disk/PVE-node assignment |
| **5. Identity** | Admin username and SSO settings |
| **6. Credentials** | DNS provider, SMTP, optional secrets |
| **7. Features** | Toggle optional components (VPN, monitoring, backups, etc.) |
| **8. Deploy** | Click **Deploy** — watch the live log as everything provisions |

> **Skip the website?** Copy `.env.example` → `.env`, fill in the values, and run `bash scripts/deploy-local.sh` directly.

---

### Proxmox API token setup

The wizard can create the API token for you. On the **Proxmox** step, use the **Auto-setup** tab:
1. Enter your Proxmox IP and a `root@pam` username + password
2. Click **Check access & create API user**
3. InfraWeaver creates `infraweaver@pve` with minimal permissions and auto-fills the token
4. **Your credentials are never stored** — used once and immediately discarded

Or create a token manually in Proxmox: **Datacenter → Permissions → API Tokens** and paste it in the **Manual token** tab.

---

## 🔍 How It Works

### Deployment flow

```
WHERE YOU START THE WIZARD (one URL, works everywhere):
  wget -qO- .../scripts/init/setup.sh | bash
               │
               ├─ On Proxmox host → choose: create init VM  OR  run here
               └─ On Linux/macOS  → starts wizard locally
               │
               ▼
     Init Website at http://<ip>:8080
              │  Fill in settings (Proxmox, cluster, DNS, features)
              │  Writes: .env
              ▼
     scripts/deploy-local.sh  (runs on init VM or your machine)
              │
              ├── 1. generate-from-env.sh
              │       Substitutes ${PLACEHOLDERS} in all Kubernetes YAMLs
              │       and Terraform variables using your .env values
              │
              ├── 2. OpenTofu (terraform/)
              │       ├── Provisions 3 Talos VMs on Proxmox
              │       ├── Bootstraps the Talos Kubernetes cluster
              │       ├── Installs ArgoCD via Helm
              │       └── Applies the root ApplicationSet (app-of-apps)
              │
              ├── 3. bootstrap-openbao.sh
              │       Seeds all generated secrets into OpenBao
              │       (passwords, tokens, API keys, certificates)
              │
              ├── 4. bootstrap-externalsecrets.sh
              │       Wires ExternalSecretStore → OpenBao
              │       ESO starts syncing secrets into K8s namespaces
              │
              ├── 5. ArgoCD (automatic from here)
              │       Pulls from local Onedev git server
              │       Deploys all apps in kubernetes/ over ~10-15 min
              │
              └── 6. Post-bootstrap
                      ├── Authentik admin account configured
                      ├── OIDC/SSO wired to ArgoCD, Grafana, Onedev
                      └── Cluster ready — access via console.yourdomain.com
```

### GitOps model

After initial deployment, GitHub plays no further role. Your cluster manages itself:

```
GitHub (read-only template)
    │  cloned once at deploy time
    ▼
Onedev (inside your cluster)      ← your private git server
    │  ArgoCD watches this
    ▼
ArgoCD                            ← syncs every ~3 minutes
    │  reconciles cluster state
    ▼
Kubernetes cluster                ← running apps
```

To update an app, push a commit to your local Onedev. ArgoCD picks it up automatically.

### Secrets model

**No secrets are stored in Git.** The flow is:

```
.env (deploy time only, never committed)
    │
    ▼
bootstrap-openbao.sh
    │  Writes: secret/platform/<service>  (passwords, tokens, keys)
    ▼
OpenBao (runs in cluster)
    │
    ▼
External Secrets Operator
    │  ExternalSecret CRDs pull from OpenBao
    ▼
Kubernetes Secrets                ← pods consume these via env vars or volume mounts
```

Example ExternalSecret:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: my-app-secret
  namespace: my-app
spec:
  secretStoreRef:
    name: openbao-backend
    kind: ClusterSecretStore
  target:
    name: my-app-secret
  data:
    - secretKey: admin-password
      remoteRef:
        key: secret/platform/my-app
        property: admin-password
```

After deployment, retrieve any credential with:
```bash
# From inside the cluster (via kubectl exec on openbao pod) or via the OpenBao UI
vault kv get -field=<key> secret/platform/<service>
```

### Traffic routing

```
Internet
    │
    ▼
Your DNS provider  ──  yourdomain.com → your public IP
                       *.yourdomain.com → your public IP
    │
    ▼
Your router / firewall (port 443 → MetalLB Traefik VIP)
    │
    ▼
Traefik (MetalLB IP)
    │
    ├── auth.yourdomain.com        → Authentik (SSO)
    ├── netbird.yourdomain.com     → NetBird VPN dashboard (if enabled)
    ├── console.yourdomain.com     → InfraWeaver Console
    │
    └── *.int.yourdomain.com       → Internal-only (LAN or VPN only)
            ├── argocd.int.yourdomain.com
            ├── openbao.int.yourdomain.com
            ├── onedev.int.yourdomain.com
            └── ... all other platform services
```

**Access tiers:**

| Tier | Subdomain pattern | Who can reach it |
|---|---|---|
| Public | `auth.yourdomain.com`, `netbird.yourdomain.com` | Anyone on the internet |
| Internal | `*.int.yourdomain.com` | Your local network IP ranges (configured at init) |
| VPN-only | `*.int.yourdomain.com` | Only via NetBird VPN (if NetBird enabled) |

---

## 📦 What's Included

### Core (always deployed)

| Component | Description |
|---|---|
| **ArgoCD** | GitOps engine — deploys and reconciles everything |
| **Traefik** | Ingress controller for all HTTP/S + gRPC routing |
| **cert-manager** | Automated TLS certificates via Let's Encrypt |
| **MetalLB** | Load balancer for bare-metal (assigns real IPs) |
| **Longhorn** | Distributed block storage with replication |
| **OpenBao** | Secrets vault (Vault-compatible, fully open source) |
| **External Secrets Operator** | Syncs OpenBao secrets into Kubernetes |
| **Authentik** | Identity provider and SSO gateway for all apps |
| **Kyverno** | Kubernetes policy enforcement |
| **Onedev** | Local Git server + CI/CD (replaces GitHub dependency) |
| **InfraWeaver Console** | Web dashboard to manage the whole platform |
| **InfraWeaver API** | REST API backing the console |
| **Gatus** | Uptime and health monitoring for all services |
| **Container Registry** | Private OCI/Docker image registry |

### Optional (toggle in `platform.yaml` or init website)

| Component | Default | Description |
|---|---|---|
| **NetBird VPN** | off | Zero-trust mesh VPN for secure remote access |
| **Monitoring Stack** | off | Prometheus + Loki + Alertmanager (+ Grafana) |
| **External DNS** | off | Auto-creates DNS records via your DNS provider API |
| **Velero + MinIO** | off | Kubernetes-level backup to local S3-compatible storage |
| **Falco** | off | Runtime security and threat detection |
| **Wazuh** | off | SIEM and security event management |
| **Homepage** | off | Homelab service dashboard (console has this built-in) |

### Catalog apps (install on demand via Console)

Apps you can add at any time from the InfraWeaver Console:

| App | Description |
|---|---|
| Vaultwarden | Bitwarden-compatible password manager |
| Immich | Self-hosted photo backup and management |
| Jellyfin / Plex | Media server |
| Outline | Team knowledge base with OIDC |
| Wiki.js | Documentation wiki |
| Gitea / Forgejo | Additional self-hosted Git forges |
| n8n | Workflow automation |
| Code-Server | VS Code in your browser |
| Stirling PDF | PDF manipulation tools |
| Navidrome | Music streaming |
| Searxng | Private meta search engine |
| IT Tools | Developer utilities |
| Excalidraw | Collaborative whiteboard |
| Ntfy | Push notifications |
| And more... | See `platform.yaml` for full list |

---

## ⚙️ Configuration

### `.env` reference

The `.env` file (generated by the init website or from `.env.example`) controls everything:

```bash
# ── Domain & Identity ──────────────────────────────────────────────────────
BASE_DOMAIN=yourdomain.com           # All services deploy under this domain
ADMIN_EMAIL=admin@yourdomain.com     # Let's Encrypt registration + alert emails
ADMIN_USERNAME=admin                 # Platform admin username in Authentik
ADMIN_NAME=Platform Admin            # Display name

# ── Proxmox ────────────────────────────────────────────────────────────────
PROXMOX_HOST=192.168.1.100           # Proxmox management IP
PROXMOX_NODE_NAME=proxmox            # Proxmox node name
PROXMOX_API_TOKEN=root@pam!tf=...    # API token (create in Proxmox UI)

# ── Cluster Nodes ──────────────────────────────────────────────────────────
NODE_1_IP=10.10.0.90                 # Static IP for node 1
NODE_1_VMID=9310                     # Proxmox VM ID for node 1
# ... NODE_2, NODE_3 same pattern

# ── Network / MetalLB VIPs ─────────────────────────────────────────────────
METALLB_VIP_RANGE=10.10.0.200-10.10.0.210
METALLB_TRAEFIK_VIP=10.10.0.200      # Traefik ingress IP
METALLB_COREDNS_VIP=10.10.0.201      # Internal CoreDNS (resolves *.yourdomain.com)

# ── DNS Provider ───────────────────────────────────────────────────────────
DNS_PROVIDER=cloudflare              # See supported providers below
CLOUDFLARE_API_TOKEN=...

# ── Features ───────────────────────────────────────────────────────────────
ENABLE_NETBIRD=false                 # Zero-trust VPN
ENABLE_MONITORING=false              # Prometheus + Loki + Grafana
ENABLE_EXTERNAL_DNS=false            # Auto DNS record management
BACKUP_PROVIDER=longhorn             # longhorn | velero | none
```

See [`.env.example`](.env.example) for the full reference with all options.

### DNS Provider & TLS Certificates

cert-manager issues **wildcard TLS certificates** (`*.yourdomain.com`) via ACME DNS-01 challenge. Set `DNS_PROVIDER` to match your registrar:

| Provider | `DNS_PROVIDER` | Required credentials |
|---|---|---|
| **Cloudflare** *(default)* | `cloudflare` | `CLOUDFLARE_API_TOKEN` — Zone:DNS:Edit |
| **AWS Route 53** | `route53` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_HOSTED_ZONE_ID` |
| **Azure DNS** | `azure` | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID`, `AZURE_RESOURCE_GROUP` |
| **DigitalOcean** | `digitalocean` | `DIGITALOCEAN_TOKEN` |
| **Hetzner DNS** | `hetzner` | `HETZNER_DNS_API_KEY` |
| **HTTP-01 only** | `none` | No credentials — wildcard certs unavailable |

> `generate-from-env.sh` reads `DNS_PROVIDER` and generates the correct cert-manager ClusterIssuer (`letsencrypt-dns` / `letsencrypt-dns-staging`) with the right solver block for your provider. Credentials are seeded into OpenBao under `secret/platform/dns-provider`.

### Feature flags (`platform.yaml`)

Fine-tune which apps and groups are deployed by editing `platform.yaml` (or the InfraWeaver Console after deployment):

```yaml
groups:
  core-monitoring:
    enabled: true    # Deploys Prometheus + Loki + Alertmanager

  core-platform:
    apps:
      netbird:
        enabled: true    # Deploys NetBird VPN
      external-dns:
        enabled: true    # Auto-manages DNS records
```

---

## 🗂 Repository Structure

```
InfraWeaver-platform/
├── scripts/
│   ├── init/                     # Init website + VM bootstrap
│   │   ├── create-init-vm.sh     # Proxmox VM creation script (entry point)
│   │   ├── server.py             # Init website backend (writes .env, triggers deploy)
│   │   └── templates/            # Init website HTML/CSS/JS
│   ├── deploy/                   # Deploy-time helpers
│   │   ├── bootstrap-openbao.sh  # Seeds all secrets into OpenBao
│   │   ├── bootstrap-externalsecrets.sh
│   │   ├── configure-oidc.sh     # Wires Authentik OIDC to apps
│   │   └── ensure-cloudflare-dns.sh
│   ├── deploy-local.sh           # Main deployment orchestrator
│   ├── generate-from-env.sh      # Substitutes ${PLACEHOLDERS} from .env into YAMLs
│   └── new-app.sh                # Scaffold a new catalog app
│
├── terraform/
│   ├── modules/
│   │   ├── talos-cluster/        # Creates 3 Talos VMs + bootstraps K8s
│   │   ├── platform-bootstrap/   # Installs ArgoCD + root ApplicationSet
│   │   ├── cloud-init-template/  # Ubuntu cloud-init VM template
│   │   ├── openbao/              # OpenBao VM (secrets vault)
│   │   └── netbird-router/       # NetBird router peer VM
│   └── envs/productie/           # Environment-specific Terraform variables
│
├── kubernetes/
│   ├── bootstrap/                # Root ApplicationSet — applied once by OpenTofu
│   ├── core/                     # Mandatory system components
│   │   ├── argocd/
│   │   ├── cert-manager/         # ClusterIssuers + DNS ExternalSecret
│   │   ├── external-secrets/     # ClusterSecretStore → OpenBao
│   │   ├── longhorn/
│   │   ├── metallb/
│   │   ├── openbao/
│   │   └── traefik/
│   ├── platform/                 # Platform services (Authentik, NetBird, DNS, etc.)
│   ├── monitoring/               # Prometheus, Loki, Alertmanager (optional group)
│   ├── catalog/                  # On-demand apps (Vaultwarden, Immich, etc.)
│   └── external-routes/          # Traefik IngressRoutes + TLS Certificates
│
├── platform.yaml                 # Feature flags and catalog app config
├── users.yaml                    # Platform users (seeded into Authentik)
├── .env.example                  # Template — copy to .env and fill in
└── DEPLOYMENT.md                 # Local-only deployment model details
```

---

## 🔌 After Deployment

### First steps

1. **Open the Console** — `https://console.yourdomain.com`
   - Log in with your admin credentials
   - All services and their health status are visible here

2. **Access internal services** — `https://*.int.yourdomain.com`
   - Accessible from your local network (or via VPN if NetBird is enabled)
   - ArgoCD: `https://argocd.int.yourdomain.com`
   - OpenBao: `https://openbao.int.yourdomain.com`
   - Onedev: `https://onedev.int.yourdomain.com`

3. **Connect to NetBird VPN** (if enabled)
   ```bash
   netbird up --management-url https://api-netbird.yourdomain.com
   # Browser opens → log in with Authentik SSO → VPN connects
   ```

4. **Retrieve a credential**
   ```bash
   # Via kubectl on any node, or OpenBao UI at openbao.int.yourdomain.com
   vault kv get -field=bootstrap-password secret/platform/authentik
   ```

### Adding an app

1. **From the Console** — go to Catalog → click Install on any listed app
2. **Manually** — create `kubernetes/catalog/my-app/` with an `application.yaml`, optional `values.yaml`, and `manifests/`. Push to Onedev → ArgoCD deploys it.

Quick scaffold:
```bash
bash scripts/new-app.sh my-app
# Creates the skeleton files in kubernetes/catalog/my-app/
```

### Full redeployment

To wipe all cluster data and redeploy from scratch (keeps your `.env` and `users.yaml`):
```bash
bash scripts/redeploy.sh
```

---

## 🌐 Networking notes

### Internal-only middleware

Routes served on `*.int.yourdomain.com` are protected by a Traefik middleware that only allows requests from your configured `LOCAL_IP_RANGES`. This is enforced at the ingress level — not just DNS — so even if someone resolves the domain, they cannot reach the service unless their IP is in the allowed list.

### If using Cloudflare as your DNS proxy

- **SSL mode: Full** (required — Flexible breaks TLS termination)
- **HTTP/2: enabled** (required for NetBird gRPC connections)
- gRPC works on the Cloudflare Free plan with HTTP/2 + Full SSL

### CoreDNS internal resolution

CoreDNS runs at your `METALLB_COREDNS_VIP`. It resolves `*.yourdomain.com` to internal cluster IPs, so internal services resolve correctly without going through the public internet.

---

## 🤝 Contributing

Contributions are welcome. Please open an issue before submitting large PRs.

- See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines
- See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for a deep-dive on the codebase

---

## 📄 License

[MIT](LICENSE)
# permission test Wed May 27 06:33:43 UTC 2026
