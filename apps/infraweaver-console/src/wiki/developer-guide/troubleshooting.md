## Common Issues

### Console not updating after deployment

**Symptom:** UI shows old features even though the build succeeded.  
**Cause:** ArgoCD did not reconcile the new manifest or the manifest update never landed in git.  
**Fix:**

- check ArgoCD application status
- inspect GitHub Actions logs for the manifest update step
- confirm the Deployment image tag changed
- force a hard refresh on the ArgoCD application if needed

### Game server `CrashLoopBackOff`

**Symptom:** the server pod keeps restarting.  
**Likely causes:** invalid environment variables, broken world data, a bad image, or a probe mismatch.  
**Fix:**

- inspect pod events and logs
- verify the selected egg matches the game image
- confirm liveness and readiness behavior is appropriate for the workload
- test the mounted data path for corrupt or missing files

### Everything goes offline after deploying a large game server

**Cause:** node memory pressure cascaded into an OOM event that affected platform-critical services.  
**Fix:**

- inspect node memory graphs immediately
- confirm priority classes are behaving as expected
- reduce game server requests or move the workload window
- check namespace quotas and worst-node projections before retrying

### DNS changes do not appear to work

**Cause:** the wrong zone was chosen, the target is stale, or the consuming service is unhealthy.  
**Fix:**

- verify whether the record was created as internal or public
- confirm the value matches the current endpoint
- validate the service behind the hostname, not only the record itself

### Prometheus charts are empty

**Cause:** the metrics target changed, the pod is too new, or Prometheus is unavailable.  
**Fix:**

- confirm the pod name and namespace are correct
- verify `PROMETHEUS_URL`
- query Prometheus directly for the target labels

### `bitnami/kubectl` image tag problems

Some utility images only publish `latest` on Docker Hub. If a workflow or CronJob references a non-existent minor tag, the pod will fail with `ImagePullBackOff`.

> **Note:** Keep operational helper images conservative and verify available tags before pinning them.
