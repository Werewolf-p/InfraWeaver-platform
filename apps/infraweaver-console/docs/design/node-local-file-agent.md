# Node-local file agent — design (no live-path changes)

Status: design only. Nothing in this document changes `withServerFileExec` or the
live offline branch. It describes an alternative to the per-request offline pod
and, crucially, pins down the rule that the agent must only ever serve a request
when the caller genuinely holds RBAC read (or write) on *that specific* game
server.

## Why consider this at all

The offline branch in `server-file-exec.ts` works, but every file operation on a
stopped server pays a pod lifecycle: create `<server>-files`, wait for Running,
exec, delete, wait for gone — serialized per server by an in-process mutex so two
requests don't delete each other's pod. That is several seconds of latency per
click, a deterministic-name collision surface, and a steady trickle of pod churn
in the namespace. A long-lived node-local agent that reads the volume directly
off disk turns that into a single authenticated HTTP call.

The catch is that the offline pod has one genuinely nice property we must not
lose: it mounts exactly one PVC, read-only for reads, and it only exists while a
request is in flight. A standing DaemonSet with a hostPath into the provisioner
root sees *every* server's data on the node, all the time. The entire RBAC and
PodSecurity section below exists to claw back that lost isolation in software,
because the kernel is no longer doing it for us.

## Shape

A DaemonSet `gamehub-file-agent` in the `game-hub` namespace. One pod per node.
Each pod hostPath-mounts the local-path provisioner root
(`/opt/local-path-provisioner`, confirm against the live provisioner config) and
serves a minimal HTTP API on a node-local port, reachable from the console only:

- `GET  /v1/servers/{name}/files?path=…`      list
- `GET  /v1/servers/{name}/files/content?path=…`  read one file
- `PUT  /v1/servers/{name}/files/content?path=…`  write one file
- `POST /v1/servers/{name}/files/upload`           upload (multipart)
- `DELETE /v1/servers/{name}/files?path=…`         delete
- plus mkdir / rename / extract to match today's route surface

Every handler resolves `{name}` to a single on-disk directory (below) and refuses
to touch anything outside it. Path validation stays where it is today — the
console already owns `validateContainerPathWithinRoot`; the agent re-validates
independently because it is now a separate trust boundary, not a callback.

## Resolving a server's PVC to its host path and node

This is the part that lets the console call the agent instead of the offline
branch, and it reuses resolution we already do:

1. From the server Deployment (`getServerDeployment`), read the PVC name off
   `spec.template.spec.volumes[].persistentVolumeClaim.claimName` — exactly the
   lookup `runOfflineFileExec` already performs.
2. Read the PVC, take `spec.volumeName` → the bound PV.
3. Read the PV. `pv.spec.local.path` is the authoritative on-disk directory (for
   older provisioner builds it is `pv.spec.hostPath.path`). Do **not** reconstruct
   the `<pvName>_<namespace>_<pvcName>` directory name by hand — read it from the
   PV so a provisioner config change can't silently point the agent at the wrong
   directory.
4. `pv.spec.nodeAffinity.required.nodeSelectorTerms[].matchExpressions` with key
   `kubernetes.io/hostname` names the **one** node that physically holds the data.
   That is the node whose agent the console must call. local-path is RWO and
   node-pinned; there is exactly one correct agent per server.

The data root *within* that directory (e.g. `/data` vs a subPath) still comes from
`resolveServerDataRoot` / the egg `mountPath`, so the path the agent roots at is
`<pv.spec.local.path>` joined with the same logic `resolveDataRoot` uses today.

## How the console call replaces the offline branch

`withServerFileExec` keeps its online branch untouched: if the server pod is
Running, exec into it as now (writing live save files through the running process
avoids torn reads and races). Only the offline branch changes shape.

Offline, instead of create-pod → exec → delete, the console:

1. Confirms the deployment is scaled to 0 for **write** ops — the same invariant
   as today; we still refuse to write under a starting/running server.
2. Resolves PV path + node as above.
3. Mints a scoped credential for this exact `{server, mode}` (next section).
4. POSTs to the agent on the resolved node with that credential.

The `ServerFileExec` contract (`rootPath`, `offline`, `exec`) can stay as the
seam; an agent-backed implementation swaps the pod-exec `exec` for an HTTP call,
so callers in `route.ts` / `content/route.ts` / `upload/route.ts` are unchanged.

## RBAC — the load-bearing requirement

The hard constraint: a file operation succeeds only if the caller actually has
RBAC read (or write) on *that one server*. Network reachability to the agent must
buy nothing. There are two RBAC worlds in play and the design has to bridge them
honestly rather than let the agent become a bypass.

Today, app-level RBAC lives in the console: `hasGameHubPermission` checks
`game-hub:files` + read/write at scope `/game-hub/servers/<name>`, and the
console then acts on the cluster as one privileged service account. If the agent
simply trusted "the console called me," then anyone who could reach the agent's
port, or any console bug, would read every server's saves. That is the failure
mode we are explicitly designing out.

The rule, stated precisely: **the agent authorizes every request against
Kubernetes RBAC, scoped to the specific server, and fails closed.** Concretely:

- We model "the game server" as named Kubernetes objects the agent can authorize
  against: the Deployment `<name>` (and its PVC) in `game-hub`. Read maps to the
  verb `get`, write maps to `update`/`patch`, on `resourceNames: ["<name>"]`.
- For each request the console mints a **bound, short-lived ServiceAccount token**
  (via TokenRequest) for a per-request/per-server identity whose RBAC grants
  exactly those verbs on exactly that server's resourceName — and nothing else.
  The token is audience-scoped to the agent and lives seconds, not minutes.
- The agent, on every request, runs a **TokenReview** (is this token valid, what
  is its subject) followed by a **SubjectAccessReview**: "can this subject `get`
  (read) / `patch` (write) the deployment named `<name>` in `game-hub`?" If the
  SAR says no, it is a 403 before a single byte of disk is touched. The path the
  agent then serves is derived from *that same* `<name>`, so a token good for
  server A can never be spent on server B's directory even if the URL is tampered.

The effect is that "can this caller read/write this server's files" is answered by
the cluster's own authorizer against real RBAC on that server, not by trust in the
caller. The console's existing `game-hub:files` + per-server-scope check stays as
the first gate (fast rejection, audit, rate limit), but it is no longer the *only*
thing standing between a request and the bytes. To grant a person file access to
one server you give them RBAC on that one server; the per-server scope the role
system already encodes (`/game-hub/servers/<name>`) maps cleanly onto a
per-server resourceName grant.

Read-only must be unforgeable: a read token carries no `patch` verb, so even if a
read caller hits `PUT /content`, the SAR for `patch` fails. That replaces the
offline pod's read-only *mount* with a read-only *authorization* — weaker than a
kernel-enforced RO mount, which is why write gating is defense-in-depth in both
the token and the agent code.

The agent's own ServiceAccount needs only `create` on `tokenreviews` and
`subjectaccessreviews` (the `system:auth-delegator` ClusterRole covers exactly
this) plus read on the PVs/PVCs it resolves. It deliberately does **not** get
broad pod/exec rights — it never creates pods. That is a strict reduction from the
console SA's current create-pod-and-exec footprint on the offline path.

## PodSecurity implications

This is where the DaemonSet is plainly worse than the ephemeral pod, and the
design should own that rather than hide it.

The offline pod inherits the server's own `securityContext` and mounts one PVC,
read-only for reads. The agent instead hostPath-mounts the provisioner root, which
under Pod Security Admission is a `restricted`-violating volume type — hostPath is
disallowed at `baseline` and above. So the `game-hub` namespace either can't be
`restricted`/`baseline`-enforced for this workload, or the agent needs an
exception. Options, least-bad first:

- Run the agent in its **own namespace** (`gamehub-file-agent`) labelled
  `privileged` for PSA, and keep `game-hub` itself at `restricted`. The blast
  radius of the hostPath privilege is then one tightly-reviewed DaemonSet, not the
  whole game namespace. The agent still talks to the `game-hub` API objects via
  RBAC across namespaces.
- Mount the hostPath **read-only at the volume** and serve writes through a
  narrower, separately-mounted writable path — but local-path keeps every
  server's data under the same root, so a single RW hostPath to support uploads
  necessarily exposes RW to all servers' directories at the mount level. The
  software/RBAC gate, not the mount, is what confines writes. State this loudly: a
  bug in the agent's path or authz logic is now a write to arbitrary server data,
  where the offline pod physically could not reach another server's PVC.
- Drop every Linux capability, `runAsNonRoot` where the on-disk uid permits,
  `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`, read-only
  root filesystem. None of these undo the hostPath exposure but they shrink
  everything else.
- A Kyverno/admission policy that pins *which* hostPath the agent may mount (only
  the provisioner root, nothing else) so the exception can't drift into a general
  hostPath grant.

Net: PSA goes from "this namespace can be restricted" to "one privileged
DaemonSet in an isolated namespace, policy-pinned." That is a real, permanent
downgrade and is the main cost of the approach.

## Node-pinning implications

The offline pod is scheduled by Kubernetes onto whatever node can bind the RWO
volume — we never think about nodes. The agent inverts this: the console must
route each request to the *specific* node whose disk holds the data, derived from
`pv.spec.nodeAffinity` above.

Consequences to design for:

- The DaemonSet must actually run on every node that can host game data
  (tolerations matching any tainted storage nodes), or some servers become
  unreachable for files. A missing agent pod on a node is a hard failure for every
  server pinned there.
- The console needs to address one node's agent, not a round-robin Service. Use
  the agent pod's node-local identity — e.g. resolve the pod on that node via the
  DaemonSet's pods filtered by `spec.nodeName`, and call its pod IP — rather than
  a namespace-wide ClusterIP that could land on the wrong node. There is exactly
  one right answer per request and the resolution must be deterministic.
- If a PV ever migrates nodes (restore, manual move), the nodeAffinity is the
  source of truth; never cache the node→server mapping past a single request.
- This concentrates per-node trust: that node's agent can read every server pinned
  to that node. The RBAC SAR still gates *callers*, but the agent process itself
  is a higher-value target than a 300-second pod. Treat its port as
  console-only (NetworkPolicy: ingress from the console pods alone), never exposed.

## What stays the same

- Online (running server) file ops still exec into the game pod; the agent is an
  offline-path replacement only.
- Per-server write-while-stopped invariant is preserved.
- Console route-layer RBAC (`game-hub:files` + per-server scope), audit logging,
  and rate limiting are unchanged — they become the first gate, with the agent's
  SAR as the authoritative second.
- Path validation against the resolved root is enforced, now on both sides of the
  network boundary.

## Honest comparison

The ephemeral pod buys isolation from the kernel: one PVC, read-only when reading,
gone in seconds, no standing privilege. The agent buys latency and removes pod
churn, at the cost of a standing hostPath-privileged process that can physically
see every server's data on its node, with isolation re-implemented in software and
in per-request Kubernetes RBAC. The design is only acceptable if that software
gate is genuinely RBAC-backed and fail-closed — which is the entire point of the
SubjectAccessReview requirement above. If we are not willing to run the SAR on
every request, we should keep the offline pod.
