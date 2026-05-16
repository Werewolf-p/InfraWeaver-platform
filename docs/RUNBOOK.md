# InfraWeaver runbook

## Common developer commands

```bash
make dev            # start the local docker compose stack
make logs           # tail console, api, and mock logs
make status         # verify local services or fall back to cluster status
make deploy         # apply the namespace-scoped dev manifests
make build          # build app workspaces
make test           # existing live-cluster smoke suite
```

## Start the local stack

1. Copy the env template values you need from `.env.example`.
2. Run `bash scripts/dev-start.sh` or `make dev`.
3. Open `http://localhost:3000` for the console.
4. Check `http://localhost:3001/health` for the API.

## Generate the API contract

```bash
cd apps/infraweaver-api
npm run openapi:generate
```

This refreshes `apps/infraweaver-api/openapi.json` and keeps `/openapi.json` in sync with the route catalog.

## Scaffold a new console feature page

```bash
node scripts/scaffold-page.mjs my-feature --group=tools --icon=LayoutGrid --api --type=MyFeature
```

Generated assets include:

- a dashboard page under `apps/infraweaver-console/src/app/(dashboard)/`
- an optional Next.js API route under `apps/infraweaver-console/src/app/api/`
- unit test stubs under `apps/infraweaver-console/tests/unit/`
- an optional shared type stub under `apps/infraweaver-console/src/types/`

## Test safely in a development namespace

```bash
kubectl apply -k kubernetes/development/infraweaver-dev
kubectl config set-context --current --namespace=infraweaver-dev
```

The overlay creates a dedicated namespace, ResourceQuota, LimitRange, and default-deny NetworkPolicy so experiments stay isolated from production workloads.

## Roll out a change to the homelab

1. Open a pull request and wait for the PR validation workflow.
2. Merge into `main`.
3. Watch the service-specific build workflow in `.github/workflows/`.
4. Verify ArgoCD sync state and application health.

## Fast diagnostics

- Console health: `curl -fsS http://localhost:3000/api/health`
- API health: `curl -fsS http://localhost:3001/health`
- Mock service: `curl -fsS http://localhost:4010/health.json`
- Dev namespace quota: `kubectl -n infraweaver-dev describe resourcequota`
