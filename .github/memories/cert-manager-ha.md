---
title: cert-manager HA — High-Availability Configuration (No Worker Nodes)
description: cert-manager HA setup for a control-plane-only cluster with Longhorn storage.
---

# cert-manager HA

## Configuration

cert-manager runs with 2 replicas for hot standby (leader election — only one acts at a time).

```yaml
# kubernetes/core/cert-manager/values.yaml
replicaCount: 2
webhook:
  replicaCount: 2
cainjector:
  replicaCount: 2
```

All three components (controller, webhook, cainjector) have tolerations for control-plane nodes
since the cluster has no dedicated worker nodes:

```yaml
tolerations:
  - key: node-role.kubernetes.io/control-plane
    operator: Exists
    effect: NoSchedule
```

---

## Storage

cert-manager does **NOT** use PVCs. TLS certificates and keys are stored as Kubernetes Secrets
in etcd, which is already HA with the 3-node control-plane cluster.

No Longhorn volumes needed for cert-manager itself.

---

## HA Model

- **Leader election**: only one controller replica acts at a time; the second is hot standby
- **Failover**: if the leader pod goes down, the standby takes over in seconds
- **etcd HA**: cert secrets survive as long as ≥2/3 etcd members are healthy
- **1 node can fail** without any certificate operations being disrupted

---

## Let's Encrypt Rate Limits

**CRITICAL: Max 5 certs per registered domain (rlservers.com) per week.**

- Do NOT trigger full redeployments unnecessarily — each redeploy issues new certs
- Staging issuer (`letsencrypt-staging`) is unlimited — use for testing
- Production certs are only reissued when they expire (90 days) or are explicitly renewed
- ArgoCD manages cert-manager via Helm — updates to `values.yaml` apply without cert reissuance

---

## Issuers

```
letsencrypt-prod     → production certs (rate-limited)
letsencrypt-staging  → staging certs (unlimited, untrusted)
```

DNS-01 challenge via Cloudflare (token stored in `cloudflare-api-token` secret in cert-manager namespace).

---

## Related Files

- `kubernetes/core/cert-manager/values.yaml` — HA replica counts + tolerations
- `kubernetes/core/cert-manager/issuers/` — ClusterIssuer definitions
- `.github/memories/letsencrypt-rate-limit-patterns.md` — rate limit details
