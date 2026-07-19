# IWSL: Secure by design — the signed-channel invariant

**Status: normative. Read this before adding ANY remote WordPress-management
capability to InfraWeaver.**

## The rule (non-negotiable)

> Every new piece of remote functionality against a managed WordPress site MUST
> travel over the **IWSL signed command channel** as a new signed *method*. It
> MUST NOT be a new public-facing, plaintext, or separately-authenticated plugin
> REST endpoint.

The Connector plugin exposes exactly **two** ingress surfaces, and that number
never grows:

1. `POST /wp-json/infraweaver/v1/enroll*` — one-time, single-use enrollment (§5).
2. `POST /wp-json/infraweaver/v1/command` — the signed command channel (§6).

Everything else — health, diagnostics, key rotation, kill switch, plugin update,
**metrics** — is a *method* inside the signed command, allow-listed by the
plugin's command registry. There is no third endpoint. If a feature seems to need
one, it does not: model it as a new signed method instead.

## Why (the threat model this buys)

A signed command is authenticated end-to-end and a signed response is verified
before a single field is trusted. Concretely, every method automatically gets:

- **Dual signatures** — Ed25519 + SLH-DSA (post-quantum) on the command; the
  response is Ed25519-signed by the site's pinned WP key.
- **Pinned-key verification** — the console verifies each reply against the WP-PK
  it pinned at enrollment. A tampered reply **quarantines the link** and throws
  before the value is used (`recordResponseTamper`).
- **Replay + freshness** — monotonic `seq`, single-use `nonce`, `ts`/`exp`
  windows (§6.3).
- **Channel/audience binding** — a command captured on one transport can't be
  replayed onto another (§6.4).
- **Epoch floors** — retired key epochs are rejected forever (§8).
- **The §2 invariant** — the site never dials InfraWeaver; IW initiates and the
  plugin only answers inside the same exchange.

A new plaintext plugin endpoint would have **none** of these. It would be net-new
attack surface — an unauthenticated (or bearer-only) hole in a system whose entire
value is that the transport is untrusted and the cryptography is the boundary.
`metrics.snapshot` is the reference example: telemetry that *could* have been a
trivial `GET /metrics` on the plugin is instead a signed method, so a scraped
gauge is as trustworthy as a health check and a MITM is caught, not believed.

## How to add a new capability (the worked checklist)

Use `metrics.snapshot` (this repo) as the template. To add method `x.y`:

1. **Plugin** — add an `IWSL_Command_Handler` to
   `IWSL_Plugin::command_handlers()` (`apps/infraweaver-wp-connector/includes/class-iwsl-plugin.php`).
   The verifier allow-list derives from that registry automatically — never keep a
   parallel list. Runner returns `[bool $ok, array $result]`. Read-only methods set
   neither `signs_with_current_kid` nor `wipes_after`. Expose **no key material**.
2. **Console registry** — mirror it in `lib/rpc/registry.ts`: add to `RpcMethod`,
   `RpcParams`, `RpcResult`, and `RPC_REGISTRY` (params validator matching the
   plugin's). This is the single console-side source of truth.
3. **Console op** — add a function in `lib/iwsl-managed-ops.ts` that calls
   `callRpc(rpcTransport(record, deliver, channel), "x.y", params)`. Managed links
   use `execDelivery` (exec), external links use `httpDelivery` (HTTPS). Never
   hand-roll the transport — reuse `dispatchSignedCommand`, which is the one place
   verification + quarantine live.
4. **Surface** — expose it through a route/probe. Token-gated machine endpoints
   (Prometheus, cron) authenticate a constant-time secret at BOTH the `proxy.ts`
   wall and the handler (defence in depth), and fall through to a session gate.
5. **Tests** — a plugin fixture + `test-plugin.php` assertion that the response
   **verifies against the WP-PK** (not just that it's shaped right), plus a console
   test. Regenerate fixtures with `gen-fixtures.ts`.
6. **Re-enroll** — see below.

## Forbidden

- ❌ A new plugin REST route for a management feature.
- ❌ Any unauthenticated, or bearer/API-key-only, plugin endpoint.
- ❌ Reading a site's WordPress DB directly from the console (cross-tenant hazard);
  go through the signed channel or the site's own scoped wp-cli exec.
- ❌ A parallel method allow-list that can drift from the command registry.
- ❌ Trusting any reply field before signature verification.

## Console-side least privilege (reviewed for the metrics feature)

The signed channel secures the console↔plugin hop; these keep the *console* side
least-privileged for reading and exposing that data:

- **Per-site RBAC on reads.** The Manage metrics panel is gated
  `authorize("wordpress:read", site)` — read-only, and scoped to the one site, so
  a grant on site A never exposes site B. The probe queries Prometheus with a
  `{site="<that site>"}` selector only.
- **Read-only Prometheus.** The console only ever *reads* Prometheus (`/api/v1/query_range`)
  over a trusted, config-pinned in-cluster URL (`PROMETHEUS_URL`), wrapped in a
  circuit breaker. It never writes, and Prometheus is not user-addressable.
- **PromQL-injection guarded.** The site id is validated upstream
  (`assertValidSiteId`) and re-checked in the probe (`^[a-z0-9-]+$`) before it
  reaches a label matcher, so no value can break out of the quoted selector.
- **Scrape token is a read-only machine grant.** `WORDPRESS_METRICS_TOKEN`
  (Bearer) reaches only the read-only exporter — no mutation path — fail-closed,
  constant-time compared, re-validated at the handler.
- **Live reads are not persisted.** The panel's live `metrics.snapshot` is stamped
  with `checkedAt` and held only in the per-replica 25s SWR cache; durable history
  lives in Prometheus, not in console state.

Known, accepted breadth: the **fleet** exporter (`GET /api/wordpress/metrics`) and
its session fallback are namespace-wide `wordpress:read` — a Prometheus scraper
needs every site at once. That is the one intentionally-broad read; it exposes no
mutation and no secrets (fingerprints/versions/counters only). Per-user, per-site
scoping is preserved on the interactive panel.

## Re-enroll steps (when the signed method set changes)

Adding a *read-only* method (like `metrics.snapshot`) is **backward compatible**:
an older Connector simply rejects the unknown method with `unknown-method`, and
callers degrade (the metrics panel shows "signed read failed", history still
works). No re-enrollment is required to keep existing links running.

To make a new method available on a live managed link, **update the plugin in
place** (keys and epochs are preserved — no re-enroll):

1. Ship the console image carrying the new bundled plugin.
2. Per site: **Manage → Connector → Update plugin**, or the fleet
   `POST /api/wordpress/connector-update-sweep` (admin). This runs
   `plugin install --force`; `iwsl_*` options survive, so the pinned WP/IW keys
   and epoch floors are untouched.
3. Verify: a signed `health.check`/`metrics.snapshot` returns the new plugin
   version.

A **full re-enroll** is only needed when key material or the enrollment contract
changes (not for adding a method). If you must: `wp option delete iwsl_*` to purge
plugin state, delete + reinstall the plugin, then re-run enrollment
(`enrollManagedSite`). See the IWSL fleet-enroll notes.
