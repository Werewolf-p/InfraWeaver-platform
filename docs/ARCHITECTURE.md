# InfraWeaver architecture

## System overview

InfraWeaver is split into three developer-facing services and one GitOps delivery layer:

- **`apps/infraweaver-console/`** — Next.js console for operators and homelab users.
- **`apps/infraweaver-api/`** — Hono-based API that talks to Kubernetes, ArgoCD, Longhorn, and connected node agents.
- **`apps/infraweaver-node/`** — cluster-side agent that opens a secure connection back to the hub API.
- **`kubernetes/`** — ArgoCD-managed manifests for platform, applications, and supporting services.

```mermaid
flowchart LR
    Browser[Developer browser]\nlocalhost:3000 --> Console[InfraWeaver Console\nNext.js 15]
    Console -->|server-side fetch| API[InfraWeaver API\nHono + TypeScript]
    API --> K8s[Kubernetes API]
    API --> Argo[ArgoCD API / CRDs]
    API --> Longhorn[Longhorn CRDs]
    API --> Agents[InfraWeaver Node agents]
    Agents --> API
    Git[GitHub template repository] --> Onedev[Local Onedev]
    Onedev --> Argo
    Argo --> K8s
```

## Request flow

1. A developer opens the console locally or through the cluster ingress.
2. The console calls internal Next.js API routes and the InfraWeaver API.
3. The API authenticates the request, applies RBAC and mode guards, then queries cluster systems.
4. For remote-cluster operations, the API can coordinate with connected node agents over WebSockets.
5. ArgoCD continuously reconciles the manifests under `kubernetes/` into the live cluster.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/infraweaver-console/src/app` | App Router pages and API routes |
| `apps/infraweaver-console/src/components` | Shared console UI |
| `apps/infraweaver-console/tests` | Jest and Playwright tests |
| `apps/infraweaver-api/src/routes` | API route modules |
| `apps/infraweaver-api/src/lib` | Kubernetes, auth, mode, and agent helpers |
| `apps/infraweaver-node/src` | agent runtime, registration, command handling |
| `kubernetes/` | ArgoCD applications and manifests |
| `scripts/` | local setup, deployment, validation, and bootstrap tooling |
| `.github/optional/` | optional GitHub integration helpers not needed for local deployment |

## Local development architecture

For fast local iteration, use the repo-level developer stack:

- `docker-compose.yml` runs the console, API, and a lightweight mock endpoint.
- `scripts/dev-start.sh` boots the stack and prints the next steps.
- `scripts/health-check.sh` verifies the local ports and health endpoints.
- `kubernetes/development/infraweaver-dev/` provides a safe namespace-scoped overlay for cluster-side testing.

## Delivery model

- **GitHub** hosts the public template used for the initial clone.
- **Local deploys** run from the init website or `scripts/deploy-local.sh`.
- **ArgoCD** remains the source of truth for Kubernetes workloads after Onedev becomes the local git/CI server.
- **OpenAPI generation** in `apps/infraweaver-api` gives the console and contributors a stable contract for backend routes.
