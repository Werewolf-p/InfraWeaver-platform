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

1. Apply your change locally and commit it.
2. Push it to your local Onedev repository.
3. Confirm ArgoCD detects the diff and starts reconciling.
4. Verify ArgoCD sync state and application health.

## Fast diagnostics

- Console health: `curl -fsS http://localhost:3000/api/health`
- API health: `curl -fsS http://localhost:3001/health`
- Mock service: `curl -fsS http://localhost:4010/health.json`
- Dev namespace quota: `kubectl -n infraweaver-dev describe resourcequota`

## etcd maintenance on Talos

The in-cluster maintenance manifest at `kubernetes/core/etcd-maintenance/defrag-job.yaml` does **not** defrag etcd directly. It runs weekly on Sunday at 02:00 UTC and logs apiserver-exposed `etcd_*` metrics so operators can spot fragmentation or backend growth without needing Talos credentials inside the cluster.

### Check the weekly metrics job

```bash
kubectl -n kube-system get cronjob etcd-metrics-logger
kubectl -n kube-system logs job/$(kubectl -n kube-system get jobs --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}')
```

### Manual etcd defrag on Talos control planes

Use Talos directly for defrag operations because etcd client certificates stay inside Talos-managed machine config and are not exposed to regular Kubernetes pods.

```bash
export TALOSCONFIG=envs/productie/generated/talosconfig
for NODE in 10.10.0.90 10.10.0.91 10.10.0.92; do
  talosctl --nodes "$NODE" etcd status
  talosctl --nodes "$NODE" etcd defrag
  talosctl --nodes "$NODE" etcd status
done
```

Recommended workflow:

1. Run `talosctl --nodes <node> etcd status` on every control-plane node and note the backend size.
2. Defrag one node at a time during a quiet maintenance window.
3. Re-run `etcd status` and confirm backend size shrinks and leadership remains stable.
4. If you prefer automation, schedule the same Talos commands from your local Onedev instance or another homelab scheduler.
