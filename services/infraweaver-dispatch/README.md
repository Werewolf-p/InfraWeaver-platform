# infraweaver-dispatch

HTTP service the console calls directly (no n8n) to drive the feedback auto-fix
flow. Runs on the runner host as the `infraweaver-dispatch` systemd unit, listening
on `:9876` (cluster/localhost only).

## Agent Studio

The auto-fix pipeline is an editable, n8n-style sequence of agent **steps** the
service runs on `/approve` (default: **Plan → Validate plan → Implement**). Each
step carries its own prompt, agent, model, specialism (an appended system prompt),
tool allowlist, and MCP plugins. The console's Agent Studio modal edits it via:

| Endpoint | Purpose |
|---|---|
| `GET/PUT /pipeline` | read / save the pipeline definition |
| `POST /pipeline/reset` | restore the default pipeline |
| `GET /specialists`, `POST /specialists/refresh` | the GitHub-sourced specialist library |
| `GET /catalog` | option catalogs (agents / tools / models / MCP) |

`runPipeline()` executes each enabled step, threading one step's output into the
next via `{{previousOutput}}`, and streams a `step:<name>` phase marker to the live
run console.

- `server.js` — HTTP server, pipeline executor, build/deploy/publish operations.
- `pipeline-store.js` — pipeline definition, validation, prompt composition.
- `specialists.js` — specialist-prompt library (seed + GitHub refresh).
- `preview.sh` — ephemeral staging env up/down.

## Source of truth

The running service currently executes a copy at `/home/runner/infraweaver-dispatch`
on the runner host. This directory is the version-controlled source; reconcile the
host copy from here. Secrets (`.registry-pass`) and runtime state (`runs/`,
`pipeline.json`, `specialists.json`) are git-ignored.

## Environment

`DISPATCH_PORT`, `WORKSPACE_DIR`, `FEEDBACK_BRANCH`, `REGISTRY`, `GIT_REMOTE`,
`PREVIEW_HOST`, `BUILDKIT_NODEPORT`, `INFRA_DIR`. The console reaches it via
`DISPATCH_URL`.
