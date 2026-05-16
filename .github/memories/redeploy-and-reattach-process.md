---
title: Console redeploy process and agent/API reattachment
description: How to redeploy the InfraWeaver console and ensure all APIs/agents stay connected
---

# Console Redeploy Process

## Memory

- **Normal redeploy (code change):** `git push origin main` → GitHub Actions builds Docker image → pushes to `onedev.rlservers.com/infraweaver/infraweaver-console:<hash>` → ArgoCD detects new image and triggers rolling update → zero-downtime (2 replicas with PDB minAvailable:1)

- **What persists across redeploys:** All secrets (ARGOCD_TOKEN, GITHUB_TOKEN, NEXTAUTH_SECRET, etc.) are stored in HashiCorp Vault and sync'd via ExternalSecret → `infraweaver-console-secret`. These are NOT in code. They survive redeploys automatically.

- **If ARGOCD_TOKEN expires:** Update Vault path `secret/platform/infraweaver-console` key `argocd-token` with new token. ArgoCD generates tokens via `argocd account generate-token`. After updating Vault, the pod needs a restart: `kubectl rollout restart deployment/infraweaver-console -n infraweaver-console`

- **If apps section is empty after redeploy:** Check if ARGOCD_TOKEN is valid. Visit `/self-test` → run Security category → check "Required secret env vars". Also run the ArgoCD category.

- **Agent reattachment:** Copilot CLI agents run in the session environment (/home/runner), not in the cluster. They reconnect automatically when a new Copilot session starts. Agent work is committed to git and deployed via normal CI/CD.

- **Multi-cluster context switching:** Set `CLUSTER_CONTEXTS` env var in deployment as JSON array (see cluster-context.ts). Add new cluster configs to Vault path `secret/platform/infraweaver-console` as JSON. Each cluster needs its own kubeconfig (base64-encoded) and optional ArgoCD token.

- **Validation:** After redeploy, visit `/self-test` and run "Run All Tests" to verify connectivity.

- **Why it matters:** Forgetting to update Vault after token rotation = empty apps section = wasted debugging time.
