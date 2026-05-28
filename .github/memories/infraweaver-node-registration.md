---
title: infraweaver-node registration and approval flow
description: The node agent requires one-time admin approval; state persists to a K8s Secret after first approval.
---

# infraweaver-node Registration Flow

## Memory

- **File paths:**
  - `apps/infraweaver-node/src/index.ts` — startup logic
  - `apps/infraweaver-node/src/lib/discover.ts` — discovery (no-token) flow
  - `apps/infraweaver-node/src/lib/registration.ts` — token flow
  - `apps/infraweaver-node/src/lib/state.ts` — persists state to K8s Secret
  - `apps/infraweaver-api/src/lib/agent-registry.ts` — hub-side WS handler
  - `apps/infraweaver-api/src/routes/agents.ts` — REST approve/reject endpoints

- **Decision:** Two-path registration:
  1. **Token path** — `REGISTRATION_TOKEN` env var set → `register()` → instant, no approval
  2. **Discovery path** — no token → `discover()` → loops until admin approves in the console

- **State persistence:** After approval, state (clusterId, agentPrivateKeyPem, hubPublicKeyBase64) is saved to K8s Secret `infraweaver-node-state` in the `infraweaver-system` namespace. On subsequent restarts, the node loads this state and connects directly — **no re-approval needed**.

- **Why it matters:** Without the state secret, every pod restart goes through discovery. If nobody approves within 5 minutes, the node retries indefinitely. The pod shows `Ready: False` and `catalog-infraweaver-node-manifests` appears Degraded in ArgoCD.

- **Validation:** After approval: `kubectl get secret infraweaver-node-state -n infraweaver-system` should exist; `kubectl get pod -n infraweaver-system -l app=infraweaver-node` should show `1/1 Running`.

- **Approval UI:** Go to `/cluster` in the console. The agent panel at the top shows pending agents with Approve/Reject buttons (polls every 8s). Previously this required a manual `curl` command with HMAC auth.

- **Emergency approval via curl (if UI unavailable):**
  ```bash
  # 1. Port-forward the API
  kubectl port-forward -n infraweaver-console svc/infraweaver-api 13001:3001 &
  # 2. Poll until agent appears in pending list
  # 3. Approve it (SECRET from: kubectl exec -n infraweaver-console deploy/infraweaver-api -- env | grep CONSOLE_API_SECRET)
  SECRET="<value>"
  AGENT_ID="<from pending list>"
  TS=$(date +%s%3N); MSG="${TS}:system-admin:platform-owner"
  SIG=$(python3 -c "import hmac,hashlib,sys; print(hmac.new(sys.argv[1].encode(),sys.argv[2].encode(),hashlib.sha256).hexdigest())" "$SECRET" "$MSG")
  curl -X POST http://localhost:13001/api/v1/agents/pending/${AGENT_ID}/approve \
    -H "Content-Type: application/json" \
    -H "x-console-ts: $TS" -H "x-user-id: system-admin" \
    -H "x-user-roles: platform-owner" -H "x-console-sig: $SIG" \
    -d '{"clusterId":"prod-cluster","clusterName":"Production Cluster","environment":"production"}'
  ```

- **Related:** `infraweaver-node-registration` secret has `REGISTRATION_TOKEN` field (empty by default). Setting it would bypass discovery entirely.

- **Lesson learned:** The node was stuck for 4+ hours on attempt 47+ because there was no console UI for approval. Added the agent panel to the cluster page with auto-refresh.
