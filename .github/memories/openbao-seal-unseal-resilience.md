---
title: OpenBao seal/unseal resilience and token management
description: OpenBao becomes sealed whenever its VM or host is hard-killed; auto-unseal service exists but relies on boot; token max_ttl must be tuned to allow long-lived ESO tokens
---

# OpenBao Seal/Unseal Resilience

## Memory

- **File paths:** `/etc/systemd/system/openbao-unseal.service`, `/opt/openbao/auto-unseal.sh`, `/opt/openbao/init-output.json`, `/etc/openbao/openbao.hcl`
- **Decision:** OpenBao uses Shamir unseal with 1-of-1 key shares. The auto-unseal systemd service runs on boot and handles normal restarts automatically.
- **Why it matters:** When the parent Proxmox host OOM-kills pve-prod1, ALL VMs inside crash. OpenBao's VM restarts and auto-unseals. But if pve-prod1's QEMU process is simply suspended (not killed), OpenBao stays sealed.
- **Validation:** `VAULT_ADDR=http://localhost:8200 /usr/bin/bao status | grep Sealed`
- **Related:** ESO ClusterSecretStore `openbao`, ExternalSecrets in `external-secrets` namespace, `openbao-token` secret

## Auto-Unseal Service

```ini
# /etc/systemd/system/openbao-unseal.service
[Unit]
After=openbao.service
Requires=openbao.service

[Service]
Type=oneshot
ExecStart=/opt/openbao/auto-unseal.sh
User=openbao
```

The service IS enabled and DOES run on VM boot. It reads the unseal key from `/opt/openbao/init-output.json`.

## Manual Unseal Procedure

When auto-unseal fails (e.g., VM resumed without reboot):

```bash
ssh -i ~/.ssh/deployer_ed25519 ubuntu@10.25.0.86
UNSEAL_KEY=$(sudo python3 -c "import json; print(json.load(open('/opt/openbao/init-output.json'))['unseal_keys_b64'][0])")
VAULT_ADDR=http://localhost:8200 /usr/bin/bao operator unseal "$UNSEAL_KEY"
```

## Token TTL Issue — IMPORTANT

OpenBao's default `max_lease_ttl` is **768h (32 days)**. Without tuning, all tokens (including ESO service tokens) expire in 32 days regardless of the `-ttl` parameter passed at creation.

**Fix (run once, persists in OpenBao data):**
```bash
ROOT_TOKEN=$(sudo python3 -c "import json; print(json.load(open('/opt/openbao/init-output.json'))['root_token'])")
VAULT_ADDR=http://localhost:8200 VAULT_TOKEN="$ROOT_TOKEN" /usr/bin/bao write sys/auth/token/tune max_lease_ttl=87600h
```

**This is now automated in the full-redeploy workflow** (`full-redeploy.yml` step 10) but must be re-applied after any OpenBao re-initialization.

## 403 vs 503 Confusion

When OpenBao is **sealed**, the `bao` CLI may return `Code: 403. Errors: * permission denied` for some operations — even though the vault is sealed (not a permission issue). Always run `bao status` first to distinguish sealed vs. token error.

## init-output.json Structure

```json
{
  "unseal_keys_b64": ["<base64-encoded-key>"],
  "unseal_keys_hex": ["<hex-encoded-key>"],
  "unseal_shares": 1,
  "unseal_threshold": 1,
  "recovery_keys_b64": [],
  "root_token": "s.xxxxxxxx"
}
```

Note: field is `unseal_keys_b64` NOT `keys` or `keys_base64`.

## Current ESO Service Token

- Token: `s.D3BZmwxvy3r1LaiN2SPcSK1` (truncated — full value in K8s secret)
- Policy: `platform-k8s` + `default`
- **Type: periodic — 168h (7-day) period, auto-renewed by ESO**
- K8s secret: `external-secrets/openbao-token` key `token`
- If ESO is down >7 days the token expires and must be recreated
- When recreating: use `-orphan -period=168h -policy=platform-k8s -policy=default -renewable=true`
- Previous token was 10yr static TTL (replaced 2026-05-03 with periodic for C6)

## Lesson Learned

- The 403 errors for both root token AND service token were caused by OpenBao being SEALED (pve-prod1 OOM killed → VMs crashed → auto-unseal needed on restart)
- Old service tokens become invalid after OpenBao re-initialization (core/_keyring modified). If core/ is touched, recreate all tokens.
- `bao kv list secret/` needs the right policy — `default` alone cannot read KV paths. Always use `platform-k8s` + `default` for ESO.
