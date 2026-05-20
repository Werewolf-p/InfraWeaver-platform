# InfraWeaver troubleshooting

## Console build fails locally with a Node version error

**Symptom:** `next build` reports that Node is too old.

**Fix:** use Node 20+ for `apps/infraweaver-console`. The CI workflows already pin Node 20, and `docker-compose.yml` uses a Node 20 image for the console service.

## `make dev` starts but the console cannot reach the API

**Checks:**

1. Run `bash scripts/health-check.sh`.
2. Confirm the API is healthy at `http://localhost:3001/health`.
3. Confirm `INFRAWEAVER_API_URL=http://api:3001` in `docker-compose.yml` or your local environment.

## Docker compose starts slowly on first boot

The initial run installs dependencies inside the console and API containers. Subsequent runs reuse named `node_modules` volumes and become much faster.

## OpenAPI file is stale

Run:

```bash
cd apps/infraweaver-api
npm run openapi:generate
```

Commit the updated `openapi.json` whenever route shapes or descriptions change.

## Pre-commit hooks fail on app files

- Run `pre-commit install` once.
- Ensure dependencies are installed in the affected workspace.
- Re-run the hook set with `pre-commit run --all-files` to reproduce locally.

## Dev namespace tests affect the wrong cluster

Before applying the overlay, verify your active context:

```bash
kubectl config current-context
kubectl config view --minify
```

Then apply `kubernetes/development/infraweaver-dev` only to the intended non-production cluster.

## Health check script reports a failure for the mock service

Ensure the mock container is running and that port `4010` is free:

```bash
docker compose ps
curl -fsS http://localhost:4010/health.json
```

## PR validation is red only for coverage

The coverage workflow enforces a 60% floor for the console test suite. Add or update Jest coverage around the changed module, then run:

```bash
cd apps/infraweaver-console
npm run test:coverage -- --runInBand
```
