---
title: Flannel transient disconnects during API server restart
description: CoreAPI becomes briefly unreachable when Flannel pod restarts on same node as API server
---

# Flannel + API Server Co-location Issue

## Memory

- **File paths:** Talos cluster networking, kube-system namespace
- **Condition:** All 3 nodes are control-plane with co-located API server + Flannel pods
- **Symptom:** Brief (5-10s) "connection refused" or timeout errors when Flannel restarts
- **Why it matters:** Can cause cascading reconciliation failures in ArgoCD, operator webhooks, and client tools
- **Workaround:** Implement retry logic with exponential backoff in client code
- **Prevention:** Node anti-affinity (Flannel pod avoids API server nodes) — NOT applicable here since all nodes are control-plane

## Root Cause

1. Pod on Node A needs to reach API server (also on Node A via localhost:6443)
2. If Flannel pod on Node A restarts → CNI plugin unloads → network drops
3. API server briefly unreachable while Flannel comes back up
4. Client code sees "connection refused" or timeout

In a 3-node control-plane cluster, this happens on all 3 nodes in succession.

## Current State

**Talos Cluster:** 3x control-plane, NO worker nodes
- All kube-system pods (including Flannel) run on control-plane nodes
- API server and Flannel are co-located on each node
- No ability to schedule Flannel elsewhere

## Mitigation

### Short Term: Client Retry Logic
```go
// In client code (Go example)
for attempt := 0; attempt < 3; attempt++ {
    resp, err := client.Get("/api/v1/...")
    if err == nil {
        return resp, nil
    }
    if attempt < 2 {
        backoff := time.Duration(math.Pow(2, float64(attempt))) * time.Second
        time.Sleep(backoff)
    }
}
```

### Medium Term: Talos Node Upgrade
Add dedicated worker nodes to allow Flannel pod anti-affinity scheduling.

### Long Term: Network Separation
Use host-level network routing (not CNI) for control-plane internal traffic (out of scope).

## How to Identify

```bash
# Check CoreAPI availability during Flannel restart
while true; do
  curl -k https://127.0.0.1:6443/api/v1/namespaces && echo "UP" || echo "DOWN $(date +%s)"
  sleep 1
done

# Watch Flannel pod restarts
kubectl logs -n kube-system -l app=flannel --tail=20 -f
```

## Testing

```bash
# Trigger Flannel restart on one node
kubectl delete pod -n kube-system -l app=flannel --field-selector spec.nodeName=talos-prod-cp1

# Watch API server connectivity from other nodes
# You should see brief errors, then recovery
```

## Workarounds NOT Applicable

- ❌ Node anti-affinity (all nodes are control-plane)
- ❌ Separate CNI (Talos requires Flannel for v1.13)
- ❌ Multiple Flannel replicas (causes race conditions with single control-plane node)

## Lesson Learned

In control-plane-only clusters, expect transient networking blips during system pod restarts. Design clients to handle retries gracefully. This is NOT a bug — it's expected behavior in resource-constrained architectures.

---

**Discovered:** 2026-05-26 (during n8n deployment monitoring)  
**Cluster:** Talos v1.13.0, 3x control-plane only  
**Mitigation:** ✅ Handled via client retry logic
