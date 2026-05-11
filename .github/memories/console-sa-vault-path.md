# Console Service Account – Vault Path Reference

## Service Account

| Field       | Value                        |
|-------------|------------------------------|
| Name        | `infraweaver-console-sa`     |
| Namespace   | `infraweaver-console`        |
| Token Secret| `infraweaver-console-sa-token` |

## RBAC

- **ClusterRole**: `infraweaver-console-reader`
- Read access: pods, services, nodes, namespaces, events, configmaps, persistentvolumeclaims, ingresses, deployments, statefulsets, replicasets
- Limited write: `create`/`delete` pods (pod restart), `patch` deployments (scale/rollout)

## Vault / OpenBao Path

```
secret/infraweaver/console-sa
```

Keys stored:
- `token` – the long-lived SA token (base64-decoded)
- `server` – `https://kubernetes.default.svc`
- `namespace` – `infraweaver-console`

The token is pushed to Vault by the `PushSecret` resource (`infraweaver-console-sa-vault-push`) in the `infraweaver-console` namespace.

## Retrieve token for testing

```bash
# From Kubernetes secret directly
kubectl get secret infraweaver-console-sa-token -n infraweaver-console \
  -o jsonpath='{.data.token}' | base64 -d

# From OpenBao/Vault (via kubectl exec)
kubectl exec -it openbao-0 -n openbao -- \
  vault kv get -field=token secret/infraweaver/console-sa
```

## Self-test endpoint

```
GET /api/self-test
```

Requires a valid session. Reads the token from `CONSOLE_SA_TOKEN` env var or the
in-cluster service account mount at `/var/run/secrets/kubernetes.io/serviceaccount/token`.

Returns:
```json
{ "healthy": true, "podCount": 42, "appCount": 15, "nodeCount": 3, "testedAt": "..." }
```
