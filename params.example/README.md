# params.example — Required Per-Deployment Parameters

Copy this directory to `params/` (which is gitignored) and fill in real values.

`params/` is the single place for all secrets and personal configs that must
never be committed.  The `.env` file at the repo root is the primary source
of truth for secrets; `params/` holds any additional credential files.

## Files in this directory

| File | Purpose | How to obtain |
|------|---------|---------------|
| `.env` | All deployment secrets (see `.env.example`) | Copy `.env.example` → `.env` and fill in |
| `kubeconfig` | Admin kubeconfig for the cluster | Written by `deploy-local.sh` to `generated/kubeconfig`; copy here for safekeeping |

## Quick start

```bash
cp -r params.example params
cp .env.example params/.env
# Edit params/.env with real values
ln -sf params/.env .env          # optional: keep .env at repo root as a symlink
```

## Secret rotation checklist

If any of the following may have been exposed, rotate them immediately:

- `PROXMOX_API_TOKEN` — Proxmox datacenter → Permissions → API Tokens
- `CF_API_TOKEN` — Cloudflare dashboard → My Profile → API Tokens
- `SMTP_PASSWORD` — your SMTP provider
- `DEPLOYER_SSH_KEY` — run `ssh-keygen -t ed25519` and re-provision nodes

## History note

If secrets were ever accidentally committed to git history, run:
```bash
git log -p -- .env | grep -E 'token|key|password|secret'
```
and rotate any credentials found before making the repo public.
