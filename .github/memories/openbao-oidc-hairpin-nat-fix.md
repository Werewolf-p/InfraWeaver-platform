# OpenBao OIDC + Two-Phase ArgoCD Deploy Patterns

## Problem: OpenBao OIDC Discovery URL (Hairpin NAT)

**Symptom:** `bao write auth/oidc/config oidc_discovery_url="https://auth.rlservers.com/..."` fails with:
```
Error writing data to auth/oidc/config: error checking oidc discovery URL
Code: 400
```

**Root Cause:** Pods inside the cluster cannot reach the cluster's own external MetalLB IP.
`auth.rlservers.com` → resolves to public/MetalLB IP → hairpin NAT fails → connection refused.

**Solution:** Use internal Authentik cluster service URL:
```
http://authentik-server.authentik.svc.cluster.local/application/o/openbao/
```
OpenBao only uses this URL **server-side** to fetch JWKS keys. End-users still see/redirect to `https://auth.rlservers.com` — the two URLs don't need to match.

**Pre-check trick:** The OpenBao container image has no `curl`/`wget`. Check the endpoint from the **runner** via port-forward instead:
```bash
kubectl port-forward svc/authentik-server -n authentik 8087:80 &
HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' \
  "http://localhost:8087/application/o/openbao/.well-known/openid-configuration")
# HTTP_CODE == "200" means Authentik has provisioned the openbao application
```

**Working config:**
```bash
bao write auth/oidc/config \
  oidc_discovery_url="http://authentik-server.authentik.svc.cluster.local/application/o/openbao/" \
  oidc_client_id="openbao" \
  oidc_client_secret="$OPENBAO_SECRET" \
  default_role="default"
```

---

## Problem: Two-Phase ArgoCD Deploy on Fresh Cluster

**Symptom:** `tofu apply` fails during full redeploy with:
```
API did not recognize GroupVersionKind (CRD may not be installed):
no matches for kind "AppProject" in group "argoproj.io"
```

**Root Cause:** The `kubernetes_manifest` Terraform resource for `AppProject` validates the CRD schema **during `tofu plan`**, not just apply. On a fresh cluster, ArgoCD isn't installed yet, so the CRD doesn't exist.

**Solution:** Two-phase apply in the Deploy Platform step:

**Stage 2a** — Install ArgoCD only (targeted apply):
```bash
tofu apply -auto-approve \
  -target=module.platform_bootstrap.kubernetes_namespace.argocd \
  -target=module.platform_bootstrap.helm_release.argocd
```

**Wait for CRDs** to be established:
```bash
for crd in appprojects.argoproj.io applications.argoproj.io applicationsets.argoproj.io; do
  kubectl wait --for=condition=Established crd/$crd --timeout=300s
done
```

**Stage 2b** — Full apply (CRDs now exist, plan succeeds):
```bash
tofu apply -auto-approve
```

---

## Problem: Stale State UpgradeResourceState on Redeploy

**Symptom:** After destroy+recreate, `tofu init` fails:
```
UpgradeResourceState: no matches for kind "AppProject" in group "argoproj.io"
```

**Root Cause:** Stale state has `kubernetes_manifest.app_project` with the old CRD schema. The provider tries to upgrade the schema on init by querying the live cluster API — which doesn't have ArgoCD yet.

**Solution:** Clear `module.platform_bootstrap` state before plan:
```bash
tofu state list | grep "module.platform_bootstrap" | while read r; do
  tofu state rm "$r"
done
```

This forces a clean plan for the bootstrap module.

---

## Workflow: configure-oidc.yml

A standalone `workflow_dispatch` workflow exists at `.github/workflows/configure-oidc.yml`.
Use it whenever OIDC needs to be re-configured without a full redeploy:
- After full-redeploy if OIDC step timed out  
- After Authentik blueprint changes
- After OAuth2 provider rotation

Requires: `management-host` runner (has kubeconfig at `~/.kube/config-platform-productie`)

---

## Repo Structure: Platform Tier (2026-05)

Platform services moved from `kubernetes/apps/` → `kubernetes/platform/`:
- `authentik`, `dns`, `external-routes`, `grafana`, `homepage`, `netbird`

Bootstrap Application paths in `kubernetes/bootstrap/app-*.yaml` updated accordingly.
ArgoCD ApplicationSet scans `kubernetes/*/*/application.yaml` — tier prefix appears in app name.
