# Contributing to InfraWeaver Platform

This guide explains how to make changes to the InfraWeaver homelab platform.
All changes follow a GitOps model — push to `main` triggers automatic deployment.

---

## Quick Reference

| Task | Where to change |
|------|----------------|
| Add a new service | Create `kubernetes/<tier>/<app>/` folder |
| Add a user | Edit `users.yaml` |
| Change user permissions | Edit `users.yaml` → `access_level` or `authentik_groups` |
| Change infrastructure (VMs, nodes) | Edit `envs/productie/` + `terraform/` |
| Change cluster config | Edit `envs/productie/cluster.yaml` |
| Change a service's values | Edit `kubernetes/<tier>/<app>/values.yaml` |

---

## Adding a New Application

Use the scaffold script — it copies a security-hardened template with all defaults baked in:

```bash
# Raw-manifest app (custom image, no Helm chart):
bash scripts/new-app.sh my-app

# Helm chart app:
bash scripts/new-app.sh my-app --helm https://charts.example.com chart-name
```

**What you get automatically:**
- NetworkPolicy: default-deny + allow only from Traefik
- Dedicated ServiceAccount (no default SA token auto-mount)
- Pod Security Admission: restricted profile
- Secure pod template (non-root, read-only root filesystem, drop ALL capabilities)
- ResourceQuota on the namespace

**After scaffolding:**
1. Edit `kubernetes/apps/my-app/manifests/deployment.yaml` — set your image + port
2. Choose access mode:
   - Internal (VPN only): `mv manifests/ingressroute-internal.yaml.example manifests/ingressroute-internal.yaml`
   - Public: `mv manifests/ingressroute-public.yaml.example manifests/ingressroute-public.yaml`
3. For Helm apps: edit `application.yaml` (set `repoURL`, `chart`, `targetRevision`)
4. Push to `main` — ArgoCD auto-deploys within ~60 seconds

See `docs/templates/app/README.md` and `kubernetes/apps/README.md` for full details.

### For apps needing extra Kubernetes resources (ExternalSecrets, etc.)

1. Create `kubernetes/apps/my-app/manifests/` directory
2. Add your YAML files there
3. Create `kubernetes/bootstrap/app-my-app-manifests.yaml` (copy from `app-authentik-manifests.yaml`)
4. Add secrets to OpenBao via the seed step in `apply-changes.yml`

---

## Adding or Modifying a User

Edit `users.yaml` at the repo root:

```yaml
users:
  - username: newuser
    email: newuser@example.com
    display_name: "New User"
    access_level: platform-user   # or: admin
    # Optional: override auto-derived groups
    # authentik_groups: ["platform-users", "my-custom-group"]
```

**Access levels:**
- `admin` → groups: `platform-admins`, `authentik Admins`, `platform-users`
- `platform-user` → groups: `platform-users`

**On push:**
- New users → Authentik account created + welcome email sent
- Changed users → groups/permissions updated
- Removed users → must be manually removed from Authentik

---

## Making Infrastructure Changes

### VM or node changes
1. Edit `envs/productie/cluster.yaml` (node IPs, VM IDs)
2. Edit `envs/productie/services.auto.tfvars` (service VMs)
3. Run `platform.yml` workflow (manual dispatch) or push changes to `envs/` or `terraform/`

### New cluster nodes
1. Add the node to `envs/productie/cluster.yaml`
2. Run `platform.yml` with `action: apply`
3. Label the node appropriately:
   ```bash
   kubectl label node <nodename> grafana-eligible=true
   ```

---

## Development Workflow

### Prerequisites
Install tools via [mise](https://mise.jdx.dev) or [asdf](https://asdf-vm.com):
```bash
mise install   # reads .tool-versions
```

### Pre-commit hooks (recommended)
```bash
pip install pre-commit
pre-commit install
```

This runs: Terraform fmt, YAML lint, secret scanning before each commit.

### Testing changes locally
- **All validations at once:** `make validate-all`
- **Schema validation:** `make validate-platform && make validate-users`
- **Terraform:** `cd terraform && tofu validate && tofu plan`
- **YAML:** `pre-commit run --all-files` or `make validate`
- **Secrets:** `gitleaks detect --source . --no-git`
- **Cluster status (requires VPN):** `make status` or `make apps`

### Quick Makefile reference
```bash
make validate-all    # Run YAML + schema + platform + users validation
make validate        # Run yamllint + helm lint + kubeconform
make status          # Show all ArgoCD app health (requires VPN)
make apps            # Show ArgoCD apps table
make users-list      # Show all users from users.yaml
make diff            # ArgoCD diff for all apps (requires VPN)
make install-dev-tools  # Install yamllint, kubeconform, pre-commit
```

---

## No Full Redeployment Policy

**Do NOT trigger `full-redeploy.yml` unless the cluster is completely broken.**

- Use `apply-changes.yml` for all normal changes
- ArgoCD handles Kubernetes manifest changes automatically
- The `platform.yml` workflow handles Terraform changes (envs/, terraform/)
- Let's Encrypt has a rate limit of 5 certificates per domain per week

---

## Sensitive Data Handling

- **Never commit secrets** — use OpenBao + ExternalSecretOperator
- Sensitive Terraform vars are in `envs/*/secrets.sops.yaml` (SOPS-encrypted)
- GitHub Actions secrets: `PROXMOX_API_TOKEN`, `GITHUB_RUNNER_TOKEN`, `SMTP_USERNAME`, etc.
- SSH keys for service VMs are in `terraform.tfvars` (public keys only)

---

## Getting Help

- Check `README.md` for platform architecture overview
- Check `.github/memories/` for known gotchas and patterns
- Check `apply-changes.yml` for the incremental deployment flow
- ArgoCD UI: `https://argo.int.rlservers.com` (requires NetBird VPN)
