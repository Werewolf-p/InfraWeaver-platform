---
title: IaC Best Practices — 2025 Reference
description: Consolidated best practices for Terraform/OpenTofu, GitOps, GitHub Actions, Kubernetes, and secrets management applied to this platform.
---

# IaC Best Practices (2025)

This document captures best practices applied to InfraWeaver-platform based on current (2024-2025) IaC standards. Consult this before making architectural changes.

---

## 1. Single Source of Truth

- **One file rules them all.** `users.yaml` → all user state. `cluster.yaml` → all node state. `terraform.tfvars` → all infrastructure config.
- **Git is canonical.** ArgoCD polls Git; no manual `kubectl apply` or Helm upgrades outside Git.
- **Never configure via UI.** ArgoCD, Authentik, Grafana — all configuration must be in Git and applied by workflows or ArgoCD.

---

## 2. Modularity

- Break Terraform into small, focused modules under `terraform/modules/` (talos-cluster, openbao, netbird-router, github-runner, cloud-init-template).
- Each module has its own `variables.tf`, `outputs.tf`, `main.tf`.
- Modules are composed in `terraform/main.tf` (or `providers.tf`) — no logic in root.
- **Avoid deeply nested modules.** Prefer flat composition: `module "talos" { ... }` + `module "openbao" { ... }` side-by-side.
- Platform configs go in `envs/<env>/` as `terraform.tfvars` + `cluster.yaml` — never hardcode env-specific values inside modules.

---

## 3. Secrets Management

### Golden Rules
- **Zero plaintext secrets in Git.** No passwords, tokens, API keys, or private keys committed.
- **OpenBao is the source of truth** for all runtime secrets. External Secrets Operator syncs them to K8s.
- Randomly generate all secrets at deploy time (`openssl rand -base64`).
- Use `optional: true` on `secretKeyRef` for user passwords (avoids pod crash during rolling updates if ExternalSecret hasn't synced yet).

### Pattern
```
OpenBao (secret/platform/<app>) → ExternalSecret → K8s Secret → Pod env var
```

### What's allowed in Git
- ✅ Public SSH keys (not private)  
- ✅ Encrypted SOPS files (`.sops.yaml` defines key)  
- ✅ Placeholder/example values clearly marked as such  
- ❌ Private keys, passwords, API tokens, real IPs of sensitive infra

### Ansible
- Use `no_log: true` on tasks that handle secrets.
- Variables containing real secrets must come from Ansible Vault or environment injection — never hardcoded in playbooks.
- Demo/placeholder values in playbooks must be clearly labeled and not resemble real credentials.

---

## 4. GitHub Actions Security

### Permissions (Principle of Least Privilege)
Every workflow MUST declare an explicit `permissions:` block:
```yaml
permissions:
  contents: read   # minimum for checkout
```
Escalate only what's needed:
- `contents: write` — only for workflows that commit back
- `id-token: write` — only for OIDC cloud auth
- `packages: write` — only for container publishing

### Concurrency Guards
Workflows that touch cluster state MUST have concurrency groups:
```yaml
concurrency:
  group: <workflow-name>-${{ github.ref_name }}
  cancel-in-progress: false   # NEVER cancel mid-apply
```

### Action Pinning
For a homelab: `@v4` tags are acceptable (low supply-chain risk).
For production: pin to SHA digest for critical third-party actions.
```yaml
# Acceptable for homelab
uses: actions/checkout@v4

# Recommended for high-security production
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

### Never in Workflows
- Never `echo` or `print` secrets
- Never pass secrets as CLI arguments (use env vars)
- Never use `cancel-in-progress: true` on apply/deploy jobs

---

## 5. Kubernetes / ArgoCD / Helm

### Image Pinning
Always pin image tags — never use `latest`:
```yaml
image:
  tag: "v0.70.4"   # explicit semver
```

### ArgoCD Application Pattern
```yaml
spec:
  syncPolicy:
    automated:
      prune: false      # don't auto-delete resources
      selfHeal: true    # auto-correct drift
    syncOptions:
      - CreateNamespace=true
```
- `prune: false` is safer — prevents accidental deletion if a file is temporarily removed.
- `selfHeal: true` ensures drift is corrected on the next poll cycle.

### ExternalSecret Best Practices
```yaml
spec:
  refreshInterval: 1h
  target:
    creationPolicy: Owner   # ESO owns the K8s secret
  data:
    - secretKey: my-password
      remoteRef:
        key: secret/platform/my-app
        property: my-password
```
- Use `creationPolicy: Owner` so the secret is GC'd when the ExternalSecret is deleted.
- Set `optional: true` on user-specific `secretKeyRef` in Deployment/Pod specs (avoids pod crash during rolling updates when a new secret key is being seeded).

### Longhorn HA Storage
- All stateful core services use `longhorn-retain` storageClass (3 replicas).
- `defaultReplicaCount: 3` in Longhorn values → survives 1 node failure.
- cert-manager does NOT use PVCs — certs stored in etcd.

---

## 6. Incremental Deploy vs Full Redeploy

| Scenario | Use |
|----------|-----|
| New user | `users.yaml` + 4 files → push → `apply-changes.yml` auto-triggers |
| New K8s service | `kubernetes/apps/` → push → ArgoCD auto-syncs |
| Config change (values.yaml) | push → ArgoCD auto-syncs |
| New blueprint change | push → `apply-changes.yml` force-syncs Authentik app |
| Cluster node replacement | `cluster.yaml` + `tofu apply` |
| **Everything broken** | `Full Redeploy` workflow (last resort — risks cert rate limits) |

**Let's Encrypt rate limit: 5 certs per registered domain per week.** Every full redeploy may issue new certs. Use staging issuer for testing.

---

## 7. Drift Detection & Validation

### Pre-commit checks
Run `terraform validate` before every plan. ArgoCD detects drift on every ~3 min poll.

### Static analysis already in place
- `checkov` — Terraform + GitHub Actions (security misconfigs)
- SOPS validation — ensures secrets files are encrypted
- Kubernetes manifest lint — kubeval

### Recommended additions
- `gitleaks` in CI — catch accidentally committed secrets
- `trivy` — container image vulnerability scanning
- `helm lint` — validate Helm values syntax

---

## 8. Documentation

- **README.md** — architecture overview, service URLs, access patterns. Keep it current.
- **`.github/memories/`** — self-learning notes for the AI architect. Update after every new pattern discovered.
- **Inline comments** — explain WHY, not WHAT. YAML files should be self-documenting.
- **Sensitive details** — never put real IPs, emails, or credentials in public-facing docs.

---

## 9. Code Hygiene

### .gitignore must cover
```
**/__pycache__/
*.pyc
*.pyo
envs/*/generated/kubeconfig
envs/*/generated/talosconfig
```

### File naming convention (this repo)
```
kubernetes/
  core/<component>/application.yaml   # ArgoCD Application
  core/<component>/values.yaml        # Helm values
  core/<component>/manifests/*.yaml   # Raw K8s manifests
  apps/<component>/...                # Same pattern
```

---

## 10. Observed Patterns (This Repo)

| Pattern | Implementation |
|---------|----------------|
| Single user SOT | `users.yaml` → `sync-authentik-users.py` → Authentik groups |
| Secret seeding | `seed-openbao-authentik.sh` → OpenBao → ExternalSecret → K8s secret |
| Incremental deploy | `apply-changes.yml` with path-based triggers |
| HA without workers | All core services have control-plane tolerations |
| No hardcoded users | Dynamic loops in workflows via `users.yaml` |
| optional secretKeyRefs | Prevents pod crash on rolling update when new password not yet synced |
| Running pod selector | `--field-selector=status.phase=Running` for `kubectl exec` during rolling updates |
