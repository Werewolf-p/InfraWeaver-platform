---
title: ESO API version v1 requirement and OpenBao v2.x differences
description: ExternalSecrets Operator deployed in this cluster requires external-secrets.io/v1 (not v1beta1). OpenBao v2.x uses different field names and binary paths.
---

# ESO and OpenBao API Compatibility

## Memory

- **File paths:** `kubernetes/core/external-secrets/manifests/cluster-secret-store.yaml`, `kubernetes/core/external-secrets/manifests/grafana-externalsecret.yaml`, `.github/workflows/full-redeploy.yml`
- **Decision:** Always use `external-secrets.io/v1` for ClusterSecretStore and ExternalSecret resources.
- **Why it matters:** Using `v1beta1` causes `no matches for kind "ClusterSecretStore" in version "external-secrets.io/v1beta1"` with kubectl apply.

## ESO API Version

The ESO deployment in this cluster serves `external-secrets.io/v1` as the preferred version:

```yaml
# CORRECT:
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore

# WRONG — causes: no matches for kind error:
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
```

Same applies to `ExternalSecret` resources.

## OpenBao v2.x Differences from Vault

The OpenBao binary is at `/usr/bin/bao` (NOT `/opt/openbao/bin/bao`).

| Aspect | Vault/old OpenBao | OpenBao v2.x (deployed) |
|--------|------------------|--------------------------|
| Binary path | `/opt/openbao/bin/bao` | `/usr/bin/bao` |
| Field for token value | `-field=client_token` | `-field=token` |
| JSON token field | `auth.client_token` | `auth.client_token` (same) |
| KV v2 path format | `secret/data/...` | `secret/data/...` (same) |

**Recommended**: Use `-format=json` and parse with Python instead of `-field=`:
```bash
BAO_TOKEN=$(VAULT_ADDR=... VAULT_TOKEN=... /usr/bin/bao token create \
  -policy=platform-k8s -format=json 2>/dev/null | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["auth"]["client_token"])')
```

## OpenBao SSH Access

- **Host:** `ubuntu@10.25.0.86` (NOT `root@10.25.0.86`)
- **Key:** `~/.ssh/deployer_ed25519`
- `ubuntu` has `sudo` for root-owned files like `/opt/openbao/init-output.json`

```bash
# Read root token (requires sudo):
ROOT_TOKEN=$(ssh -i ~/.ssh/deployer_ed25519 ubuntu@10.25.0.86 \
  "sudo python3 -c \"import json; print(json.load(open('/opt/openbao/init-output.json'))['root_token'])\"")
```

## KV v2 Policy Pattern (ESO platform-k8s)

```hcl
path "secret/data/platform/*" { capabilities = ["read", "list"] }
path "secret/metadata/platform/*" { capabilities = ["read", "list"] }
```

Note the `/data/` and `/metadata/` prefixes — required for KV v2. The logical path `secret/platform/grafana` becomes storage path `secret/data/platform/grafana`.

## Secrets Stored in OpenBao

| Logical Path | Key | Value |
|-------------|-----|-------|
| `secret/platform/grafana` | `admin-password` | `Unified*Presume8*Sudoku*Karate` |
| `secret/platform/argocd` | `admin-password` | `Unified*Presume8*Sudoku*Karate` |

## Lesson Learned

- The `v1beta1` → `v1` migration was silent at apply time if you didn't check — ESO would apply the YAML but the ClusterSecretStore would never sync
- OpenBao SSH as `root@` fails; must use `ubuntu@` with deployer_ed25519 key
- The binary path `/opt/openbao/bin/bao` does NOT exist on this deployment; all commands must use `/usr/bin/bao`
