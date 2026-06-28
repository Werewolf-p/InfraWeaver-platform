# Architecture Review — Offline game-server file browser (ephemeral PVC pod)

Paste the prompt below into a fresh Claude Code session **at the repo root** to
get an expert second opinion on whether the current approach is the best way to
do offline file browsing/editing. It is **review-only** — it must not change code.

---

```
Act as a senior Kubernetes + Next.js platform architect. Do a REVIEW ONLY — do
NOT edit code, create files, or run mutating commands. Read-only analysis.

CONTEXT
We added offline file browsing/editing for game servers in the InfraWeaver
console. When a server's Deployment is scaled to 0 (stopped), there is no pod to
`kubectl exec` into, so file operations are routed through a shared helper:

  apps/infraweaver-console/src/app/api/game-hub/servers/[name]/files/
    - server-file-exec.ts   (the helper: withServerFileExec)
    - route.ts              (GET list, POST mkdir, PATCH rename/extract, DELETE)
    - content/route.ts      (GET read file, PUT save file)
    - upload/route.ts       (POST upload)

How `withServerFileExec(clients, name, fn)` works:
  - Online (running pod found): execs the shell command in the live game pod.
  - Offline (no running pod): looks up the Deployment, finds the data PVC
    claimName + egg mountPath, then per HTTP request:
      1. deletes any stale pod named `<server>-files`, waits for it to be gone
      2. createNamespacedPod: restartPolicy Never, activeDeadlineSeconds=300,
         reuses the server's own container image, mounts the PVC READ-WRITE at
         the mountPath, runs `sleep 300`
      3. waits until Running, runs the file op via exec
      4. deletes the pod in a `finally` block
  So one pod is created and torn down per request. Paths are validated with
  validateContainerPath / validateContainerPathWithinRoot. PVCs are local-path
  RWO with node affinity. RBAC: the console SA already creates/deletes pods.

YOUR TASK
1. Read all four files listed above plus ./data-root.ts in the same directory.
2. Decide whether "ephemeral read-write pod per request" is the best design.
3. Evaluate at least these dimensions, each with a concrete verdict:
   - Per-request pod churn vs. a reused/long-lived helper pod, a Job, or a
     persistent lightweight sidecar/agent. Quantify the latency cost of pod
     startup on every keystroke-save / directory click.
   - RWO local-path PVC: node-affinity scheduling, and mount conflicts if the
     server starts while a `<server>-files` pod still holds the volume.
   - Concurrency: two users (or two tabs) hitting the same deterministic pod
     name `<server>-files` simultaneously — collisions, races, partial deletes.
   - Cleanup reliability: is delete-in-`finally` + activeDeadlineSeconds=300
     enough to guarantee no leaked pods across crashes, timeouts, and SIGKILL?
   - Security: read-write mount of production save data while the server is
     offline; blast radius of the exec'd shell commands; path-traversal coverage;
     whether write access should require a stricter permission than read.
   - Alternatives: CSI ephemeral volumes, `kubectl cp`, an init-container-based
     reader, a long-lived per-namespace file agent, or VolumeSnapshot-based
     read. State when each is better and when it is overkill.
   - Resource/RBAC implications and PodSecurity (restricted) compliance.
4. OUTPUT, in this order:
   a. A one-line verdict: KEEP AS-IS / KEEP WITH FIXES / REPLACE.
   b. A score out of 10 for the current approach, with one sentence of rationale.
   c. A risk table ranked by severity (CRITICAL/HIGH/MEDIUM/LOW), each with:
      file:line, the problem, and the concrete fix.
   d. If you recommend REPLACE or a materially better pattern, give the
      alternative design in ~10 lines and the migration cost.
   e. The single highest-value change to make first.

Be specific and cite file:line. Prefer the simplest design that is correct and
safe. Do not rewrite the code in this pass — recommendations only.
```
