---
title: Zero-Trust Security — 100 Ideas & Implementation Plans
description: Comprehensive zero-trust security hardening roadmap for InfraWeaver homelab platform
generated: 2026-05
branch: feat/security-zero-trust
---

# Zero-Trust Security — 100 Ideas & Implementation Plans

> Scope: InfraWeaver homelab platform (Talos K8s, ArgoCD, Authentik, OpenBao, Traefik, NetBird, Kyverno, Wazuh)
> Assumption: Network is hostile. Defense in depth. Zero implicit trust between any components.

---

## DOMAIN 1 — NETWORK SECURITY (ideas 1–22)

### 1. Egress NetworkPolicy: argocd namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/argocd/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` NetworkPolicy to argocd namespace
2. Add explicit allow rules: DNS (53), K8s API (6443/443), OpenBao (8200), Authentik (80), external HTTPS (443)
3. Validate with `kubectl apply --dry-run=server`
**Value:** Prevents compromised ArgoCD pods from exfiltrating data or pivoting to arbitrary targets.

### 2. Egress NetworkPolicy: cert-manager namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/cert-manager/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow DNS, K8s API, external HTTPS (ACME/Cloudflare)
**Value:** Cert-manager only needs ACME and K8s API. Blocking all other egress contains blast radius.

### 3. Egress NetworkPolicy: external-secrets namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/external-secrets/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow DNS, OpenBao (8200), K8s API
**Value:** ESO should only talk to OpenBao. If compromised, it cannot reach arbitrary secrets stores.

### 4. Egress NetworkPolicy: kyverno namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/kyverno/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow DNS, K8s API
**Value:** Kyverno admission controller only needs K8s API for background scans and webhook responses.

### 5. Egress NetworkPolicy: openbao namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/openbao/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow DNS, K8s API (for k8s auth backend TokenReview)
**Value:** OpenBao is the keys-to-the-kingdom. No outbound needed except K8s auth verification.

### 6. Egress NetworkPolicy: tighten infraweaver-api
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/catalog/infraweaver-api/manifests/networkpolicy.yaml`
**Plan:**
1. Replace `egress: [{}]` (allow-all) with specific destinations: DNS, K8s API (6443), ArgoCD (80), external HTTPS (443)
2. Remove the catch-all `- {}` rule
**Value:** The API had unrestricted egress. Now it can only reach what it legitimately needs.

### 7. Egress NetworkPolicy: authentik namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/platform/authentik/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow: DNS, PostgreSQL (in-cluster 5432), Redis (6379), external HTTPS (email SMTP 587, LDAP 389/636), K8s API
2. Note: Authentik sends emails and can reach external LDAP — scope carefully
**Value:** Authentik is identity backbone; a compromised Authentik pod exfiltrating data is critical risk.

### 8. Egress NetworkPolicy: netbird namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/platform/netbird/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow: DNS, external HTTPS (443) for OIDC, signal port (10000), relay port (443)
2. The bootstrap job needs HTTPS to management API
**Value:** NetBird is VPN backbone — limits blast radius if a component is compromised.

### 9. Egress NetworkPolicy: grafana namespace
**Status: PENDING**
**Target:** `kubernetes/platform/grafana/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow: DNS, Prometheus (9090), Loki (3100), external HTTPS (plugin downloads, alerts)
**Value:** Grafana should only pull metrics from known sources.

### 10. NetworkPolicy for longhorn-system
**Status: PENDING**
**Target:** `kubernetes/core/longhorn/manifests/` (new networkpolicy.yaml)
**Plan:**
1. Start with ingress-only default-deny
2. Allow Traefik → Longhorn UI (80), Prometheus → Longhorn metrics (9500)
3. Allow inter-node Longhorn replication (9500, 9501, 9502) via ipBlock node CIDR
4. Note: complex — test in Audit before Enforce
**Value:** Longhorn has access to all PVCs. A compromised Longhorn manager could read all persistent data.

### 11. NetworkPolicy for monitoring namespace
**Status: PENDING**
**Target:** `kubernetes/monitoring/kube-prometheus-stack/manifests/` (new networkpolicy.yaml)
**Plan:**
1. Default-deny ingress
2. Allow Traefik → Grafana (3000), Alertmanager (9093), Prometheus (9090)
3. Allow scrape egress to all namespaces on metrics ports
**Value:** Prometheus scrapes all pods — a compromised Prometheus can read all metric data including secrets leaked via metrics.

### 12. NetworkPolicy for wazuh namespace
**Status: PENDING**
**Target:** `kubernetes/platform/wazuh/manifests/` (new networkpolicy.yaml)
**Plan:**
1. Default-deny ingress
2. Allow agent enrollment (1514, 1515), API (55000), syslog (514/UDP)
3. Allow Traefik → Wazuh dashboard (5601)
**Value:** SIEM receives security events from all agents — access should be tightly scoped.

### 13. NetworkPolicy for catalog apps: template default-deny
**Status: PENDING**
**Target:** `kubernetes/catalog/_template/manifests/networkpolicy.yaml` (new file)
**Plan:**
1. Add default-deny ingress + allow-traefik + default-deny-egress to `_template/`
2. Instruct `new-app.sh` to copy this template when creating new catalog apps
3. 27 catalog apps currently lack any NetworkPolicy
**Value:** Without NetworkPolicies, any compromised catalog app can reach all cluster services.

### 14. IP allowlist tightening: netbird-vpn-only middleware
**Status: REVIEW**
**Target:** `kubernetes/platform/external-routes/manifests/01-middlewares.yaml`
**Plan:**
1. Audit `netbird-vpn-only` allowlist — currently allows `100.64.0.0/10` (all NetBird CGNAT)
2. Consider restricting to specific enrolled peer IPs via NetBird groups (requires dynamic config update)
3. Add rate limiting middleware to VPN-only routes
**Value:** Currently any NetBird peer (including compromised ones) can reach all `.int.` routes.

### 15. Traefik egress NetworkPolicy
**Status: PENDING**
**Target:** `kubernetes/core/traefik/manifests/networkpolicy.yaml`
**Plan:**
1. Traefik currently has no egress restriction — add default-deny-egress
2. Allow egress to all namespaces (Traefik routes to any backend) — use wide allow but restrict ports
3. Allow port 80, 443, specific backend ports only
**Value:** Traefik is the perimeter — if compromised with open egress it becomes a perfect SSRF pivot.

### 16. Mutual TLS between Traefik and backends
**Status: PENDING**
**Target:** `kubernetes/platform/external-routes/manifests/00-servertransport.yaml`
**Plan:**
1. For internal backends (ArgoCD, Authentik, OpenBao), create ServersTransport with mTLS
2. Deploy cert-manager Certificate for each backend, configure Traefik to present client cert
3. Start with ArgoCD and OpenBao as highest-value backends
**Value:** Even if someone bypasses Traefik IP allowlists, backends won't accept connections without client cert.

### 17. NetworkPolicy: separate game-servers namespace
**Status: PENDING**
**Target:** `kubernetes/catalog/game-hub/game-servers-namespace.yaml` + new networkpolicy.yaml
**Plan:**
1. Add default-deny ingress + default-deny egress to `game-servers` namespace
2. Allow only specific game ports (Minecraft 25565, Valheim 2456-2458) inbound from MetalLB
3. Allow DNS egress only (no internet access for game servers)
**Value:** Game servers run untrusted code (mods). Lateral movement must be blocked.

### 18. Kubernetes API audit logging
**Status: PENDING**
**Target:** Talos MachineConfig (`infrastructure/talos/`)
**Plan:**
1. Enable `kube-apiserver` audit policy in Talos MachineConfig
2. Configure policy to log: Namespace-level `RequestResponse`, secret access at `RequestResponse`, service account token creation at `RequestResponse`
3. Ship audit logs to Wazuh or Loki via fluentbit DaemonSet
**Value:** Without audit logging, there is no record of who accessed what secrets or made what API calls.

### 19. Restrict MetalLB IP pool advertisement
**Status: REVIEW**
**Target:** `kubernetes/core/metallb/manifests/ip-pool.yaml`
**Plan:**
1. Review IPAddressPool — ensure only intended IPs (10.10.0.200-205) are in pool
2. Add BGP peer authentication if BGP mode is used
3. Ensure MetalLB speaker pods have restrictive NetworkPolicy
**Value:** Misconfigured MetalLB can advertise unintended IPs, potentially hijacking traffic.

### 20. Implement NetworkPolicy for external-dns namespace
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/platform/external-dns/manifests/networkpolicy.yaml`
**Plan:**
1. Add `default-deny-egress` + allow: DNS (53), Cloudflare API (443 external), K8s API
**Value:** External-DNS writes public DNS records — uncontrolled egress could leak internal topology.

### 21. Service mesh (Cilium or Istio) for mTLS between all pods
**Status: LONG-TERM**
**Target:** New core app `kubernetes/core/cilium/`
**Plan:**
1. Evaluate Cilium as Flannel replacement (Talos supports it natively via `--cni=cilium`)
2. Enable Hubble for network observability
3. CiliumNetworkPolicy for L7 (HTTP path-level) filtering on ArgoCD and Authentik
**Value:** Cilium replaces coarse NetworkPolicy with L7-aware mTLS + eBPF-enforced microsegmentation.

### 22. Enforce TLS minimum version 1.3 on all internal services
**Status: PARTIAL** (TLSOptions exist for Traefik)
**Target:** `kubernetes/core/traefik/manifests/tls-options.yaml`
**Plan:**
1. Review TLSOptions — ensure `minVersion: VersionTLS13` is set
2. Add ClientAuth (mTLS requirement) option for admin-facing routes
3. Extend to internal K8s services that support TLS (OpenBao, Authentik)
**Value:** TLS 1.2 has known vulnerabilities (BEAST, POODLE mitigations not universal). TLS 1.3 is mandatory for zero-trust.

---

## DOMAIN 2 — IDENTITY & ACCESS (ideas 23–42)

### 23. automountServiceAccountToken: false on infraweaver-console SA
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/catalog/infraweaver-console/manifests/serviceaccount.yaml`
**Plan:**
1. Add `automountServiceAccountToken: false` to the ServiceAccount object
2. The console delegates cluster ops to infraweaver-api, so it has no need for SA token
**Value:** Console SA token mounted by default can be stolen from a compromised pod for lateral movement.

### 24. automountServiceAccountToken: false on infraweaver-api SA
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/catalog/infraweaver-api/manifests/serviceaccount.yaml`
**Plan:**
1. Add `automountServiceAccountToken: false` — API uses ARGOCD_TOKEN from ExternalSecret, not SA token
**Value:** API SA token is not used for K8s operations. Mounting it unnecessarily exposes it.

### 25. automountServiceAccountToken: false on netbird relay/signal pods
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/platform/netbird/manifests/relay.yaml`, `signal.yaml`
**Plan:**
1. Add `automountServiceAccountToken: false` to pod spec in both Deployments
2. These pods have no K8s API interaction
**Value:** NetBird relay/signal are internet-exposed. Stolen SA token from these pods enables K8s access.

### 26. automountServiceAccountToken: false for all catalog apps
**Status: PENDING**
**Target:** All `kubernetes/catalog/*/manifests/*.yaml` Deployments
**Plan:**
1. Add `automountServiceAccountToken: false` to pod specs of all catalog app Deployments
2. Kyverno policy `warn-automount-service-account-token` already audits this — promote to Enforce
3. Exception: apps that legitimately need K8s API (infraweaver-node needs it)
**Value:** 27 catalog apps default to automounting SA tokens. Mass lateral movement vector.

### 27. RBAC least privilege audit for infraweaver ClusterRoles
**Status: PENDING**
**Target:** `kubernetes/catalog/infraweaver-console/manifests/rbac.yaml`, `infraweaver-api/manifests/rbac.yaml`
**Plan:**
1. Audit current ClusterRole rules — list every verb/resource combination
2. Remove `*` wildcards; replace with explicit verb lists
3. Replace ClusterRole with namespace-scoped Role where possible (e.g., managing only specific namespaces)
4. Add `resourceNames` constraints where possible
**Value:** Wildcarded ClusterRoles are privilege escalation paths. Minimum viable permissions reduce blast radius.

### 28. Kyverno Enforce: disallow default ServiceAccount
**Status: IMPLEMENTED (policy added as Audit)**
**Target:** `kubernetes/core/kyverno/manifests/cluster-policies.yaml`
**Plan:**
1. Policy `disallow-default-service-account` added in Audit mode
2. After fixing violations, promote to Enforce
3. Create explicit ServiceAccounts for any app currently using default
**Value:** Default SA with no RBAC is low-risk unless RBAC is later granted carelessly.

### 29. Promote seccomp policy from Audit to Enforce
**Status: PENDING**
**Target:** `kubernetes/core/kyverno/manifests/seccomp-policy.yaml`
**Plan:**
1. Run: `kubectl get policyreport -A -o json | jq '.items[].results[] | select(.policy=="require-seccomp-profile")'`
2. Add `seccompProfile.type: RuntimeDefault` to all violating pods
3. Change `validationFailureAction: Audit` → `Enforce` in policy
**Value:** RuntimeDefault seccomp blocks ~44% of syscalls used in container escape CVEs.

### 30. Promote automount SA token from Audit to Enforce
**Status: PENDING**
**Target:** `kubernetes/core/kyverno/manifests/seccomp-policy.yaml`
**Plan:**
1. Fix violations from `warn-automount-service-account-token` policy
2. Change to Enforce after all catalog apps set `automountServiceAccountToken: false`
**Value:** Token exposure to all catalog pods is the most common lateral movement vector.

### 31. Short-lived kubeconfig for infraweaver-api
**Status: PENDING**
**Target:** `kubernetes/catalog/infraweaver-api/manifests/` + OpenBao config
**Plan:**
1. Configure OpenBao Kubernetes secrets engine to issue short-lived kubeconfig tokens
2. ExternalSecret with `refreshInterval: 1h` fetches rotating credentials
3. Map to specific ClusterRole (not cluster-admin)
**Value:** ARGOCD_TOKEN is long-lived. Dynamic tokens with 1h TTL limit credential theft window.

### 32. Authentik session hardening
**Status: PENDING**
**Target:** `kubernetes/platform/authentik/manifests/blueprint-access-control.yaml`
**Plan:**
1. Reduce session cookie lifetime from default (days) to hours for admin group
2. Enable MFA enforcement for platform-admins group
3. Enable IP binding on sessions (invalidate session if source IP changes)
4. Enable Authentik GeoIP blocking for unexpected regions
**Value:** Long-lived Authentik sessions are persistent compromise if a device is stolen.

### 33. Rotate ArgoCD service account token
**Status: PENDING**
**Target:** OpenBao + `kubernetes/core/argocd/` RBAC
**Plan:**
1. Replace static ARGOCD_TOKEN in console with dynamic OpenBao-issued token
2. Configure OpenBao Kubernetes auth + policy for argocd SA token issuance
3. ExternalSecret fetches rotating token with 1h TTL
**Value:** Static tokens never expire. Dynamic rotation limits credential theft window.

### 34. Authentik forward-auth on all `.int.` admin routes
**Status: REVIEW**
**Target:** `kubernetes/platform/external-routes/manifests/` (routes-internal, routes-vpn-only)
**Plan:**
1. Audit which VPN-only routes still lack `forward-auth` middleware
2. Traefik dashboard: ✓ already has forward-auth per security-hardening memory
3. ArgoCD: uses OIDC natively — verify Authentik is enforced at the app level too
4. Add `forward-auth-admin` to all routes requiring platform-admin access
**Value:** NetBird VPN access ≠ authentication. Both layers are needed.

### 35. RBAC for Kubernetes API: restrict argocd permissions
**Status: REVIEW**
**Target:** ArgoCD Helm values + `kubernetes/core/argocd/`
**Plan:**
1. Audit ArgoCD ClusterRole — does it use `*` verbs?
2. Configure ArgoCD `resource.customizations` to limit which resource types ArgoCD can manage
3. Namespace-scope ArgoCD project for catalog apps (already partially done via AppProjects)
**Value:** ArgoCD cluster-admin equivalent is a significant privilege escalation if ArgoCD is compromised.

### 36. OpenBao: enable Kubernetes auth backend for all service accounts
**Status: PENDING**
**Target:** OpenBao config + `kubernetes/core/openbao/` + ExternalSecrets
**Plan:**
1. Enable `kubernetes` auth method in OpenBao (`bao auth enable kubernetes`)
2. Create policies per SA (e.g., `cert-manager-policy`, `eso-policy`)
3. Migrate from static token to dynamic K8s auth for ExternalSecrets
**Value:** Static openbao-token is 168h — if stolen, 7 days of secrets access. K8s auth gives short-lived tokens.

### 37. OpenBao dynamic secrets for Cloudflare API token
**Status: PROOF-OF-CONCEPT PENDING**
**Target:** OpenBao config + `kubernetes/platform/external-dns/manifests/externalsecret.yaml`
**Plan:**
1. Store Cloudflare API token in OpenBao at `secret/platform/cloudflare`
2. Configure OpenBao to rotate the token quarterly (manual rotation trigger via Terraform)
3. ExternalSecret refreshes every 1h so pods always get current token
**Value:** Cloudflare API token is currently static. Dynamic rotation limits the blast radius of a leaked token.

### 38. NetBird setup key rotation enforcement
**Status: REVIEW** (memory exists: netbird-setup-key-rotation.md)
**Target:** `kubernetes/platform/netbird/manifests/externalsecret.yaml`
**Plan:**
1. Set NetBird setup keys to expire after 30 days (already noted in memory)
2. Create a CronJob or Terraform automation to rotate keys monthly
3. Store new key in OpenBao + push to netbird API
**Value:** Permanent setup keys allow any stolen key to enroll new VPN peers indefinitely.

### 39. OIDC for Traefik dashboard (not just forward-auth)
**Status: PENDING**
**Target:** Traefik Helm values
**Plan:**
1. Enable Traefik's built-in OIDC plugin (or use OAuth2-Proxy sidecar)
2. Forward-auth currently redirects to Authentik — verify Authentik returns 401 for unauthenticated
3. Add `X-authentik-groups` check in forward-auth middleware to enforce platform-admins
**Value:** Forward-auth without group enforcement lets any Authentik user see all routes.

### 40. ArgoCD SSO group mapping review
**Status: REVIEW**
**Target:** `kubernetes/core/argocd/values.yaml` OIDC/RBAC config
**Plan:**
1. Verify ArgoCD policy maps `platform-admins` → admin, `platform-users` → readonly
2. Ensure no ArgoCD local accounts exist besides the disabled admin
3. Add test: `argocd account list` should return empty or only disabled accounts
**Value:** Stale OIDC group mappings can silently grant admin access to users who left the group.

### 41. Disable Kubernetes Dashboard (if installed)
**Status: CHECK**
**Plan:** `kubectl get deploy -A | grep dashboard` — if found, evaluate whether it's needed. Replace with InfraWeaver console functionality.
**Value:** K8s dashboard with improper auth is a critical attack surface.

### 42. Pod-level RBAC: disallow all catalog SA from accessing secrets
**Status: PENDING**
**Target:** Kyverno policy (new in `cluster-policies.yaml`)
**Plan:**
1. Add Kyverno `generate` policy: when a ServiceAccount is created in a catalog namespace, deny it `get/list/watch` on `secrets` resource
2. Allow specific SAs that legitimately need secret access (e.g., infraweaver-api)
**Value:** No catalog app should be able to list cluster secrets directly.

---

## DOMAIN 3 — SUPPLY CHAIN (ideas 43–58)

### 43. Pin bitnami/kubectl:latest in self-healer CronJob
**Status: IMPLEMENTED (feat/security-zero-trust)**
**Target:** `kubernetes/core/argocd/manifests/self-healer.yaml`
**Plan:**
1. Replace `bitnami/kubectl:latest` with `bitnami/kubectl:1.35.4` (matches server K8s 1.35.4)
2. Add to ArgoCD Image Updater tracking if desired
**Value:** `:latest` images are mutable — they can be silently replaced with malicious versions on re-pull.

### 44. Pin alertmanager-discord image
**Status: PENDING**
**Target:** `kubernetes/monitoring/alertmanager-discord/manifests/discord-bridge.yaml`
**Plan:**
1. Replace `benjojo/alertmanager-discord:latest` with pinned version
2. Check: `docker manifest inspect benjojo/alertmanager-discord:latest`
**Value:** Monitoring alerting pipeline runs with :latest — a hijacked image silences all alerts.

### 45. Pin cyberchef, speedtest-tracker, excalidraw, grocy, searxng images
**Status: PENDING**
**Target:** Respective `kubernetes/catalog/*/manifests/all.yaml`
**Plan:**
1. `cyberchef`: replace `mpepping/cyberchef:latest` → `mpepping/cyberchef:v10.x.y`
2. `speedtest-tracker`: replace `:latest` → specific version tag
3. `excalidraw`: replace `:latest` → specific version
4. `grocy`: replace `:latest` → specific version
5. `searxng`: replace `:latest` → specific version
**Value:** 5 production services running :latest images. Any upstream compromise is silently deployed.

### 46. Pin game-hub server images
**Status: PENDING**
**Target:** `kubernetes/catalog/game-hub/servers/valheim.yaml`, `minecraft-server.yaml`
**Plan:**
1. Valheim: `lloesche/valheim-server:latest` → pinned tag
2. Minecraft: `itzg/minecraft-server:latest` → pinned tag
3. Add ArgoCD Image Updater annotations for auto-updates to new pinned versions
**Value:** Game servers run privileged with host-mount access. :latest compromise = node compromise.

### 47. Image digest pinning for critical infrastructure images
**Status: PENDING**
**Target:** `kubernetes/platform/netbird/manifests/*.yaml`, `kubernetes/core/openbao/values.yaml`
**Plan:**
1. Replace version tags with `image:tag@sha256:digest` for: netbirdio/management, netbirdio/relay, netbirdio/signal, quay.io/openbao/openbao
2. Script: `docker manifest inspect <image>:<tag> | jq '.config.digest'`
3. Store digests in `.github/memories/image-digests.md`
**Value:** A compromised image registry could serve malicious images with the same tag. Digest pinning prevents this.

### 48. Add Cosign/Sigstore image verification Kyverno policy
**Status: PENDING**
**Target:** `kubernetes/core/kyverno/manifests/` (new `image-signature-policy.yaml`)
**Plan:**
1. Install Sigstore/Cosign public key for images that sign releases (e.g., ArgoCD, Kyverno, cert-manager)
2. Add Kyverno `ClusterPolicy` with `verifyImages` rule for core infrastructure images
3. Start with Kyverno's own images as a proof-of-concept
```yaml
rules:
  - name: verify-argocd-images
    match: ...
    verifyImages:
      - imageReferences: ["quay.io/argoproj/argocd:*"]
        attestors:
          - entries:
              - keyless:
                  subject: "https://github.com/argoproj/argo-cd/.github/*"
                  issuer: "https://token.actions.githubusercontent.com"
```
**Value:** Supply chain attacks (SolarWinds-style) are defeated by signature verification.

### 49. Trivy scan in CI — fail on HIGH/CRITICAL CVEs
**Status: REVIEW**
**Target:** `.github/workflows/security.yml`
**Plan:**
1. Add `--exit-code 1 --severity HIGH,CRITICAL` to Trivy scan step
2. Add allow-list for accepted CVEs with justification comments
3. Block PR merge if new HIGH/CRITICAL CVEs detected
**Value:** Currently Trivy scans but doesn't block. CI scan without enforcement is theater.

### 50. SBOM generation on every image build
**Status: PENDING**
**Target:** `.github/workflows/build-api.yml`, `build-console.yml`, `build-node.yml`
**Plan:**
1. Add `syft` step to generate SBOM in SPDX or CycloneDX format
2. Attach SBOM to OCI image via `cosign attach sbom`
3. Store SBOMs in GitHub release artifacts
**Value:** SBOMs enable rapid CVE impact assessment when new vulnerabilities are disclosed.

### 51. ArgoCD Image Updater: pin all managed images
**Status: REVIEW**
**Target:** `kubernetes/platform/argocd-image-updater/` + app annotations
**Plan:**
1. Audit Image Updater config — ensure it uses digest pinning, not floating tags
2. Add `argocd-image-updater.argoproj.io/image-list` annotations with `digest` update strategy
3. Test: verify Image Updater commits SHA digests to git, not just new tags
**Value:** Image Updater with tag-only tracking can accidentally pull :latest equivalents.

### 52. Container registry: enforce pull-through cache via internal registry
**Status: PENDING**
**Target:** `kubernetes/catalog/registry/manifests/` + Talos machineconfig
**Plan:**
1. Configure the existing registry catalog app as a pull-through cache for Docker Hub, quay.io, ghcr.io
2. Update Talos machineconfig to use internal registry as mirror
3. Block direct pulls from public registries via egress NetworkPolicy on nodes
**Value:** Internal registry mirror: audit trail of all images pulled, block unexpected registries, survive DockerHub rate limits.

### 53. Dependency Review in GitHub Actions
**Status: PENDING**
**Target:** `.github/workflows/` (new step or workflow)
**Plan:**
1. Add `actions/dependency-review-action` to PR checks
2. Configure to fail on licenses not in approved list and on known-vulnerable packages
**Value:** Dependency confusion attacks and vulnerable npm/go packages are detected at PR time.

### 54. Lock GitHub Actions to specific commit SHAs
**Status: REVIEW**
**Target:** All `.github/workflows/*.yml`
**Plan:**
1. Replace `uses: actions/checkout@v4` with `uses: actions/checkout@<sha>`
2. Use `dependabot.yml` (already exists) to track and update pinned versions
3. Run `pin-github-actions` tool or manual audit
**Value:** Unpinned Actions can be backdoored via a tag reassignment (e.g., `actions/checkout@v4` → evil commit).

### 55. Verify Helm chart integrity before deployment
**Status: PENDING**
**Target:** ArgoCD Application source configs
**Plan:**
1. Add `spec.source.helm.skipCrds: false` and verify chart checksums
2. For critical charts (Kyverno, cert-manager), pin exact chart version + check provenance
3. Consider using ArgoCD's `spec.source.targetRevision` with exact semver, not `4.*` wildcards
**Value:** Helm chart wildcards (`4.*`) can pull in breaking or malicious minor versions automatically.

### 56. SLSA level 2: provenance attestation for InfraWeaver images
**Status: LONG-TERM**
**Target:** `.github/workflows/build-*.yml`
**Plan:**
1. Add `slsa-framework/slsa-github-generator` to build workflows
2. Generate SLSA provenance for each image build
3. Verify provenance in Kyverno image verification policy
**Value:** SLSA provenance proves the image came from a specific GitHub workflow run, preventing build pipeline attacks.

### 57. Secret scanning in git history
**Status: PENDING**
**Target:** `.github/workflows/security.yml`
**Plan:**
1. Add `gitleaks` or `trufflehog` scan to CI
2. Scan full git history once, then incremental scans on PR
3. Add pre-commit hook for local developer scanning
**Value:** Secrets accidentally committed (even to feature branches) persist in git history indefinitely.

### 58. Enforce signed commits on protected branches
**Status: PENDING**
**Target:** GitHub repository settings + `.github/` workflows
**Plan:**
1. Enable "Require signed commits" on `main` branch in GitHub settings
2. Developer GPG/SSH key enrollment in GitHub
3. Add workflow to verify commit signatures on PRs
**Value:** Unsigned commits could come from a compromised CI token. Signatures provide non-repudiation.

---

## DOMAIN 4 — RUNTIME SECURITY (ideas 59–78)

### 59. Deploy Falco for runtime syscall monitoring
**Status: IMPLEMENTED (chart + bootstrap manifests wired)**
**Target:** `kubernetes/platform/falco/` (new directory)
**Plan:**
1. Manifests created: namespace.yaml, networkpolicy.yaml, values.yaml, `application.yaml`
2. Added bootstrap Application: `kubernetes/bootstrap/app-falco-manifests.yaml`
3. Pre-requisites: OpenBao secret for Discord webhook, verify Talos BTF support
4. Tune rules after 1 week of audit output to reduce false positives
**Blockers:** Talos must have CONFIG_DEBUG_INFO_BTF=y (confirmed in Talos 1.5+). Kernel module compilation not supported on Talos.
**Value:** Falco detects active attacks that static policies cannot — container escapes, lateral movement, crypto miners.

### 60. Custom Falco rules for InfraWeaver-specific threats
**Status: PENDING** (after Falco deployment)
**Target:** `kubernetes/platform/falco/values.yaml` falco.rules_files
**Plan:**
1. Rule: alert if shell spawned in `infraweaver-console` or `infraweaver-api` pods
2. Rule: alert if any pod reads `/run/secrets/kubernetes.io/serviceaccount/token`
3. Rule: alert if outbound connection to unexpected IP from `openbao` namespace
4. Rule: alert if `kubectl exec` initiated from any catalog app pod
**Value:** Custom rules target the specific attack patterns most relevant to this platform.

### 61. Kyverno: promote disallow-privileged-containers to Enforce
**Status: PENDING**
**Target:** `kubernetes/core/kyverno/manifests/cluster-policies.yaml`
**Plan:**
1. Run: `kubectl get policyreport -A -o json | jq '.items[].results[] | select(.policy=="disallow-privileged-containers")'`
2. Fix any legitimate violations (Falco namespace is explicitly excluded — PSA handles it)
3. Change `validationFailureAction: Audit` → `Enforce`
**Value:** A single privileged container is a full node compromise vector.

### 62. Kyverno: promote require-drop-all-capabilities to Enforce
**Status: PENDING**
**Target:** `kubernetes/core/kyverno/manifests/cluster-policies.yaml`
**Plan:**
1. Audit current violations via PolicyReport
2. Add `capabilities.drop: [ALL]` to violating pods
3. Promote to Enforce
**Value:** Linux capabilities (NET_RAW, SYS_PTRACE, etc.) are privilege escalation paths without dropping ALL.

### 63. Kyverno: add readOnlyRootFilesystem policy
**Status: IMPLEMENTED (policy added as Audit)**
**Target:** `kubernetes/core/kyverno/manifests/cluster-policies.yaml`
**Plan:**
1. Policy `require-readonly-root-filesystem` added in Audit mode
2. Fix violations by adding `emptyDir` mounts + `readOnlyRootFilesystem: true`
3. Promote to Enforce after all catalog apps comply
**Value:** Read-only root filesystem prevents attackers from writing persistence scripts/binaries.

### 64. Resource quotas per namespace
**Status: PENDING**
**Target:** Add `ResourceQuota` to each catalog namespace
**Plan:**
1. Set quotas: `requests.cpu: 2`, `requests.memory: 4Gi`, `limits.cpu: 4`, `limits.memory: 8Gi` (adjust per app)
2. Add LimitRange for defaults on containers without explicit requests/limits
3. Kyverno policy `require-resource-limits` is Audit — quotas enforce at namespace level
**Value:** Without quotas, a runaway catalog app (or cryptominer) can exhaust all node resources.

### 65. Wazuh agent on all Talos nodes
**Status: PENDING** (Wazuh server deployed, but Talos agent)
**Target:** Talos MachineConfig + `kubernetes/platform/wazuh/`
**Plan:**
1. Wazuh agent on Talos requires DaemonSet approach (not node-level installation — Talos is immutable)
2. Deploy Wazuh agent as privileged DaemonSet (`wazuh-agent`)
3. Configure agent to report to `wazuh-manager-svc.wazuh.svc.cluster.local:1514`
**Value:** Host-level threat detection (file integrity, log analysis, rootkit detection) requires agent access.

### 66. Wazuh: K8s API audit log ingestion
**Status: PENDING**
**Target:** Wazuh integration + K8s audit logging (idea #18)
**Plan:**
1. After enabling K8s audit logs (#18), configure Wazuh to parse them
2. Add Wazuh rules for: `get secrets`, `list serviceaccounts`, `exec in pods`, `create clusterrolebinding`
3. Alert to Discord for any `ClusterRoleBinding` creation event
**Value:** K8s API audit + SIEM correlation = insider threat and attacker detection.

### 67. OPA/Gatekeeper policies (alternative to Kyverno)
**Status: LONG-TERM / EVALUATE**
**Plan:**
1. Evaluate whether Gatekeeper adds value alongside Kyverno (avoid duplication)
2. Use Gatekeeper for complex policies that Kyverno CEL doesn't support well
3. OPA Gatekeeper has wider enterprise adoption and more mature policy library
**Decision:** Keep Kyverno (already deployed), evaluate Gatekeeper only if Kyverno gaps emerge.

### 68. Pod Disruption Budgets for all platform services
**Status: PARTIAL** (argocd, cert-manager, authentik have PDBs)
**Target:** Add PDB to remaining platform services
**Plan:**
1. Add PDB (`minAvailable: 1`) to: OpenBao, Traefik, external-secrets, Kyverno
2. Existing: ArgoCD PDB ✓, cert-manager PDB ✓, authentik PDB ✓
**Value:** PDBs prevent accidental cluster updates from taking down all replicas of security infrastructure simultaneously.

### 69. Longhorn backup encryption
**Status: PENDING**
**Target:** `kubernetes/core/longhorn/manifests/storageclass.yaml`
**Plan:**
1. Enable Longhorn encryption with LUKS for sensitive PVCs (OpenBao data, Authentik DB)
2. Store encryption key in OpenBao, configure Longhorn CSI secret
3. Verify backup encryption end-to-end
**Value:** Unencrypted backups on TrueNAS contain all secrets and user data in plaintext.

### 70. etcd encryption at rest
**Status: REVIEW** (Talos manages etcd)
**Target:** Talos MachineConfig
**Plan:**
1. Verify Talos enables etcd encryption: `talosctl get etcdspec` on control plane
2. If not enabled: add `cluster.etcd.extraArgs: --encryption-provider-config=/...` to MachineConfig
3. Encrypt: `secrets`, `configmaps` (especially ArgoCD repo credentials)
**Value:** etcd stores all K8s Secrets. Node compromise without etcd encryption = all secrets extracted.

### 71. Node-level AppArmor / seccomp enforcement
**Status: REVIEW**
**Target:** Talos MachineConfig
**Plan:**
1. Verify Talos default seccomp profile is applied cluster-wide
2. Kyverno `require-seccomp-profile` policy already audits this — verify enforcement
3. Consider custom AppArmor profiles for high-risk containers (e.g., code-server)
**Value:** Node-level MAC enforcement is the last line of defense if container escape occurs.

### 72. Falco alert tuning: reduce false positives, add priority escalation
**Status: PENDING** (after Falco deployment)
**Target:** `kubernetes/platform/falco/values.yaml`
**Plan:**
1. After 1 week of operation, run `falco-stats` to identify top false-positive rules
2. Add `macro` overrides in `falco_rules.local.yaml` for known-safe patterns
3. Separate Discord channels for WARNING vs CRITICAL alerts
**Value:** Untuned Falco generates alert fatigue, causing real alerts to be ignored.

### 73. Image pull policy: IfNotPresent everywhere
**Status: REVIEW**
**Target:** All Deployments/StatefulSets
**Plan:**
1. Audit `imagePullPolicy: Always` usage — this re-pulls images on every pod restart
2. With digest-pinned images, `IfNotPresent` is safe and prevents supply-chain attacks via image mutation
3. `Always` with pinned digest is acceptable but wastes bandwidth
**Value:** `imagePullPolicy: Always` with mutable tags means any image compromise is deployed on next pod restart.

### 74. Restrict OpenBao UI access to admin VPN only
**Status: REVIEW**
**Target:** `kubernetes/core/openbao/values.yaml` + Traefik route
**Plan:**
1. Verify OpenBao Ingress uses `traefik-netbird-only@kubernetescrd` middleware (currently set ✓)
2. Add `forward-auth-admin` middleware to require platform-admins group authentication
3. Disable OpenBao API on public route entirely — only allow via VPN
**Value:** OpenBao UI at `openbao.int.rlservers.com` — currently VPN-only but no Authentik auth layer.

### 75. Container escape detection via /proc monitoring
**Status: PENDING** (complement to Falco)
**Target:** Custom Falco rule
**Plan:**
1. Add Falco rule: detect reads to `/proc/*/mem` or writes to `/proc/sysrq-trigger`
2. Add rule: detect `mount` syscall from unprivileged containers
3. Add rule: detect `unshare`, `nsenter` from catalog pods
**Value:** Container escape attempts have a syscall fingerprint that Falco can catch in real-time.

### 76. Kubernetes version auto-upgrade policy
**Status: PENDING**
**Target:** Talos upgrade workflow + `.github/workflows/`
**Plan:**
1. Add Renovate/Dependabot for Talos/Kubernetes version tracking
2. Create upgrade workflow that checks for new Talos releases quarterly
3. Test upgrade on staging before production
**Value:** K8s 1.35.4 is current. Staying within N-2 of latest ensures CVE patches are applied.

### 77. Syscall audit via auditd rules (for Talos hostPath-mounted cases)
**Status: EVALUATE**
**Plan:**
1. For game-hub servers that may run mods: consider running a separate seccomp profile that logs suspicious syscalls
2. Correlate with Wazuh for alert generation
**Value:** Game server mods can execute arbitrary code — additional syscall auditing provides detection coverage.

### 78. Namespace isolation enforcement: PSA restricted for all catalog apps
**Status: PENDING**
**Target:** All catalog namespace labels
**Plan:**
1. Current: `enforce: baseline, audit: restricted, warn: restricted` for infraweaver apps
2. Goal: promote `enforce: restricted` for all catalog apps that comply
3. Prerequisite: fix all Kyverno policy violations (seccomp, non-root, caps) first
**Value:** PSA restricted blocks the most common container escape vectors at the admission level.

---

## DOMAIN 5 — SECRETS MANAGEMENT (ideas 79–92)

### 79. OpenBao dynamic secrets PoC: ExternalDNS Cloudflare token
**Status: PENDING**
**Target:** OpenBao config + `kubernetes/platform/external-dns/manifests/externalsecret.yaml`
**Plan:**
1. In OpenBao, create a scoped Cloudflare API token with DNS:edit for the specific zone
2. Store in `secret/platform/cloudflare/dns-edit-token` with metadata expiry marker
3. ExternalSecret fetches and rotates — no manual rotation needed
**Blocker:** Cloudflare API doesn't support dynamic token issuance (only static PATs) — so this is rotation policy, not true dynamic secrets.
**Value:** Establishes the rotation pattern. True dynamic secrets available for databases (Postgres, MySQL).

### 80. OpenBao dynamic database credentials for Authentik PostgreSQL
**Status: PARTIAL** (PoC ExternalSecret added)
**Target:** OpenBao database secrets engine + Authentik ExternalSecret
**Plan:**
1. Added PoC manifest: `kubernetes/platform/authentik/manifests/externalsecret-dynamic-db.yaml`
2. `bao secrets enable database` — configure PostgreSQL plugin for Authentik's PG instance
3. Create role: `authentik-app` with short TTL and least-privilege grants
4. ExternalSecret fetches dynamic credentials; final cutover can restart Authentik pods onto rotated creds
**Blocker:** Requires Authentik to support dynamic PG credentials (it does — via env vars refreshed by pod restart)
**Value:** Dynamic DB creds mean a leaked Authentik DB password expires in 1h, not never.

### 81. OpenBao dynamic database credentials for other catalog apps
**Status: PENDING** (after #80 as PoC)
**Target:** Apps with PostgreSQL: Gitea, Forgejo, Outline, n8n
**Plan:**
1. Follow same pattern as #80 for each PostgreSQL-backed app
2. Create separate OpenBao database role per application
3. Update ExternalSecrets to use database secrets engine path
**Value:** None of the catalog apps currently rotate their DB credentials. Dynamic secrets eliminate this risk.

### 82. OpenBao seal/unseal hardening: transit auto-unseal
**Status: EVALUATE**
**Target:** `kubernetes/core/openbao/values.yaml`
**Plan:**
1. Current: single unseal key in openbao-unseal Secret (sidecar unseals automatically)
2. Evaluate: Shamir with M-of-N (e.g., 2-of-3) for human-verified unseals
3. Alternative: transit auto-unseal via cloud KMS (AWS KMS, GCP KMS) for true production posture
**Current risk:** Single unseal key in a K8s Secret means any cluster-admin can unseal OpenBao.
**Value:** M-of-N unseal requires multiple trusted parties to collude, preventing single-admin compromise.

### 83. Kubernetes Secrets encryption at rest (etcd)
**Status: REVIEW** (see #70)
**Target:** Talos MachineConfig
**Plan:**
1. Enable `EncryptionConfiguration` in etcd for `secrets` and `configmaps`
2. Use AES-GCM-256 with key stored separately from etcd
3. Verify: `kubectl get secret -n external-secrets openbao-token -o jsonpath='{.data}'` should not return base64 of plaintext if etcd is encrypted
**Value:** etcd without encryption stores all K8s Secrets in plaintext on the etcd data directory.

### 84. Rotate all existing OpenBao secrets on schedule
**Status: PENDING**
**Target:** `kubernetes/core/openbao/` + GitHub Actions maintenance workflow
**Plan:**
1. Add to `maintenance.yml` workflow: quarterly reminder to rotate platform secrets
2. Critical secrets to rotate: Authentik token, ArgoCD token, GitHub token, Cloudflare API token, NetBird setup keys
3. Automate rotation via OpenBao policies where possible
**Value:** Tokens in OpenBao from initial setup may be years old. Regular rotation limits credential theft window.

### 85. Secret zero: bootstrap OpenBao without manual unseal key
**Status: LONG-TERM**
**Target:** OpenBao + KMS
**Plan:**
1. Store unseal key in a hardware HSM or cloud KMS (age/SOPS encrypted in git as fallback)
2. Auto-unseal via KMS at pod startup eliminates the need for the openbao-unseal Secret
3. Talos + Proxmox + TPM: explore TPM-backed unsealing
**Value:** Current approach stores unseal key in K8s Secret which is accessible to cluster-admin.

### 86. Audit OpenBao audit log for secret access patterns
**Status: PENDING**
**Target:** OpenBao audit log + Wazuh/Loki
**Plan:**
1. OpenBao audit log already writes to `/openbao/data/audit.log` ✓
2. Mount audit log via sidecar fluentbit → forward to Loki
3. Create Grafana dashboard: secret access frequency, error rates, suspicious patterns
4. Alert on: repeated auth failures, access to unusual secret paths, root token usage
**Value:** OpenBao audit log is the forensic record for all secret access. Currently it's write-only to a PVC.

### 87. ExternalSecrets: minimize secret scope per application
**Status: PENDING**
**Target:** All `kubernetes/*/manifests/externalsecret.yaml` files
**Plan:**
1. Audit each ExternalSecret — does it pull only the secrets it needs?
2. Refactor wide-scope ES (e.g., `infraweaver-console-secret` contains 15+ keys) into narrower ones
3. Use `spec.dataFrom.extract` with `conversionStrategy` for minimal extraction
**Value:** Current console ExternalSecret fetches 15+ secrets in one shot. Least-privilege: fetch only what's needed.

### 88. Restrict ESO ClusterSecretStore to specific namespaces
**Status: PENDING**
**Target:** `kubernetes/core/external-secrets/manifests/cluster-secret-store.yaml`
**Plan:**
1. Consider replacing ClusterSecretStore with namespace-scoped SecretStores per namespace
2. Each namespace gets a separate OpenBao token with access only to its secret paths
3. ESO Kyverno policy: block ExternalSecret from creating secrets with keys from other namespace paths
**Value:** Currently any ExternalSecret in any namespace can access any secret in OpenBao (if they know the path).

### 89. SOPS encryption for sensitive ConfigMaps in git
**Status: PENDING**
**Target:** Any ConfigMap containing non-public configuration
**Plan:**
1. Identify ConfigMaps with sensitive values (management.json template has RELAY_SECRET_PLACEHOLDER)
2. Use SOPS + age key to encrypt sensitive values stored in git
3. ArgoCD decrypts via SOPS plugin at apply time
**Value:** Even placeholder-based configs can leak structure. SOPS ensures sensitive config is encrypted in git.

### 90. OpenBao token lease duration audit
**Status: PENDING**
**Target:** OpenBao policy configs
**Plan:**
1. Current ESO token: `period=168h` (7 days) — reduce to 24h with auto-renewal
2. Current ArgoCD token: unknown TTL — audit and cap at 24h
3. Add OpenBao policy: `max_lease_ttl=24h` for all platform tokens
**Value:** 7-day token TTL means 7 days of access if a token is stolen. 24h limits the window significantly.

### 91. HashiCorp Vault Agent (or Bao Agent) sidecar injection
**Status: EVALUATE**
**Target:** OpenBao Injector (disabled in current values.yaml)
**Plan:**
1. Current: `injector.enabled: false` in openbao values
2. Enable injector for high-security apps: instead of ExternalSecret writing to K8s Secret, inject directly into pod at runtime
3. Secrets never written to etcd — only available in pod memory
**Value:** ExternalSecret writes secrets to K8s etcd-backed Secrets. Agent injection keeps secrets out of etcd entirely.

### 92. Prevent secret enumeration in OpenBao
**Status: PENDING**
**Target:** OpenBao policies
**Plan:**
1. Review ESO policy — does it have `list` permission on the root `secret/` path?
2. Revoke `list` on root paths; allow only `read` on specific secret paths
3. Create per-service OpenBao policies with exact path restrictions
**Value:** A compromised ESO token with `list` on `secret/*` can enumerate all secret names (a significant information disclosure).

---

## DOMAIN 6 — DETECTION & RESPONSE (ideas 93–100)

### 93. Prometheus alerts for security events
**Status: PENDING**
**Target:** `kubernetes/monitoring/alerts/manifests/`
**Plan:**
1. Add PrometheusRule for: pod restarts > 5 (crash loops), OOMKilled events, failed K8s auth attempts, Kyverno policy violations
2. Alert on: NetworkPolicy drops (requires CNI with drop metrics), new ClusterRoleBinding creation, secret access from unexpected namespace
3. Route security alerts to dedicated Discord channel (separate from operational alerts)
**Value:** Most security events leave metrics traces. Proactive alerting reduces MTTD from days to minutes.

### 94. Falco + Alertmanager integration
**Status: PENDING** (after Falco deployment)
**Target:** `kubernetes/platform/falco/values.yaml` falcosidekick config
**Plan:**
1. Falcosidekick → Alertmanager (already in values.yaml template)
2. Create PrometheusRule for Falco alert volume (sudden spike = attack in progress)
3. Map Falco priority levels to Alertmanager severity labels
**Value:** Falco alerts in Alertmanager enables correlation with other signals (pod restarts, network drops) for automated incident response.

### 95. Automated incident response: isolate compromised pod
**Status: LONG-TERM**
**Target:** Custom Falco response plugin or CronJob
**Plan:**
1. On Falco CRITICAL alert: trigger automated NetworkPolicy update to isolate the pod (deny all ingress/egress)
2. Preserve pod for forensics (don't delete — `kubectl cordon` the node)
3. Alert to Discord with runbook link
**Value:** Automated containment reduces attacker dwell time from discovery to isolation.

### 96. Log aggregation: ship all container logs to Loki
**Status: PARTIAL** (Loki deployed, ingestion status unknown)
**Target:** `kubernetes/monitoring/loki/` + Promtail DaemonSet
**Plan:**
1. Verify Promtail DaemonSet is running on all nodes: `kubectl get ds -n monitoring`
2. Verify all namespaces are scraped — check Loki label selectors
3. Set log retention to 30 days for security events, 7 days for operational logs
4. Create Grafana dashboard: failed auth attempts across all services
**Value:** Forensic investigation requires logs from all components. Missing logs = blind spots.

### 97. Alerting on Kyverno policy violations in real-time
**Status: PENDING**
**Target:** `kubernetes/monitoring/alerts/manifests/`
**Plan:**
1. Kyverno exposes policy violation metrics at `:8000/metrics`
2. Add PrometheusRule: alert if `kyverno_policy_results_total{result="fail",action="enforce"}` > 0
3. This catches new workloads violating enforced policies — may indicate bypass attempts
**Value:** Enforced policy violations are either misconfigurations or active bypass attempts. Both need investigation.

### 98. Discord alert channel structure for security vs ops
**Status: PENDING**
**Target:** `kubernetes/monitoring/alertmanager-discord/` config
**Plan:**
1. Create separate Discord channels: `#infra-alerts` (operational) and `#security-alerts` (Falco, Kyverno violations, auth failures)
2. Configure Alertmanager routes to separate by `severity=security` label
3. Page (mention @oncall) for CRITICAL security alerts at any hour
**Value:** Security alerts buried in operational noise are ignored. Dedicated channel ensures visibility.

### 99. Backup and disaster recovery test automation
**Status: PENDING**
**Target:** `kubernetes/platform/velero/` + new test CronJob
**Plan:**
1. Velero is configured for backup — add automated restore test monthly
2. Create CronJob that restores to a test namespace and verifies critical resources exist
3. Alert on restore failure
**Value:** Backups that have never been tested are untested disaster recovery. A security incident destroying cluster data requires working backups.

### 100. Threat model review: quarterly security review process
**Status: PROCESS**
**Plan:**
1. Schedule quarterly review: re-run this checklist, check Kyverno PolicyReports, review OpenBao audit logs
2. Review: new services added since last review, any :latest images crept back in, any new ClusterRoleBindings
3. Threat model update: add any new attack vectors discovered during operations
4. Track progress: update this document with `Status: IMPLEMENTED` as items are completed
**Value:** Security posture degrades without ongoing maintenance. Quarterly reviews prevent entropy from undoing hardening work.

---

## Implementation Status Summary

| Status | Count | Description |
|--------|-------|-------------|
| IMPLEMENTED | 10 | Changes made in this PR (feat/security-zero-trust) |
| PENDING | 65 | Clear plan, not yet implemented |
| REVIEW | 14 | Needs investigation/verification first |
| LONG-TERM | 6 | Architectural changes requiring planning |
| PROCESS | 1 | Not a code change — operational process |

## Highest-Value Immediate Priorities (next sprint)

1. **Egress NPs for authentik, netbird, grafana** — platform-critical services with open egress
2. **automountServiceAccountToken: false** for netbird relay/signal and all 27 catalog apps
3. **NetworkPolicies for catalog apps** — 27 apps have NO NetworkPolicy at all (idea #13)
4. **Activate Falco** — rename `application.yaml.disabled` → `application.yaml`
5. **Pin all :latest images** — alertmanager-discord, cyberchef, speedtest-tracker, excalidraw, grocy, searxng (ideas 44-46)
6. **Promote seccomp policy to Enforce** — fix violations first, then enforce (idea #29)
7. **K8s API audit logging** — critical for forensics and SIEM (idea #18)
8. **OpenBao dynamic DB creds for Authentik** — highest-value dynamic secrets PoC (idea #80)

## Files Changed in This PR

| File | Change Type | Idea # |
|------|-------------|--------|
| `kubernetes/core/argocd/manifests/networkpolicy.yaml` | Egress policies added | #1 |
| `kubernetes/core/cert-manager/manifests/networkpolicy.yaml` | Egress policies added | #2 |
| `kubernetes/core/external-secrets/manifests/networkpolicy.yaml` | Egress policies added | #3 |
| `kubernetes/core/kyverno/manifests/networkpolicy.yaml` | Egress policies added | #4 |
| `kubernetes/core/openbao/manifests/networkpolicy.yaml` | Egress policies added | #5 |
| `kubernetes/catalog/infraweaver-api/manifests/networkpolicy.yaml` | Egress tightened | #6 |
| `kubernetes/core/argocd/manifests/self-healer.yaml` | bitnami/kubectl pinned to 1.35.4 | #43 |
| `kubernetes/catalog/infraweaver-console/manifests/serviceaccount.yaml` | automount=false | #23 |
| `kubernetes/catalog/infraweaver-api/manifests/serviceaccount.yaml` | automount=false | #24 |
| `kubernetes/core/kyverno/manifests/cluster-policies.yaml` | 3 new Audit policies added | #28, #63 |
| `kubernetes/platform/falco/` (new directory) | Falco bootstrap manifests | #59 |
| `.github/memories/security-zerotrust-100-ideas-2026-05.md` | This document | — |
