# params/ — Per-Deployment Secrets and Credentials

This directory is gitignored. Do not commit it.

## Contents

Place these files here:

| File | Description |
|------|-------------|
| `.env` | Deployment secrets — copy from `.env.example` and fill in |
| `kubeconfig` | Cluster admin kubeconfig (written by deploy-local.sh) |

See `params.example/README.md` for full documentation.
