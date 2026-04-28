# Workflow Composite Actions

## Overview
Both repos use composite actions to DRY out repeated tool installation blocks across workflow jobs.

## Infrastructure Repo: `.github/actions/setup-infra/action.yml`

**Inputs:**
| Input | Default | Description |
|-------|---------|-------------|
| `age-private-key` | "" | AGE private key for SOPS (writes to `~/.config/sops/age/keys.txt`) |
| `ssh-private-key` | "" | SSH private key (writes to `~/.ssh/deployer_ed25519`) |
| `with-docker` | "false" | Install Docker and build homelab-ansible image |
| `with-swap` | "false" | Add 2 GB swap (for memory-heavy builds) |
| `tofu-version` | "1.11.6" | OpenTofu version |
| `sops-version` | "3.9.1" | SOPS version |

**Usage:**
```yaml
- name: Setup tools
  uses: ./.github/actions/setup-infra
  with:
    age-private-key: ${{ secrets.SOPS_AGE_PRIVATE_KEY }}
    ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
    with-docker: "true"
    with-swap: "true"
```

## Platform Repo: `.github/actions/setup-platform/action.yml`

**Inputs:**
| Input | Default | Description |
|-------|---------|-------------|
| `age-secret-key` | "" | AGE secret key (writes to `$RUNNER_TEMP/age.key`, exports `SOPS_AGE_KEY_FILE`) |
| `deployer-ssh-key` | "" | SSH private key (writes to `~/.ssh/deployer_ed25519`) |
| `tofu-version` | "1.11.6" | OpenTofu version |
| `sops-version` | "3.10.2" | SOPS version |
| `age-version` | "1.1.1" | age binary version |
| `with-talosctl` | "false" | Install talosctl matching cluster.yaml talos_version |
| `with-helm` | "false" | Install Helm |
| `environment` | "" | Environment name (needed when `with-talosctl: true`) |

**Usage:**
```yaml
- name: Setup tools
  uses: ./.github/actions/setup-platform
  with:
    age-secret-key: ${{ secrets.AGE_SECRET_KEY }}
    deployer-ssh-key: ${{ secrets.DEPLOYER_SSH_KEY }}
    with-talosctl: "true"
    with-helm: "true"
    environment: ${{ env.ENV_NAME }}
```

## Notes
- `SOPS_AGE_KEY_FILE` is written to `$GITHUB_ENV` by the platform action — subsequent steps automatically pick it up
- Provider cache is enabled in `.tofurc` by the platform action (`~/.terraform.d/plugin-cache`)
- Docker image `homelab-ansible:latest` is built from `ansible/` by the infra action when `with-docker: true`
