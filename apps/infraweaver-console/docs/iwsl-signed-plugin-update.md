# Evaluation: signed-channel `plugin.update` for external IWSL sites

**Question.** Managed (§5.1, in-cluster) sites now update their Connector in bulk
over the k8s-exec transport (`runConnectorUpdateSweep`). External (§5) sites have
no exec channel — their Connector is updated by hand (`wp plugin install --force`
or the "Download plugin" button + manual upload). Can we add a signed-channel
`plugin.update` command so external sites upgrade remotely instead?

**Verdict.** Feasible within the trust model, but **deferred** — it is a distinct
project, not a rider on the bulk-update change. The blockers below are
architectural (the §2 invariant, the 64 KB wire cap, host filesystem writability),
not effort. Ship the exec-based bulk sweep now; gate remote external-site updates
behind the design work here.

---

## What constrains the design

### 1. The §2 invariant forbids a pull

The core guarantee (`infraweaver-connector.php` header, README §2): *"zero standing
WP→IW path"* — the plugin **never initiates a connection to InfraWeaver**. It only
verifies dual-signed commands and answers inside the same HTTP exchange.

That kills the obvious design (plugin fetches a new ZIP from the console's
`/external-sites/plugin` endpoint on command). Any pull — even "download this URL,
check this hash" — is an outbound WP→IW call and breaks the invariant that makes a
compromised WP site unable to pivot into the management plane.

**The only compatible shape is push:** the new plugin ZIP travels *inside* the
signed command body, verified by the same Ed25519 + SLH-DSA AND signature that
authorizes every other command. No new fetch, no new trust root.

### 2. The 64 KB wire cap barely fits — and only today

`IWSL_MAX_BODY_BYTES = 65536`. Measured now:

| Component | Bytes |
|---|---|
| SLH-DSA-192s signature (every command carries one) | ~22 KB |
| Connector ZIP, base64 | ~32 KB |
| envelope + JCS + nonce + params overhead | ~1–2 KB |
| **total** | **~55 KB** |

It fits — with ~10 KB of headroom that any new PHP, JS, or bundled asset erases.
`MAX_STRING_LEN = 256` on the verifier also means a base64-ZIP param needs its own
schema carve-out (it is not a normal short string field). Options:

- **Raise the cap** to hold ZIP + signature. Directly weakens the §12 anti-DoS
  guard (unauthenticated `/command` POSTs are size-checked *before* the expensive
  JCS + dual-verify), so this is a security regression, not a config tweak.
- **Chunked transfer** — `plugin.update.begin` / `.chunk[n]` / `.commit`, each a
  full signed+sequenced command, reassembled server-side in the plugin. Keeps the
  cap and the DoS guard intact; costs a small stateful transfer protocol
  (offsets, a staging option, resume/abort, a total-size + final-hash commit).
  This is the honest path and it is real work.

### 3. Host filesystem writability

Managed sites update cleanly because we `wp plugin install --force` as root in the
pod. A large share of *external* WordPress hosts cannot write `wp-content/plugins`
from PHP without FS_METHOD/FTP credentials (`request_filesystem_credentials`).
`plugin.update` must detect a non-writable filesystem and fail-closed with a §12.5
reason so the operator falls back to manual — it can reduce manual updates, it
cannot eliminate them.

### 4. Self-overwrite fragility + rollback

The command overwrites the very plugin handling the request. WP's own updater does
this safely (maintenance mode, staged dir, atomic swap), so reuse `Plugin_Upgrader`
rather than hand-rolling unzip-over-live-files. A bad build that fatals on load
severs the site's only management channel, so the flow must:

1. stage + verify sha256 of the pushed ZIP before swapping,
2. keep the previous version staged,
3. run a post-swap self-check and **auto-rollback** on failure,
4. refuse downgrades (version-monotonic).

---

## Trust-model impact (the part that actually needs a decision)

Adding `plugin.update` does **not** cross the enrollment trust boundary — IW already
fully controls an enrolled site (it can rotate the site's keys and fire the §8 kill
switch). But it **raises the blast-radius ceiling**: today a compromised IW *command*
key can rotate/kill a site; it cannot run attacker-chosen PHP. `plugin.update` turns
key compromise into remote code execution on every enrolled site at once.

Mitigation — sign the *payload* separately from the *command*:

- Introduce a **code-signing key** distinct from the IW command key, pinned at
  enrollment alongside the IW-PK. The ZIP must carry a signature from that key; the
  command's dual-sig authorizes *installing an already-code-signed artifact*, it is
  not itself the authority to run new code.
- Then the command key alone (the one exercised on every routine op, the larger
  attack surface) cannot ship code — an attacker needs the offline code-signing key
  too. This restores "key compromise ≠ fleet RCE".

That key-management design is the substantive open question and the reason this is a
separate project.

---

## Recommendation

1. **Now:** ship the exec-based bulk sweep for managed sites (this change). It
   already covers every in-cluster site with zero new protocol surface.
2. **Cheap interim — SHIPPED.** The console now surfaces an *"update available"*
   badge by comparing each link's `connectorVersion` (persisted from the last
   verified `health.check` `plugin` field) against the bundled
   `buildConnectorPackage().version`. Managed connector cards show it live; the
   external-sites cards render the same badge the moment an external link reports
   a version (today they have no command channel, so the field stays empty and no
   badge shows — correct: you can't claim a site you've never spoken to is stale).
   The compare (`lib/connector-version.ts`) only flags a site running *behind* the
   bundle, never one ahead or on an unparseable version. No protocol change.

   *Why the signal is trustworthy (command validation / MITM).* Every command the
   console sends is dual-signed (Ed25519 **and** SLH-DSA) and the plugin's
   `verify_command` (`includes/class-iwsl-verifier.php`) is the enforcement point:
   it re-canonicalizes with JCS, verifies both signatures, rejects a downgraded
   `alg`, and enforces TTL, `seq` monotonicity and single-use nonces before the
   command executes — so a machine-in-the-middle cannot forge, replay, downgrade,
   or tamper with a command. Symmetrically, the console verifies every response
   against the pinned WP-PK (`dispatchSignedCommand`) and quarantines the link on
   a bad signature. The version behind this badge inherits that guarantee: it is
   written only from a signature-verified response, so a MITM cannot spoof a
   matching version to hide an out-of-date (and possibly vulnerable) connector.
3. **Deferred project — `plugin.update`:** chunked push (§2-safe, cap-safe) +
   separate code-signing key + `Plugin_Upgrader` staging with sha256 verify,
   version-monotonic, and post-swap auto-rollback. Scope it against the §7 fleet-ops
   catalog (build phase 4), where `core.update`/backup ops already live — this
   belongs with that work, not ahead of it.
