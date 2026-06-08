# Feedback Automation — Stability & Reliability

How the in-console feedback pipeline is kept reliable, what was hardened on
2026-06-08, and the residual roadmap. The pipeline: console UI → `/api/feedback*`
routes → dispatch service (`server.js`, :9876) → Claude + in-cluster BuildKit →
Zot registry → ephemeral `staging` preview; Publish merges `feedback/staging` →
`main` and bumps the prod image pin.

## Failure modes and the fixes shipped

### 1. Stranded shared git workspace (was the #1 outage)
The dispatch service mutates ONE shared checkout (`/home/runner/InfraWeaver-platform`).
A run that died mid-`revert`/`merge`/`cherry-pick`/`rebase` left conflict markers
and a dirty index, so **every** later run failed at checkout with
`error: you need to resolve your current index first` (feedback 30101627).

**Fixed:** `RESET_WORKSPACE` runs at the start of every git operation
(`checkoutStaging`, the not_fixed revert, the publish merge). It aborts any
in-progress operation, `git reset --hard`, and `git clean -fd` (keeps gitignored
`node_modules`/`.next` so builds stay warm). Each run is now self-healing
regardless of how the previous one ended. Verified by simulating a stranded
mid-revert state and confirming automatic recovery.

### 2. Revert conflicts / publishing a conflicted tree
`git revert` of a superseded commit could conflict; the old publish merge used
`|| true` and could push conflict markers to `main`.

**Fixed:** the revert is conflict-proof (on conflict it aborts cleanly and lets
the redo's fresh fix supersede, never stranding the tree). The publish merge is
fail-closed — on conflict it aborts and errors instead of pushing a broken `main`.

### 3. Raw "Failed to fetch" / "Load failed" in the UI
Transient network blips (single-replica console pod restart, proxy hiccup) were
surfaced as bare browser errors on submit / publish / approve (9677f0dc,
9e7ad6c8, 6894ee41).

**Fixed:** the shared API client (`src/lib/api-client.ts`) now applies a
per-attempt `AbortController` timeout (20 s) and a bounded retry (3 attempts,
backoff) on network errors and 502/503/504. Long pipeline ops already return
immediately (dispatch runs in the background), so retries are safe and fast.

### 4. Entries stuck in `approved` after a console restart
The approve/redo write-back is a detached promise inside the single-replica
console process. If that process restarted/crashed (the exit-139 bursts) mid-run,
an entry stayed `approved` forever even though the dispatch run finished.

**Fixed:** `GET /api/feedback` now reconciles any `approved` entry whose dispatch
run has settled, from the authoritative run history on the runner
(`reconcileStaleEntries`). Best-effort and fail-safe — never blocks the list.

### 5. Approve queue that didn't serialize
The busy-latch reset the instant the fast approve call returned, before the entry
showed `approved` on the next 10 s poll, so a 2nd approve double-dispatched
instead of queuing (8dc5d87f).

**Fixed:** busy is held via `dispatchingId` across that gap; the queue is
persisted to `sessionStorage` so a refresh won't drop it. Backend serialization
(`pipelineLock`) is unchanged and remains the source of truth.

## Invariants that keep it safe
- **Serialize mutations:** approve / redo / publish take `pipelineLock` so they
  never overlap on the shared workspace.
- **Self-heal first:** never trust the workspace state from a prior run.
- **Fail closed on git conflicts:** never push a half-resolved tree to a branch.
- **Authoritative state on the runner:** run records survive a console restart;
  the UI reconciles from them.
- **Fail-safe integration:** unset `DISPATCH_URL` → status change still succeeds,
  call reported `skipped`.

## Residual roadmap (not yet shipped)
1. **Console single point of failure / OOM:** the console runs one replica and has
   had exit-139 (segfault) bursts. Reconcile-on-read masks the symptom; root-cause
   the crashes (memory limits, native module) and consider a 2nd replica with the
   feedback writes already guarded by ConfigMap optimistic concurrency.
2. **Game-hub stop GitOps mis-routing (df5a9e3b/82eed8cc):** the console writes
   game-hub manifests via OneDev→InfraWeaver-platform, but ArgoCD reconciles
   game-hub from GitHub→InfraWeaver-infra, so a stop is reverted by selfHeal.
   Point the game-hub manifest write-back at the repo ArgoCD actually watches.
3. **Dispatch `/health` depth + watchdog:** extend `/health` to report workspace
   cleanliness and last-run status; add a systemd watchdog/alert.
4. **Run-history retention:** `runs/index.json` is capped at 1000; add age-based
   pruning of `runs/<id>/*.log` to bound disk.
5. **Ephemeral per-run clone (longer term):** isolating each run in its own
   worktree would remove the shared-workspace contention entirely; the self-heal
   above is the pragmatic interim.
