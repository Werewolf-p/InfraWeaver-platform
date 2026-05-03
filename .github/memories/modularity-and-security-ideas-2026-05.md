---
title: Modularity & Security Improvement Ideas — May 2026
description: Large research-backed list of ideas for making InfraWeaver more modular, easy to build on, and more secure. Sourced from 10+ references.
---

# Modularity & Security Improvement Ideas

**Research Sources:**
1. HashiCorp/OpenTofu Official Module Structure Docs — https://developer.hashicorp.com/terraform/language/modules
2. Gruntwork Terragrunt DRY Patterns — https://terragrunt.gruntwork.io/docs/
3. CNCF GitOps Security Whitepaper — https://github.com/cncf/tag-security
4. CIS Kubernetes Benchmark v1.9 — https://www.cisecurity.org/benchmark/kubernetes
5. SLSA / Sigstore Supply Chain Levels — https://slsa.dev / https://docs.sigstore.dev
6. ArgoCD ApplicationSet Documentation — https://argo-cd.readthedocs.io
7. Backstage / Platform Engineering Patterns — https://backstage.io
8. OWASP IaC Security Checklist — https://owasp.org/www-project-devsecops-guideline/
9. External Secrets Operator Best Practices — https://external-secrets.io/
10. kube-bench / Kubescape CIS scan docs — https://github.com/aquasecurity/kube-bench

---

## PART 1: MODULARITY & DEVELOPER EXPERIENCE

### A. Terraform / OpenTofu Module Architecture

**A1. Extract env-agnostic modules to a separate `terraform/modules/` registry**
- Current: modules exist under `terraform/modules/` but aren't versioned
- Idea: tag each module with semantic versions (`v1.0.0`) and reference by git tag
  ```hcl
  module "talos_cluster" {
    source = "git::https://github.com/your-org/infraweaver-platform//terraform/modules/talos-cluster?ref=v1.2.0"
  }
  ```
- Why: consumer of the platform can pin a stable version; upgrades are explicit

**A2. Enforce module interface contracts (variables.tf + outputs.tf in each module)**
- Every module MUST have `variables.tf` with `description` and `type` on each var
- Every module MUST have `outputs.tf` exposing its key values (IPs, names, kubeconfig paths)
- Add `terraform-docs` to CI to auto-generate module READMEs
  ```yaml
  - name: Generate module docs
    run: terraform-docs markdown table --output-file README.md terraform/modules/talos-cluster/
  ```

**A3. Add `examples/` directory per module**
- Each module should have `terraform/modules/<name>/examples/basic/main.tf`
- Shows minimum viable usage — helps someone cloning the repo understand fast

**A4. Remote state backend (currently blocked)**
- Move from local `.tfstate` to Minio S3 backend for team collaboration
- Encrypt state at rest, restrict access with Minio IAM policies
- Once done: any runner (local or CI) works against the same state

**A5. Environment-as-directory pattern**
- Already have `envs/productie/` — extend to `envs/staging/`, `envs/dev/`
- Each env has its own `terraform.tfvars` + `cluster.yaml`
- Modules are shared; only values change per env
- Add `envs/productie/README.md` documenting the env-specific overrides

**A6. Terragrunt for DRY root config (optional advanced)**
- Replace repetitive `provider` and `backend` blocks across envs with `terragrunt.hcl`
- `generate "backend"` + `generate "providers"` blocks avoid copy-paste

**A7. Module output chaining (already partially done)**
- Explicitly chain: `module.talos_cluster.kubeconfig_path` → used by `module.platform_bootstrap`
- Document the dependency graph in a `ARCHITECTURE.md`

---

### B. Kubernetes / ArgoCD / Helm Modularity

**B1. Helm chart library (common chart)**
- Extract repeated patterns (standard `Ingress` + `IngressRoute`, `ExternalSecret`, `NetworkPolicy`) into a library chart
- Other apps source from the library: `dependencies: [ name: platform-lib, version: 1.0.0 ]`
- Reduces 50+ lines of boilerplate per new app to ~10

**B2. ArgoCD AppProject per tier**
- Create `AppProject` CRDs: `core-project`, `apps-project`, `monitoring-project`
- Each project restricts source repos, destination namespaces, allowed resources
- Prevents an `apps-tier` app from accidentally touching `core-tier` namespaces

**B3. ApplicationSet matrix generator (advanced)**
- Current: single git-directory generator
- Idea: matrix generator = (apps × environments) if you ever add staging
  ```yaml
  generators:
    - matrix:
        generators:
          - git: { directories: [...] }
          - list:
              elements:
                - env: productie
  ```

**B4. Helm values overlays per environment**
- Use `valuesObject` or multiple `valueFiles` in ArgoCD Application:
  ```yaml
  source:
    helm:
      valueFiles:
        - values.yaml
        - values-productie.yaml   # env-specific overrides only
  ```
- The base `values.yaml` stays clean; env differences are minimal overlay files

**B5. Standard app scaffold script**
- Add a `scripts/new-app.sh <name> <tier>` that creates:
  - `kubernetes/<tier>/<name>/application.yaml` (from template)
  - `kubernetes/<tier>/<name>/values.yaml` (skeleton)
  - `kubernetes/<tier>/<name>/manifests/.gitkeep`
- New app is ready for ArgoCD auto-discovery in <30 seconds

**B6. Namespace management as code**
- Declare all namespaces in `kubernetes/bootstrap/namespaces.yaml`
- ArgoCD `CreateNamespace=true` is a fallback — explicit namespace resources are cleaner

**B7. Resource quota + LimitRange per namespace**
- Add `ResourceQuota` and `LimitRange` to each app namespace
- Prevents a runaway pod from consuming all cluster CPU/memory
- Especially important if adding user-facing apps

---

### C. GitHub Actions Workflow Modularity

**C1. Composite actions for repeated steps**
- Extract repeated steps (setup kubectl, get kubeconfig, wait for ArgoCD sync) into `.github/actions/<name>/action.yml`
- Already have a memory for this pattern (`workflow-composite-actions.md`)
- Example: `.github/actions/setup-cluster-tools/action.yml`

**C2. Reusable workflows (workflow_call)**
- Extract the "wait for ArgoCD app healthy" logic into a reusable workflow
  ```yaml
  # .github/workflows/wait-argocd.yml
  on:
    workflow_call:
      inputs:
        app_name: { type: string }
  ```
- Called from any workflow: `uses: ./.github/workflows/wait-argocd.yml`

**C3. Workflow inputs as configuration (not hardcoded)**
- Replace all hardcoded app names (e.g., `"apps-authentik-manifests"`) with workflow inputs or `env:` vars at top of file
- Makes grep-and-replace across workflows unnecessary when naming changes

**C4. Matrix builds for multi-node or multi-env operations**
- Use `strategy.matrix` for steps that run against all cluster nodes
- Example: talos upgrade matrix over `[cp1, cp2, cp3, worker1]`

**C5. Job summaries ($GITHUB_STEP_SUMMARY)**
- Add markdown summaries to long-running jobs (deploy, health check)
- Shows structured pass/fail per service in the GitHub Actions UI
  ```bash
  echo "| Service | Status |" >> $GITHUB_STEP_SUMMARY
  echo "| Traefik | ✅ |" >> $GITHUB_STEP_SUMMARY
  ```

---

### D. Onboarding / Clone Experience

**D1. `.env.example` for local development**
- Create `.env.example` at repo root with ALL required GitHub secrets as placeholders
- Document what each var means and where to get it
- New contributor: `cp .env.example .env` → fill in values → use `scripts/bootstrap-local.sh`

**D2. Local bootstrap script**
- `scripts/bootstrap-local.sh`: checks prerequisites (tofu, kubectl, talosctl, sops, age)
- Validates `.env` has all required vars populated
- Runs `tofu init` and `tofu validate` to confirm local setup works
- Checks `gh auth status` for GitHub CLI auth

**D3. GitHub Secrets vs `.env` approach — hybrid recommendation**
- **For CI/CD pipelines:** keep GitHub Secrets (they're injected automatically)
- **For local development:** use `.env` + `direnv` to load vars into shell
- **Bridge:** `scripts/push-secrets-to-github.sh` reads `.env` and uses `gh secret set` to sync them to GitHub Secrets
  ```bash
  while IFS='=' read -r key value; do
    gh secret set "$key" --body "$value" --repo "$REPO"
  done < .env
  ```
- This means you maintain ONE `.env` locally; CI secrets stay in sync

**D4. Onboarding checklist in CONTRIBUTING.md**
- Prerequisite tool versions (tofu 1.11+, talosctl 1.9+, kubectl 1.32+)
- One-time setup steps (age key, SOPS config, GitHub runner registration)
- First-day commands: init → validate → plan (dry-run)
- Link to architecture diagram

**D5. Architecture diagram as code (Mermaid)**
- Add a Mermaid diagram to README.md showing:
  - Proxmox → Talos nodes → Kubernetes → ArgoCD → apps
  - Traffic flow: user → Cloudflare → Traefik → service
  - Secrets flow: OpenBao → ESO → K8s Secret → Pod
- Rendered automatically by GitHub in the README

**D6. `make` targets for common operations**
- `Makefile` with targets: `make init`, `make plan`, `make apply`, `make new-app`, `make new-user`
- Reduces "how do I run X" questions to zero
- Example:
  ```makefile
  new-user:
    @echo "Edit users.yaml, then run: git add -A && git commit -m 'feat: add user' && git push"
  ```

**D7. Dev container / GitHub Codespaces support**
- `.devcontainer/devcontainer.json` with all tools pre-installed
- Anyone with VS Code or GitHub Codespaces gets a ready-to-go dev environment
- No "it works on my machine" for tofu version mismatches

**D8. Automated CHANGELOG generation**
- Use `git-cliff` or `conventional-changelog` to auto-generate CHANGELOG.md on push to main
- Tags releases automatically based on conventional commit prefixes (`feat:`, `fix:`, `chore:`)

---

### E. Code Quality & Maintainability

**E1. terraform-docs in CI (auto-generate variable docs)**
- Run `terraform-docs` on every PR that touches `terraform/modules/`
- Commit generated README back, or fail the PR if docs are out of date

**E2. Helm chart linting in CI**
- Add `helm lint kubernetes/core/<app>/` to security-scan or a separate lint job

**E3. YAML comments explaining WHY not WHAT**
- Policy: every non-obvious YAML setting must have a `#` comment explaining the reasoning
- E.g., `prune: false  # prune:true caused accidental deletion during ApplicationSet regeneration`

**E4. Consistent label taxonomy**
- Standardize on labels: `app.kubernetes.io/name`, `app.kubernetes.io/component`, `app.kubernetes.io/part-of`
- Add a label enforcement Kyverno policy to require these on all Deployments

**E5. Dependency graph documentation**
- `ARCHITECTURE.md` listing startup order dependencies:
  - OpenBao must be ready before ESO can sync
  - ESO must sync secrets before Authentik can start
  - cert-manager must issue certs before Traefik can serve HTTPS
- Include health-check ordering in `test-post-deploy.sh`

---

## PART 2: SECURITY

**Sources:** OWASP IaC Checklist, CIS Kubernetes Benchmark v1.9, CNCF GitOps Security, SLSA framework, Aqua Security blog, NSA/CISA K8s Hardening Guide, Snyk IaC security practices

---

### F. Secrets & Credentials

**F1. Zero long-lived static credentials (short-lived tokens)**
- Replace static GitHub PAT with GitHub App installation token (expires hourly)
- Replace long-lived OpenBao root token with ESO AppRole with TTL-limited tokens
- Use OIDC workload identity for cloud providers instead of static API keys

**F2. Secret rotation automation**
- Add a `secrets-rotate.yml` workflow (manual trigger)
- Rotates: Authentik secret key, Authentik bootstrap token, NetBird setup keys
- Posts summary of what was rotated to GitHub step summary

**F3. SOPS for all secrets in Git**
- Encrypt any YAML that contains sensitive values before committing
- Add a `sops-check` CI step that fails if any `.sops.yaml`-matching file is unencrypted
- Currently SOPS is set up — enforce it with pre-commit hook

**F4. Sealed Secrets as alternative to SOPS**
- Consider Bitnami Sealed Secrets for K8s-native secret encryption
- Tradeoff: SOPS needs age key; Sealed Secrets needs cluster access to decrypt
- SOPS is better for this homelab (age key is portable)

**F5. OpenBao policies as code**
- Define all OpenBao policies in `kubernetes/core/openbao/manifests/policies/`
- Apply via `kubectl exec bao policy write <name> <file>` in a post-deploy script
- Currently policies are applied manually — make them reproducible

**F6. Audit all secret access (already started with audit log)**
- Parse OpenBao audit log for anomalies in a weekly cron job
- Alert if: new root token generated, policy deleted, secret path accessed from unexpected ServiceAccount

---

### G. Network Security

**G1. Default-deny NetworkPolicies for ALL namespaces**
- Currently only `traefik` and `openbao` namespaces have NetworkPolicies
- Add default-deny to: `authentik`, `cert-manager`, `monitoring`, `longhorn-system`
- Then add explicit allow rules per communication path

**G2. Egress restrictions**
- Add egress NetworkPolicies: pods should only egress to known endpoints
- E.g., cert-manager only needs to reach ACME servers and K8s API
- Prevents pod compromise from beaconing to C2 servers

**G3. mTLS between services (service mesh)**
- Consider adding Cilium or Linkerd for mTLS between all pods
- All pod-to-pod traffic encrypted in transit
- Tradeoff: adds complexity; evaluate after basic NetworkPolicies are solid

**G4. Ingress IP allowlisting via Traefik middleware**
- For internal-only services: add `ipWhiteList` middleware restricting to NetBird subnet (100.64.x.x/10)
- For admin services (ArgoCD, Grafana): also restrict to NetBird IP range

**G5. Rate limiting on public endpoints**
- Add Traefik `RateLimit` middleware to all public-facing IngressRoutes
- Prevents brute-force on Authentik login
- Current rate: 100 req/min per IP is reasonable starting point

**G6. TLS minimum version enforcement**
- Traefik TLS options: set `minVersion: VersionTLS12`, disable TLS 1.0/1.1
- Already likely default but make it explicit in `traefik/values.yaml`

---

### H. Kubernetes Hardening (CIS Benchmark)

**H1. Run kube-bench in CI**
- Add `kube-bench` scan to a weekly scheduled workflow
- Reports CIS Kubernetes Benchmark compliance score
- Fail on Level 1 critical failures; warn on Level 2

**H2. Pod Security Standards (replace deprecated PSPs)**
- Apply `Pod Security Admission` labels to all namespaces:
  ```yaml
  pod-security.kubernetes.io/enforce: restricted
  pod-security.kubernetes.io/warn: restricted
  ```
- Start with `warn` mode to catch violations before enforcing

**H3. Security contexts on all pods**
- All pods MUST have:
  ```yaml
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    readOnlyRootFilesystem: true
    allowPrivilegeEscalation: false
    capabilities:
      drop: [ALL]
  ```
- Enforce via Kyverno ClusterPolicy

**H4. Kyverno admission policies (policy as code)**
- Install Kyverno + deploy ClusterPolicies:
  - Require `securityContext.runAsNonRoot: true`
  - Disallow `hostNetwork: true` and `hostPID: true`
  - Require all images to be from allowed registries only
  - Require resource requests/limits on all containers
  - Require labels (`app.kubernetes.io/name`)

**H5. RBAC audit**
- Add `kubectl auth can-i --list` checks to post-deploy tests
- Ensure no ServiceAccount has `cluster-admin`
- Use `rbac-tool` or `kubescape` to scan for over-privileged roles

**H6. Disable unused API groups**
- Talos control plane: audit which API groups are enabled
- Disable `PodSecurityPolicy` (deprecated), enable `NodeRestriction` admission plugin

**H7. etcd encryption at rest**
- Enable etcd encryption for Kubernetes Secrets using `EncryptionConfiguration`
- Talos supports this via machine config: `cluster.etcd.encryptionConfig`
- Particularly important if etcd backups are stored off-cluster

---

### I. Supply Chain Security

**I1. Pin ALL GitHub Actions to SHA digests (not tags)**
- Move from `actions/checkout@v4` to `actions/checkout@<sha>`
- Use Dependabot to keep SHAs updated
- Provides immutable action references (tags can be moved)

**I2. Container image signing with Cosign**
- Any custom images built in the repo should be signed with Cosign keyless (OIDC)
- Add policy in Kyverno or OPA to verify image signatures before admission

**I3. SBOM generation**
- Generate Software Bill of Materials for custom images using `syft`
- Attach SBOM as OCI artifact to image
- Required for SLSA Level 2+

**I4. Trivy in PR checks (not just scheduled)**
- Currently trivy runs in security-scan.yml (triggered on push)
- Also add to PR checks so new image versions are scanned before merge

**I5. Dependabot security PRs auto-merge (minor patches only)**
- Configure Dependabot to auto-merge patch-level GitHub Actions updates
- Major version bumps require manual review
  ```yaml
  # .github/dependabot.yml
  automerged-updates:
    - match:
        dependency-type: "production"
        update-type: "semver:patch"
  ```

**I6. Provenance attestation for workflows**
- Use `slsa-github-generator` to attach SLSA provenance to GitHub releases
- Free, keyless, stored in Rekor transparency log

---

### J. Access Control & Zero Trust

**J1. Authentik MFA enforcement policy**
- Add Authentik policy requiring TOTP/WebAuthn for all admin-group users
- Currently MFA may be optional — make it required for `admin` group

**J2. Session timeout policies**
- Authentik: reduce token lifetime for sensitive apps (ArgoCD, Grafana, OpenBao UI)
- Short sessions reduce blast radius of stolen tokens
- Recommended: 8h max session for admin apps

**J3. NetBird network segmentation policies**
- Add explicit NetBird ACL policies per user group:
  - `admin` group: access all peers
  - `standard` group: access only web-tier services (HomepageDashboard port 8080)
  - `readonly` group: access monitoring dashboards only
- Currently this is partially done in users.yaml — make NetBird policies the enforcement layer

**J4. Break-glass account**
- Create a separate `breakglass` admin account in Authentik with a very long random password
- Store password encrypted in SOPS file in repo
- Account is disabled by default; enable only for emergency recovery

**J5. Audit log aggregation**
- Ship OpenBao audit log + K8s audit log to a persistent log store (Loki or S3)
- Set retention policy: 90 days minimum for compliance
- Alert on: failed login attempts, privilege escalation, secret deletion

**J6. Regular access reviews**
- Add a quarterly `access-review.yml` workflow that:
  - Lists all Authentik users and their groups
  - Lists all K8s ServiceAccounts and their RBAC bindings
  - Posts summary as GitHub issue for manual review

---

### K. Operational Security

**K1. Node OS hardening**
- Talos is already minimal/immutable — validate CIS benchmarks apply
- Disable unused extensions in Talos machine config
- Ensure kernel parameters match CIS recommendations

**K2. Signed commits enforcement**
- Require all commits to be GPG/SSH signed
- Enforce via GitHub branch protection: "Require signed commits"
- Prevents impersonation in the git log

**K3. Branch protection rules**
- `main` branch: require PR review + status checks passing before merge
- Prevent force-push to `main`
- Require linear history (no merge commits)

**K4. Secret scanning in GitHub**
- Enable GitHub Advanced Security secret scanning on the repo (free for public, paid for private)
- Custom patterns for: OpenBao tokens, Cloudflare API keys, Proxmox API tokens

**K5. Incident response runbook**
- Document in `.github/runbooks/incident-response.md`:
  - How to rotate all secrets (step-by-step)
  - How to revoke all active sessions in Authentik
  - How to isolate a compromised node from the cluster
  - Emergency contacts and recovery procedures

**K6. Terraform plan review gate**
- Add GitHub Environment `productie` with required reviewer
- `platform.yml` apply job targets `environment: productie`
- This means every `tofu apply` requires a human approval in GitHub UI
- Prevents accidental infra changes from a pushed typo

---

## QUICK WINS (implement in <1 day each)

| # | Item | Category | Impact |
|---|------|----------|--------|
| 1 | `.env.example` file | DX | High |
| 2 | `scripts/bootstrap-local.sh` | DX | High |
| 3 | `make` targets | DX | Medium |
| 4 | `$GITHUB_STEP_SUMMARY` in deploy jobs | DX | Medium |
| 5 | Default-deny NetworkPolicies for all namespaces | Security | High |
| 6 | Pod security contexts on all pods | Security | High |
| 7 | GitHub Environment `productie` with reviewer | Security | High |
| 8 | Require signed commits on `main` | Security | Medium |
| 9 | TLS min version explicit in Traefik | Security | Low |
| 10 | Rate limiting on public Authentik endpoint | Security | High |
| 11 | Mermaid architecture diagram in README | DX | Medium |
| 12 | `new-app.sh` scaffold script | DX | High |
| 13 | Trivy on PRs (not just push) | Security | Medium |
| 14 | Helm lint in CI | Quality | Low |
| 15 | MFA enforcement for admin group in Authentik | Security | High |

