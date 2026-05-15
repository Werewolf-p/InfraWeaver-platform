# Security Hardening — InfraWeaver Platform

## Research Sources
1. OWASP Kubernetes Security Cheat Sheet
2. Aqua Security — 10 Kubernetes Security Best Practices
3. NSA/CISA Kubernetes Hardening Guidance v1.2 (Aug 2022)
4. Kubernetes official docs — Security Overview
5. Kubernetes official docs — Securing a Cluster
6. Kubernetes official docs — Pod Security Standards
7. Snyk — Kubernetes Security Guide

## Implemented Security Controls

### ✅ Identity & Access

| Control | Details |
|---------|---------|
| OIDC authentication | ArgoCD uses Authentik OIDC — no static passwords |
| ArgoCD local admin disabled | `admin.enabled: "false"` in argocd-cm |
| RBAC per user | remon=admin (ClusterRole), ardaty=readonly |
| No default service account tokens | Applications use dedicated ServiceAccounts |
| External secrets only | All secrets via OpenBao + ExternalSecrets Operator |
| No plaintext secrets in git | Zero Secret objects with real data in repository |

### ✅ Network Security

| Control | Details |
|---------|---------|
| NetworkPolicies — argocd | default-deny + allow-traefik + allow-webhook + allow-metrics |
| NetworkPolicies — external-secrets | default-deny + allow-openbao + allow-apiserver + allow-prometheus |
| NetworkPolicies — external-dns | default-deny + allow-traefik |
| NetworkPolicies — openbao | default-deny + allow-eso + allow-traefik + allow-raft + allow-monitoring |
| NetworkPolicies — authentik | default-deny + allow-traefik + allow-intra + allow-prometheus |
| NetworkPolicies — cert-manager | default-deny + allow-traefik |
| NetworkPolicies — monitoring | default-deny + allow-traefik + allow-prometheus + allow-intra |
| NetworkPolicies — traefik | default-deny + allow-external |
| NetworkPolicies — netbird | default-deny + allow-traefik + allow-intra + allow-external-peers + allow-prometheus |
| NetworkPolicies — apps-grafana | default-deny + allow-traefik + allow-monitoring |
| NetworkPolicies — apps-demo-app | default-deny + allow-traefik |
| VPN-only internal access | `int.rlservers.com` routes require NetBird connection |
| Secure headers on all routes | HSTS, X-Frame-Options, X-Content-Type-Options, CSP |
| TLS everywhere | cert-manager + Let's Encrypt on all public + internal routes |
| NetBird per-group policies | admin-full-access, proxmox-port-access (TCP 8006 only) |

### ✅ Pod & Workload Security

| Control | Details |
|---------|---------|
| PSA baseline — most namespaces | argocd, cert-manager, external-secrets, openbao, authentik, external-dns |
| PSA privileged — infrastructure | traefik, ingress-nginx (required for privileged host networking) |
| No privileged containers | blocked by PSA baseline in all non-infrastructure namespaces |
| No hostPath volumes | blocked by PSA baseline |

### ✅ Secrets Management

| Control | Details |
|---------|---------|
| OpenBao (Vault fork) | All platform secrets stored in OpenBao |
| Short-lived service tokens | ESO token is 168h periodic, renewed each deploy |
| No root token in cluster | Root token used only during initial bootstrap |
| ExternalSecrets Operator | Injects secrets at pod runtime, not baked into images |
| ClusterSecretStore | Single point of trust — openbao.openbao.svc.cluster.local:8200 |
| openbao-token outside ArgoCD | Secret created by workflow only, never tracked in git |

### ✅ Platform Security

| Control | Details |
|---------|---------|
| Talos Linux | Immutable OS, no SSH, no package manager on nodes |
| GitOps via ArgoCD | All cluster changes via git PRs — full audit trail |
| Image pinning | All NetBird and critical images pinned to SHA/version |
| Trivy image scanning | CI scans on every push |
| ArgoCD selfHeal=true | Drift detection + automatic correction |
| OpenBao audit logging | Enabled in production |
| etcd protected | Talos manages etcd with mTLS between nodes |

---

## NetBird Access Control Model

### Groups
| Group | Members | Purpose |
|-------|---------|---------|
| All | Every enrolled peer | Base group |
| routing-peers-vlan3 | netbird-router-vlan3 VM | Subnet route advertisers |
| infrastructure | Router + CI runner VMs | Management access |
| ci-runners | Runner VMs (10.10.0.118) | CI/CD workloads |
| platform-admins | remon's devices | Full VPN access |
| platform-users | ardaty's devices | Regular VPN access |
| proxmox-users | ardaty's proxmox device | Proxmox UI access only |
| internal-services-admin | — | Admin services resource group |
| internal-services-all | — | User services resource group |

### Policies
| Policy | Source → Destination | Ports |
|--------|---------------------|-------|
| admin-full-access | platform-admins → All | all |
| user-subnet-access | platform-users → routing-peers-vlan3 | all |
| infra-to-all | infrastructure → All | all |
| proxmox-port-access | proxmox-users → routing-peers-vlan3 | TCP 8006 only |
| admin-peer-direct | platform-admins ↔ ci-runners | all |

### Per-User Proxmox Access (ardaty example)
To give ardaty access to 10.25.0.3:8006:
1. ardaty enrolls their device using `proxmox-client-key` (auto-assigns to `proxmox-users` group)
2. `proxmox-port-access` policy: proxmox-users → routing-peers-vlan3 TCP 8006
3. The router VM (in routing-peers-vlan3) routes traffic to 10.25.0.3:8006
4. ardaty can now reach the Proxmox UI at https://10.25.0.3:8006

Setup keys are stored in OpenBao and surfaced via ExternalSecret in the netbird namespace.
ardaty's `users.yaml` entry documents: `netbird_setup_key: proxmox-client-key`

---

## Implemented Security Controls — Round 2 (2026-06)

### ✅ New Network Policies

| Namespace | File | Coverage |
|-----------|------|----------|
| kyverno | `kubernetes/core/kyverno/manifests/networkpolicy.yaml` | default-deny + allow webhook (API server) + allow Prometheus scrape + allow intra-ns |

**Critical note for kyverno webhook NetworkPolicy:** The API server webhook allow rule uses NO `from:` selector
(allows any source on port 9443) — same pattern as cert-manager. This is intentional: in Talos, the kube-apiserver
runs as a static pod and its traffic source IP is not reliably matchable via namespaceSelector.
Do NOT add a restrictive `from:` selector to the kyverno webhook allow rule or pod admission will fail cluster-wide.

### ✅ New Kyverno Policies

| Policy | File | Mode | Scope |
|--------|------|------|-------|
| `require-seccomp-profile` | `seccomp-policy.yaml` | Audit | catalog-* and apps-* pods |
| `warn-automount-service-account-token` | `seccomp-policy.yaml` | Audit | catalog-* pods |

### ✅ Route Security Hardening

**Internal bare-metal routes (`07-routes-internal.yaml`):**
- Added `secure-headers` middleware to: adguard, ansible, traefik-dashboard, proxmox, portainer, portainer2, truenas, vault1
- Added `forward-auth` middleware to `traefik-dashboard` — Traefik dashboard has no built-in auth;
  any VPN user could view all routing rules and backend IPs without this

**Public external routes (`08-routes-external.yaml`):**
- Added `secure-headers` middleware to: wp-rlservers, keycloak, awx, bitwarden, gitlab, nextcloud, teleport
- Added `secure-headers` prepended to: yonavaarwater-ot (already had forward-auth)

---

## Implemented Security Controls — Round 3 (2026-06)

### ✅ New Network Policies

| Namespace | File | Coverage |
|-----------|------|----------|
| onedev | `kubernetes/catalog/onedev/manifests/networkpolicy.yaml` | default-deny ingress + allow Traefik HTTP + allow intra-namespace traffic for bootstrap jobs |
| infraweaver-console | `kubernetes/catalog/infraweaver-console/manifests/networkpolicy.yaml` | added namespace-wide default-deny ingress on top of existing app-specific allow rules |

### ✅ Kyverno Policy Fixes + Additions

| Policy | File | Mode | Scope |
|--------|------|------|-------|
| Existing pod security audit policies | `cluster-policies.yaml`, `seccomp-policy.yaml` | Audit | now match real `infraweaver.io/type=catalog-app` namespaces instead of unused `catalog-*`/`apps-*` namespace globs |
| `disallow-privilege-escalation` | `cluster-policies.yaml` | Audit | catalog-app pods |
| `disallow-hostpath-volumes` | `cluster-policies.yaml` | Audit | catalog-app pods |

### ✅ Pod / Route Hardening

- Added Pod Security Admission labels to `onedev` and `infraweaver-console` namespaces: `enforce=baseline`, `audit=restricted`, `warn=restricted`
- Disabled automatic ServiceAccount token mounting for OneDev server pods and the OneDev bootstrap Job
- Added `secure-headers` to the OneDev public route and remaining public website routes (`degoudentijd`, `feest`, `marcel`, `yonavaarwater`, `zonnevaarwater`, `waterdance`)
- Improved `security.yml` with least-privilege workflow permissions, concurrency control, and PR dependency review

## Remaining Gaps (future work)

| Gap | Priority | Notes |
|-----|----------|-------|
| Kubernetes audit logging | Medium | Talos supports it — configure via MachineConfig |
| Runtime security (Falco) | Low | Would detect container escapes, unusual syscalls |
| Container image signing (Cosign) | Low | SLSA supply chain hardening |
| Resource Quotas per namespace | Low | Blast radius limiting |
| Seccomp RuntimeDefault enforcement | Low | Policy added as Audit; raise to Enforce when all pods comply |
| automount SA token enforcement | Low | Policy added as Audit; disable in apps that don't need K8s API access |
| OPA Gatekeeper policies | Low | Enforce security policies at admission |
| Network Policy for longhorn-system | Medium | Complex — needs careful testing |
| Network Policy for metallb-system | Low | Infrastructure component |
| Network Policy for apps-homepage | Low | Helm-only app, needs bootstrap Application |
| PSA restricted (not just baseline) | Low | Would require runAsNonRoot + readOnlyRootFS |

---

## Known ArgoCD Schema Quirks

### orphanedResources on AppProject (not Application)
- `spec.orphanedResources` belongs on **AppProject**, not Application
- AppProject `ignore` entries do NOT support `namespace` field in this ArgoCD version
- To suppress warnings: add to `appproject-platform.yaml` spec.orphanedResources.ignore

### openbao-token Secret not tracked by ArgoCD
- Secret is created exclusively by `full-redeploy.yml` workflow
- Removing it from git caused ArgoCD to prune it → recreate manually or re-run workflow
- After ArgoCD prune: `kubectl exec openbao-0 -- bao token create -policy=platform-k8s -period=168h`
  then `kubectl create secret generic openbao-token -n external-secrets --from-literal=token=...`

### ClusterSecretStore OPENBAO_ADDR_PLACEHOLDER
- If ArgoCD applied an old version of cluster-secret-store.yaml, the server URL stays as placeholder
- Fix: `kubectl patch clustersecretstore openbao --type=merge -p '{"spec":{"provider":{"vault":{"server":"http://openbao.openbao.svc.cluster.local:8200"}}}}'`

### Bootstrap ComparisonError after schema-invalid YAML
- If an Application YAML contains a field not in the CRD schema (e.g., spec.orphanedResources)
- ArgoCD will refuse to diff and show ComparisonError on the bootstrap app
- Fix: remove invalid fields from git, then `argocd.argoproj.io/refresh=hard` annotation
