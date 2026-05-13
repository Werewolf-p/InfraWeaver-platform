## Deployment Process

### CI/CD pipeline

1. A change is pushed to `main`.
2. GitHub Actions runs the console build workflow.
3. The workflow typically performs:
   - runner cleanup and disk recovery
   - `npm test` or the relevant validation steps
   - a multi-stage Docker build
   - image push to the One Dev registry
   - manifest update with the new image SHA
   - git push of the manifest change with retry logic
   - rollout or reconciliation trigger

### Image naming

The console image is versioned with the branch and commit SHA so a running pod can always be traced back to the exact source revision that produced it.

### ArgoCD GitOps

ArgoCD watches the console manifests directory. When the manifest changes, ArgoCD syncs the desired state back into the cluster.

This keeps the deployment model consistent with the rest of the platform:

- git is the desired state
- ArgoCD is the reconciler
- Kubernetes is the runtime

### Environment variables

Runtime secrets come from OpenBao through External Secrets. Common variables include:

- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `AUTHENTIK_*`
- `ARGOCD_TOKEN`
- `GITHUB_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `PROMETHEUS_URL`

## Adding a new environment variable

1. Add the key to OpenBao.
2. Update the ExternalSecret manifest.
3. Update the deployment environment section.
4. Consume the value in code through `process.env`.
5. Redeploy and verify that the pod sees the new value.

> **Note:** Keep environment-variable additions small and reviewable. If a feature needs several related settings, document them together in the wiki and in the manifest diff.

## Deployment validation checklist

After rollout, verify:

- the new image tag is present in the live Deployment
- the dashboard loads without session issues
- key API routes respond successfully
- ArgoCD is healthy and synced
- there are no crash loops or auth regressions in logs
