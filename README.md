# InfraWeaver Platform 🚀

A **highly customizable, GitOps-driven Kubernetes platform** built on top of [InfraWeaver-base](https://github.com/Werewolf-p/InfraWeaver-base).

## Architecture

```
InfraWeaver-base (Proxmox VE cluster)
    └── InfraWeaver-platform (this repo)
            ├── OpenTofu → Talos Linux VMs on Proxmox
            ├── Talos → HA Kubernetes cluster (stacked etcd)
            ├── ArgoCD → GitOps operator (App-of-Apps)
            └── kubernetes/ → All your apps live here
```

### Why Talos Linux?
- **Immutable OS** — no SSH, no bash, no configuration drift
- **API-driven** — managed entirely via the Talos API (OpenTofu provider)
- **Built for HA** — stacked etcd control plane out of the box
- **Minimal attack surface** — only Kubernetes-relevant processes run
- **GitOps-native** — machine configs are declarative YAML

## Environments

| Environment | Proxmox | Talos Nodes | K8s Topology |
|------------|---------|-------------|--------------|
| `ontwikkel` | 10.25.0.3 | talos-dev-cp1 (10.25.0.50), talos-dev-worker1 (10.25.0.51) | 1 CP + 1 Worker |
| `productie` | 10.25.0.3 | talos-prod-cp1/2/3 (10.25.0.90/91/92) | 3 CP stacked HA |

## Quick Start

```bash
# 1. Deploy the cluster
make apply ENV=ontwikkel

# 2. Get kubeconfig
make kubeconfig ENV=ontwikkel
export KUBECONFIG=~/.kube/config-platform-ontwikkel

# 3. Check nodes
make nodes ENV=ontwikkel

# 4. ArgoCD UI
make argocd-ui ENV=ontwikkel
# → open http://localhost:8080 (user: admin, pass: make argocd-pass)
```

## Adding Your Own App

1. **Create a folder** under `kubernetes/apps/`:
   ```bash
   cp -r kubernetes/apps/example-app kubernetes/apps/my-app
   ```

2. **Edit `application.yaml`** — set the Helm chart, repo, namespace:
   ```yaml
   repoURL: https://charts.bitnami.com/bitnami
   targetRevision: "11.*"
   chart: wordpress
   releaseName: my-wordpress
   namespace: apps-my-app
   ```

3. **Edit `values.yaml`** — configure the chart however you want.

4. **Push** to `ontwikkel` branch → ArgoCD auto-deploys to dev.  
   Merge to `main` → ArgoCD auto-deploys to production.

That's it. No manual kubectl, no pipeline changes.

## Pre-installed Apps

| App | Namespace | Purpose |
|-----|-----------|---------|
| ArgoCD | argocd | GitOps operator |
| cert-manager | cert-manager | TLS certificates |
| ingress-nginx | ingress-nginx | HTTP ingress |
| external-secrets | external-secrets | Secrets from OpenBao |
| kube-prometheus-stack | monitoring | Prometheus + Grafana + AlertManager |
| Loki | monitoring | Log aggregation |
| Grafana (standalone) | apps-grafana | Dashboard example |

## Secrets via OpenBao

Secrets are **never stored in Git**. They're pulled from OpenBao (Vault-compatible) at deploy time:

```yaml
# kubernetes/core/external-secrets/manifests/grafana-externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
spec:
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  data:
    - secretKey: admin-password
      remoteRef:
        key: secret/platform/grafana
        property: admin-password
```

To add a secret to OpenBao:
```bash
vault kv put secret/platform/my-app my-key="my-value"
```

## Branch Strategy

```
feature-branch → PR → ontwikkel (deploy to dev cluster)
                         ↓ PR after testing
                       main (deploy to prod cluster)
```

## Repository Structure

```
├── terraform/
│   ├── modules/
│   │   ├── talos-cluster/      # VM creation + Talos bootstrap
│   │   └── platform-bootstrap/ # ArgoCD install + App of Apps
│   └── main.tf / variables.tf / providers.tf
├── envs/
│   ├── ontwikkel/cluster.yaml  # Dev cluster node specs
│   └── productie/cluster.yaml  # Prod cluster node specs
├── kubernetes/
│   ├── bootstrap/              # Root ApplicationSet (applied once by OpenTofu)
│   ├── core/                   # System components (ArgoCD manages these)
│   │   ├── argocd/
│   │   ├── cert-manager/
│   │   ├── ingress-nginx/
│   │   └── external-secrets/
│   ├── monitoring/             # Observability stack
│   │   ├── kube-prometheus-stack/
│   │   └── loki/
│   └── apps/                   # ← YOUR APPS GO HERE
│       ├── grafana/            # Example: Grafana
│       └── example-app/        # Example: nginx
└── .github/workflows/
    ├── platform.yml            # Deploy pipeline
    └── security-scan.yml       # Security scanning
```
