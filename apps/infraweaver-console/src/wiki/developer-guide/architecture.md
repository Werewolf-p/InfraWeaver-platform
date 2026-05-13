## System Overview

InfraWeaver Console is a Next.js application that acts as the management interface for a Kubernetes homelab cluster. It centralizes platform operations, game server management, DNS, RBAC, and GitOps-aware deployment tooling behind a single authenticated UI.

### Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15-style app router architecture, React 19, Tailwind v4 |
| Auth | NextAuth v5 + Authentik OIDC |
| Kubernetes | `@kubernetes/client-node` with in-cluster or kubeconfig access |
| Storage | Longhorn distributed block storage |
| Secrets | External Secrets Operator → OpenBao |
| GitOps | ArgoCD with automated sync and self-heal |
| CI/CD | GitHub Actions → self-hosted runner → One Dev registry |
| Ingress | Traefik v3 with IngressRoute CRDs |
| DNS | Cloudflare API surfaced through `/dns` |
| Monitoring | kube-prometheus-stack, Grafana, Loki, and uptime checks |

### Cluster Architecture

- 3 Talos Linux nodes (`talos-prod-cp1`, `talos-prod-cp2`, `talos-prod-cp3`)
- each node sized for mixed platform and game workloads
- Longhorn configured for replicated block storage
- MetalLB used for LoadBalancer IP assignment
- NetBird used for private access to internal `*.int.rlservers.com` endpoints

### High-level request flow

```text
Browser
  ↓
Traefik / Authentik
  ↓
InfraWeaver Console (Next.js)
  ├─ Kubernetes API
  ├─ ArgoCD API and git state
  ├─ Cloudflare DNS API
  ├─ Prometheus metrics API
  └─ GitHub repository contents API
```

### Security Model

- internal routes are expected to sit behind NetBird or authenticated ingress
- API routes start by verifying the session and then checking RBAC where appropriate
- secrets are loaded from the environment, not from git
- Kyverno and related cluster policy controls provide a second guardrail at the cluster layer

## Console Service Account

The console runs as the `infraweaver-console` ServiceAccount.

Typical capabilities include:

- cluster-wide read access for pods, deployments, services, and node metadata
- targeted write access for managed namespaces such as `game-hub`
- ArgoCD visibility and limited patch actions where rollout or sync helpers exist

## Application architecture inside the repo

The codebase is broadly split into:

- `src/app/` for Next.js routes and API handlers
- `src/components/` for feature and UI components
- `src/lib/` for RBAC, Kubernetes helpers, DNS clients, and domain logic
- `src/wiki/` for documentation content rendered by the wiki feature

## Why the console is built this way

InfraWeaver favors a practical hybrid architecture:

- **UI-first for operators** so common tasks are faster than raw kubectl
- **GitOps-aware** so durable platform changes still flow back into git
- **RBAC-scoped** so access can be delegated safely
- **cluster-native** so game servers and apps use the same primitives as the rest of the platform
