# InfraWeaver Remote WordPress Management — Security Architecture & Design

**Status:** FINAL v1.2 · **Date:** 2026-07-04
**Protocol name:** IWSL — *InfraWeaver Site Link* (v1)
**Locked decisions:** Hybrid PQC command signing (Ed25519 + SLH-DSA-192s, AND semantics) · responses Ed25519-only · app-layer hybrid KEM (X25519 + ML-KEM-768) for secret-bearing params in phase 1 · IW-initiates-only transport · one-time challenge/response enrollment

> This is the design/threat-model gate for the implementation. It defines the trust
> model, the enrollment ("download cert → upload → auto-add") flow, the signed
> message protocol, key lifecycle, and the WordPress-side PQC reality.
>
> **v1.2 (2026-07-04):** §14 item 5 ACCEPTED with SLH-DSA-**192s** (operator chose
> category 3 over the recommended 128s) and phase-1 app-layer KEM for secret-bearing
> params. Doc marked FINAL. Build phases 1–2 implemented:
> `apps/infraweaver-console/src/lib/iwsl/` (IW TS lib) and
> `apps/infraweaver-wp-connector/` (Connector plugin + pure-PHP SLH-DSA verify).

---

## 1. Goal

Turn the InfraWeaver WordPress addon into a **remote fleet manager** rivaling
WP Umbrella / MainWP (maintenance, backups, uptime, security scans, updates) and
WHMCS (provisioning, plans, suspend/clone/migrate) — for **any** WordPress site,
not just in-cluster pods.

Mechanism: a **client-side WordPress plugin** ("InfraWeaver Connector") that the
InfraWeaver addon drives over a signed, IW-initiated channel.

### 1.1 Non-goals
- WP plugin is **not** a generic RPC/RCE surface. It exposes only allow-listed ops.
- No agent-to-agent mesh, no WP→WP, no WP→other-tenant.
- Not replacing the existing in-cluster wp-cli path — this **extends** to remote/external sites.

---

## 2. The one invariant everything serves

> **A fully compromised WordPress site can never reach, act on, or pivot into the
> InfraWeaver management plane. Management flows one way: addon → site. Never the reverse.**

This is enforced by **capability asymmetry**, not by trust:

| | Holds | Can do | Cannot do |
|---|---|---|---|
| **InfraWeaver addon (IW)** | `IW-SK` (private signing key), every site's `WP-PK` | Sign & issue commands to sites; verify site responses | — |
| **WordPress plugin (WP)** | `WP-SK` (its own private key), pinned `IW-PK` | Verify IW commands, execute allow-listed ops, sign responses | **Initiate to IW · forge IW commands · run arbitrary code over the wire · reach mgmt plane** |

Even with **root on the WordPress box**, an attacker gets `WP-SK` + `IW-PK`. That
buys them: the ability to sign *responses* (which IW treats as untrusted data) and
to read commands IW already sent. It buys them **nothing** toward IW: no IW private
key, no standing outbound credential, no network path.

---

## 3. Architecture

```
                        ┌─────────────────────────────────────────┐
                        │        InfraWeaver control plane         │
                        │                                          │
   operator ──console──►│  WP Addon UI ──► Signer service ──┐      │
                        │   (Next.js)      (isolated, holds │      │
                        │                   IW-SK in OpenBao)│      │
                        │                                    │      │
                        └────────────────────────────────────┼─────┘
                                                              │
                             (1) IW ALWAYS initiates          │  outbound only
                                 signed commands              ▼
                        ┌─────────────────────────────────────────┐
                        │   Remote WordPress site (untrusted)      │
                        │                                          │
                        │   InfraWeaver Connector plugin           │
                        │    • verify IW-PK (Ed25519 + SLH-DSA)    │
                        │    • execute allow-listed op             │
                        │    • sign result with WP-SK              │
                        │   REST: /wp-json/infraweaver/v1/*        │
                        └─────────────────────────────────────────┘

   WP → IW connections: NONE (ever). Responses ride back only inside the HTTP
   response to a request IW made. No inbound path from WP into the control plane.
```

Key isolation on the IW side: signing happens in a **dedicated signer service**,
not the console web process. If the console is XSS'd/SSRF'd, `IW-SK` is still not
in its address space. `IW-SK` lives in **OpenBao** (already deployed).

---

## 4. Identities & key material

IW holds a **dual keypair** (classical + post-quantum); the site holds a classical
one (v1.2 — responses are Ed25519-only, see §10/§14.5):

| Key | Algorithms | Where it lives |
|---|---|---|
| `IW-SK` | Ed25519 + SLH-DSA-192s secret keys | OpenBao, released only to signer service |
| `IW-PK` | Ed25519 + SLH-DSA-192s public keys | Pinned in every plugin at enrollment (trust anchor) |
| `WP-SK` | Ed25519 secret key | Generated on the site, never leaves it |
| `WP-PK` | Ed25519 public key | Stored per-site in IW DB/vault |

- **Ed25519** = FIPS-adjacent, universally available in PHP (libsodium, core since 7.2) and Node.
- **SLH-DSA-192s** = FIPS 205 (hash-based SPHINCS+), NIST security category 3 — the
  post-quantum layer on **commands**. Verification is pure SHA-2, implementable in
  plain PHP on any host. Signatures are 16 224 bytes — fine over HTTP.
- On commands both signatures are **required (AND semantics)**: to forge a command an
  attacker must break *both* primitives. Classical break alone ≠ forgery; PQ break
  alone ≠ forgery.
- Responses are Ed25519-only: IW treats response payloads as untrusted data
  regardless (§2), so PQ on responses buys nothing (§10).

Per-site `IW-SK` vs single cluster key: **single IW keypair per InfraWeaver
cluster**, rotated on schedule. Per-site `WP` keypairs (one per site) so revoking
one site never touches others.

---

## 5. Enrollment — "download cert → upload → auto-add" (IW-initiated, one-time)

The whole flow keeps IW as the initiator and leaves **zero standing WP→IW path**.
The only WP→IW step in existence is a *passive signed document IW pulls*.

```
(1) Operator clicks "Add external site" in IW console.
    IW creates site record (state=pending) and generates an ENROLLMENT BUNDLE:
      • IW-PK  (Ed25519 + PQ public keys)            ← the trust anchor to pin
      • enroll_secret (256-bit random, single-use, TTL 15m)  ← possession-proof key
      • site_id, expected callback origin, required-PQ policy flag
      • bundle_sig  = Sign_IW-SK( all of the above )
    File:  infraweaver-enroll-<site_id>.iwenroll   (operator downloads it)
    Bundle is SENSITIVE while valid (contains enroll_secret) — 15m TTL, single use.

(2) Operator uploads the .iwenroll file into the Connector plugin.
    Plugin:
      • verifies bundle_sig against the IW-PK inside it   (TOFU: first upload PINS IW-PK)
      • generates WP-SK / WP-PK locally  (WP-SK never leaves the box)
      • PUBLISHES a passive proof document at:
          GET /wp-json/infraweaver/v1/enroll-proof
          { site_id, WP-PK, ts,
            binding   = HMAC-SHA-384(enroll_secret, "IWSL-enroll-v1" || site_id || WP-PK),
            proof_sig = Sign_WP-SK(...) }
      • enroll_secret itself is NEVER published — only the HMAC binding.
        (v1.0 published the raw nonce: anyone reading the public endpoint could lift
         it, and a MITM on the verify-pull could substitute their own WP-PK and pass
         the "self-consistent" check. FIXED: binding now requires bundle possession.)

(3) Operator clicks "Verify" in IW console (or IW polls the URL it already knows).
    IW  ── GET enroll-proof ──►  site        [IW INITIATES — WP never calls IW]
      • recomputes binding with its stored enroll_secret → proves this WP-PK came
        from the party holding the bundle, not from a MITM or endpoint reader
      • verifies proof_sig with WP-PK
      • stores WP-PK bound to site_id, marks site ACTIVE, burns enroll_secret both sides
      • console AND plugin display both key fingerprints; operator visually compares
        before first command is allowed (mandatory under strict-PQ policy)

(4) Plugin REMOVES the enroll-proof endpoint once ACTIVE
    (kills fingerprinting + residual attack surface).

Result: mutual key pinning, MITM-resistant binding. Plugin never POST'd anything to IW.
```

**Air-gapped / NAT'd fallback:** if IW can't reach the site's URL, the plugin
shows the `enroll-proof` string; operator copy-pastes it into the IW console. Still
no WP→IW socket. Same cryptographic outcome.

**Stolen bundle:** contains `enroll_secret`, so treat the file as sensitive for its
15-minute life. Even holding it, a rogue enrollment still requires IW to fetch an
attacker-controlled URL — which requires the operator to have registered that URL —
and the step-(3) fingerprint comparison catches the residual case. No silent takeover.

### 5.1 Automated enrollment — IW-provisioned sites & terminal setup (v1.2)

For WordPress sites InfraWeaver deploys itself (WP Manager addon), enrollment is
automated. **Automation changes bundle TRANSPORT only** — crypto, binding, proof and
activation are byte-identical to manual enrollment. One code path, one audit
surface, no second weaker flow.

- Deploy flow gains option **"Install InfraWeaver Connector"** — **default ON** for
  IW-provisioned sites.
- Provisioner bundles the Connector plugin into the site image/manifest and delivers
  the `.iwenroll` bundle out-of-band of the web tier: mounted k8s Secret file
  outside the webroot (cluster sites) or written over SSH (init-VM / VPS sites).
- Activation hook / WP-CLI consumes it once, then shreds the file:

      wp infraweaver enroll --file=/path/site.iwenroll

  then the standard §5 flow runs (pin IW-PK, generate keys, publish proof, IW
  pulls, ACTIVE).
- The same WP-CLI command **is** the terminal setup path for external sites:
  operator SCPs the bundle to any VPS, runs one command — no wp-admin upload.
- Fingerprint comparison (§5 step 3): **auto-confirmed for IW-provisioned cluster
  sites** — IW controls both endpoints at provisioning time, no MITM window exists.
  Stays mandatory-manual for external/remote enrollments.

---

## 6. Message protocol (IWSL v1)

### 6.1 Command envelope (IW → WP)

```jsonc
{
  "v": 1,
  "typ": "cmd",
  "site_id": "9f2c…",
  "nonce": "<128-bit random, base64url>",
  "seq": 4102,                  // strictly increasing per site — see §6.3
  "kid": 3,                     // key epoch — which keypair signed this (see §8)
  "ts": 1751600000000,          // unix ms
  "exp": 1751600060000,         // ts + 60s
  "method": "core.update",       // allow-listed op (see §7)
  "params": { /* structured, schema-validated */ },
  "alg": ["ed25519", "slh-dsa-192s"]
}
```

- Canonicalize with **RFC 8785 JCS** (or deterministic CBOR) → `canon`.
  (Implementation restriction: all numbers MUST be integers — no floats on the wire —
  so the JS and PHP canonicalizers can never diverge on ES number formatting.)
- Domain-separate: `msg = "IWSL-v1-cmd" || 0x00 || canon`.
- Attach **two** detached signatures over `msg`:
  `sig_ed25519 = Sign_IW-SK.ed25519(msg)`, `sig_slhdsa = Sign_IW-SK.slhdsa(msg)`.
- Plugin verifies **both** against pinned `IW-PK`. Either fails → reject.
- Domain tag `IWSL-v1-resp` for responses prevents a command being replayed as a
  response and vice versa (cross-protocol confusion).

### 6.2 Response envelope (WP → IW) — only as reply to a command

```jsonc
{
  "v": 1, "typ": "resp",
  "site_id": "9f2c…",
  "in_reply_to": "<nonce of the command>",   // binds response to request
  "ts": …, "ok": true,
  "result": { /* size-bounded, schema-validated by IW */ },
  "alg": ["ed25519"]
}
```

- Signed by `WP-SK` (Ed25519 — v1.2, responses are classical-only per §10/§14.5),
  domain tag `IWSL-v1-resp`.
- IW verifies the signature against stored `WP-PK`, checks `in_reply_to` matches an
  outstanding command nonce, then **treats `result` as untrusted data**:
  strict schema, byte ceiling, no eval, never used as control input for other tenants.

### 6.3 Freshness & replay protection
- **Sequence counter (primary defense):** every command carries `seq`, strictly
  increasing per site, issued by the signer. Plugin persists `last_seq` in the DB and
  rejects `seq ≤ last_seq`. Survives restarts and cache flushes, and gives command
  ordering for free. (v1.0 relied on the nonce cache alone — a wiped cache silently
  reopened the replay window. FIXED.)
- **Nonce cache** (second layer): accepted nonces stored in the **DB** (not object
  cache) until `exp`; duplicate → reject.
- **Timestamp window**: reject if `ts` outside ±300s of local clock. (v1.0 said
  ±30s — unrealistic on shared hosting without guaranteed NTP; `seq` + nonce carry
  the replay defense, the window only bounds cache size and staleness.)
- **exp**: hard expiry, default 120s after `ts`.
- **Downgrade defense**: commands are ALWAYS dual-signed — `alg` on a command must
  contain both `ed25519` and `slh-dsa-192s`, and both signatures must verify; a
  command missing the PQ signature is rejected. An attacker can't strip the PQ
  layer. (v1.2: capability negotiation removed — pure-PHP SLH-DSA verification works
  on every host, so PQ-on-commands is unconditional.)

---

## 7. Capability catalog (what IW can tell WP to do)

The plugin exposes **only** these structured, allow-listed methods. There is **no**
`exec`, no raw SQL, no arbitrary wp-cli passthrough over the wire — that would make a
leaked `IW-SK` an instant fleet-wide RCE. Everything is a typed operation.

| Domain | Methods (illustrative) | Parity with |
|---|---|---|
| **Maintenance** | `core.update`, `plugin.update`, `theme.update`, `plugin.toggle`, `health.check`, `php.errorlog.tail`, `db.optimize` | WP Umbrella / MainWP |
| **Backups** | `backup.run`, `backup.list`, `backup.restore`, off-site to IW storage (Longhorn/S3) | WP Umbrella |
| **Security** | `scan.integrity`, `scan.malware`, `harden.apply`, `edit.disable`, `2fa.force`, `waf.sync` (ties to existing AppFirewallPanel) | WP Squared |
| **Provisioning** | `site.clone`, `site.stage`, `site.suspend`, `site.migrate`, `plan.apply`, `quota.set` | WHMCS |
| **Users / access** | `user.upsert`, `user.role`, `sso.oidc.push` (extends per-site Authentik) | InfraWeaver RBAC → WP users |
| **Telemetry** | `uptime.ping`, `metrics.pull`, `version.report` | WP Umbrella |

**Backup data path (explicit invariant carve-out — v1.1):** `backup.run` must NOT
have the plugin push to management-plane storage; v1.0 left this ambiguous, which
was a hidden WP→IW path. Fix: the signed command carries a **single-use, write-only
presigned PUT URL** to **quarantined object storage** — separate bucket, separate
credentials, no read/list, network-segmented from the control plane. Strict-mode
alternative: IW pulls the archive in chunks over the command channel. Either way the
site gains zero standing capability, and restore tooling treats archives as hostile
input.

**Break-glass advanced ops** (if ever needed): gate any powerful/free-form op behind
a **second signature** requiring live operator MFA at command time, logged
immutably. Off by default.

---

## 8. Key lifecycle

- **IW-PK rotation:** IW sends a signed `key.rotate` command containing the new
  `IW-PK`, signed by the **current** `IW-SK`. Plugin verifies with the pinned key,
  then re-pins. Emergency (old key lost): operator re-uploads a fresh `.iwenroll`.
- **WP-SK rotation (key continuity — v1.1):** IW commands `key.rotate.self`; plugin
  generates a new keypair and returns the new `WP-PK` **inside the signed response,
  signed by the OLD `WP-SK`**. IW verifies the old-key signature, then re-pins.
  (v1.0 re-used the enrollment proof pull — an unauthenticated re-binding window on
  every rotation. FIXED: no endpoint, no window, cryptographic chain of custody.)
- **Automatic scheduled rotation (v1.2):** IW-driven, interval-based (default 30d),
  both key families. Modeled on how mature protocols rotate (DNSSEC pre-publish
  rollover RFC 6781, WireGuard soft/hard rekey timers, kubelet cert rotation, JWKS
  `kid` key sets, OpenBao key rings): **overlap + verify + ratchet forward — never
  an atomic swap, never rollback past a commit.**
  1. **PREPARE** — IW issues the rotate command; the rotating side generates its new
     pair locally and returns the new public key signed by the old key. Both sides
     now hold old+new valid; every envelope carries `kid` (epoch). Normal ops
     CONTINUE under the old key — rotation never blocks operations.
  2. **VERIFY (ping)** — IW sends `health.check` signed under the NEW key. A valid
     round-trip under the new epoch in both directions = end-to-end proof. Retries
     with exponential backoff inside a bounded window (default 72h).
  3. **CONFIRM + RETIRE** — on verify success both sides retire the old epoch. The
     epoch floor is monotonic (same idea as `seq`): once confirmed, any older `kid`
     is rejected forever. Max 2 epochs live at once.
  4. **ABORT (not rollback)** — verify window expires unconfirmed → discard the NEW
     key, keep operating on the old one (it was never invalidated), alarm console.
     Aborting an uncommitted rotation is safe; rolling back a committed one is a
     downgrade-attack vector, so it does not exist in the protocol.
  Site offline at PREPARE → no state change, retry next interval. N consecutive
  failed cycles → escalated alarm (possible tampering, not just downtime).
  **Compromise-driven rotation is a separate path:** old key suspect → no
  abort-to-old; if verify fails the site goes QUARANTINED and requires operator
  re-enrollment. Private keys NEVER travel in either flow.
- **Revocation:** IW marks site revoked and stops issuing. Plugin **kill switch**:
  on signed `site.deactivate` it wipes `WP-SK`, `IW-PK`, and local state. Operator
  can also disable locally in wp-admin.
- **Compromise response:** suspected site compromise → IW rotates that site's binding
  and, out of caution, rotates cluster `IW-SK` if the command stream may have leaked
  plaintext ops worth replaying (they can't be replayed — nonce/exp — but rotate anyway).

---

## 9. Key storage

- **IW side:** `IW-SK` in **OpenBao**, released only to the isolated signer service
  (short-lived lease). `WP-PK`s in IW DB/vault, per-site. Console never touches `IW-SK`.
  The signer **enforces policy itself** — op allow-list, per-site rate limits, `seq`
  issuance, MFA gate for break-glass — treating the console as an untrusted
  requester. Console compromise ≠ arbitrary signing.
- **WP side:** `WP-SK` stored **outside webroot**, referenced from `wp-config.php`,
  file mode `0600`, ideally sealed with a libsodium secretbox keyed from a
  `wp-config` constant. This is *best effort* — WP compromise reads it, and that's
  fine per §2: `WP-SK` can only sign responses.

---

## 10. Post-quantum in PHP — RESOLVED (v1.2)

The v1.0/v1.1 build risk was "no mature pure-PHP ML-DSA library", which forced a
liboqs-FFI / WASM / sidecar option matrix plus per-site capability negotiation.
**v1.2 removes the problem instead of solving it** (§14 item 5, ACCEPTED):

- **Where PQ actually matters is asymmetric.** Forging *commands* = site control;
  forging *responses* gains ~nothing (IW already treats responses as untrusted
  data, §2). Therefore: **commands MUST be dual-signed; responses are
  Ed25519-only** — no weakening of the invariant.
- That removes PQ *signing* from PHP entirely — WP only needs PQ *verification*.
- The PQ layer is **SLH-DSA-192s (FIPS 205, hash-based SPHINCS+, SHA2 family,
  NIST category 3 — parity with the ML-DSA-65 it replaces).** Verification is pure
  SHA-2 — implemented in plain PHP in the Connector, works on every host: no FFI,
  no WASM, no sidecar, **no capability negotiation**. Strict-PQ is enrollable on
  shared hosting.
- Cost: 16 224-byte PQ signatures (fine over HTTP) and slow signing on the IW side
  — Node handles it (`@noble/post-quantum` `slh_dsa_sha2_192s`); the plugin never
  signs PQ.

**IW / Node side.** `@noble/post-quantum` provides audited pure-JS `slh_dsa` and
`ml_kem`. Ed25519 via `@noble/curves`. No native deps.

**WP / PHP side.** Ed25519 verify/sign via libsodium (PHP core since 7.2).
SLH-DSA-SHA2-192s verify in pure PHP (`class-iwsl-slhdsa.php`) — SHA-256/SHA-512
only, cross-checked against `@noble/post-quantum` fixtures.

**Payload confidentiality (PQ KEM) — phase 1 for secret-bearing params (v1.2).**
Commands ride TLS already; modern TLS may negotiate hybrid `X25519MLKEM768` at the
transport layer. But a TLS-terminating proxy/CDN (§11) reads plaintext at the edge,
so secret-bearing `params` (`user.upsert` credentials, tokens) get app-layer hybrid
KEM encryption (`X25519` + `ML-KEM-768`, both in `@noble/post-quantum`; X25519 via
libsodium + pure-PHP ML-KEM decapsulation on the WP side). This ships **before any
secret-bearing op goes live** — it gates phase 4's `user.upsert`-class ops, not an
optional phase-2 nicety.

---

## 11. Threat model

| Scenario | Attacker gains | Blocked by |
|---|---|---|
| **WP site fully compromised (RCE/root)** | `WP-SK`, pinned `IW-PK`, local data | Can only sign *responses* (IW = untrusted data); no `IW-SK`, no WP→IW path, no mgmt-plane network route. **Invariant holds.** |
| **Man-in-the-middle on the wire** | ciphertext | TLS + dual app-layer signatures; can't forge without both keys; replay blocked by nonce/exp |
| **Replay of a captured command** | old signed command | Nonce cache + timestamp window + exp |
| **Downgrade (strip SLH-DSA)** | — | commands unconditionally dual-signed; missing/invalid PQ sig rejected (§6.3) |
| **Stolen enrollment bundle** | `IW-PK` (public) + one-time nonce | Rogue enroll needs IW to fetch attacker URL = operator action; nonce single-use, 15m TTL |
| **IW addon / signer compromised** | ability to command the fleet | *Expected* — IW **is** the management plane. Mitigations: allow-listed ops (no RCE), signer isolated from console, MFA-gated break-glass, immutable audit log, `IW-SK` in OpenBao |
| **Rogue site tries to attack IW via responses** | crafted `result` payloads | IW schema-validates, byte-caps, never eval's, never cross-tenant; console **escapes all site-supplied strings at render** (log tails, plugin names, metrics = stored-XSS vectors) |
| **TLS-terminating proxy/CDN reads traffic (e.g. Cloudflare-proxied site)** | command params + results in plaintext at the edge | App-layer hybrid encryption of `params`/`result` for secret-bearing ops (`user.upsert`, credentials) — **phase 1 for those ops**, not phase 2 |

**Residual risk:** compromise of the IW signer service is the crown-jewel event.
Contain it (isolation, OpenBao leases, MFA break-glass, audit) but accept it's the
top of the trust hierarchy by design.

**Honesty note (v1.1):** the op allow-list does **not** neuter an `IW-SK` leak —
`user.upsert` with an admin role is effectively fleet-wide site takeover. Hence:
signer-side policy enforcement (above), **plugin-side per-op rate limits** (e.g. max
N `user.upsert`/hour), and the plugin **emails the site admin on sensitive ops** —
an independent detection channel the attacker cannot silence from the IW side.
Optional two-man rule for tier-3 ops.

---

## 12. Fail-closed matrix

| Condition | Behavior |
|---|---|
| Either signature invalid | Reject, log, rate-limit; temp-lock after N failures |
| `seq` ≤ last persisted `seq` | Reject (replay/rollback) |
| Nonce seen before | Reject (replay) |
| `ts`/`exp` outside window | Reject (clock/NTP) |
| Enrollment nonce expired/used | Reject; require re-issue |
| PQ required but absent | Reject |
| Unknown/omitted `method` | Reject (allow-list) |
| `params` fails schema | Reject before execution |

Default posture everywhere: **deny**.

## 12.5 Observability & diagnostics (v1.2)

Both planes must answer at a glance: *is the link healthy — and if not, exactly why.*

**Plugin side (wp-admin status panel + WP-CLI):**
- Status: enrollment state (pending / active / quarantined), pinned IW-PK
  fingerprint, own WP-PK fingerprint, current `kid`, `last_seq`, PQ algorithm
  (`slh-dsa-192s`), rotation phase (idle / prepare / verify-window).
- Last accepted command (method, ts, outcome) and last **rejected** command with the
  exact reason: `bad-sig-ed25519` / `bad-sig-pq` / `seq-rollback` / `stale-ts` /
  `expired` / `replayed-nonce` / `unknown-method` / `schema-fail` — reasons map 1:1
  to the §12 fail-closed matrix, so every deny is explainable.
- Measured clock skew vs IW `ts` — the #1 real-world failure cause; surfaced loudly.
- Local append-only command log, DB-backed, size-capped (default 1 000 rows),
  params redacted for secret-bearing ops.
- WP-CLI: `wp infraweaver status` · `wp infraweaver log --tail N` ·
  `wp infraweaver selftest` (keys present, local sign/verify round-trip, DB tables,
  clock sanity, endpoint reachable).
- Debug mode: `define('IW_CONNECTOR_DEBUG', true)` → verbose logging. NEVER logs key
  material, `enroll_secret`, or secret-bearing params — debug included.

**Console side (per-site + fleet):**
- Per-site card: link state (last successful round-trip), RTT, response signature
  verdict, remote clock skew, `kid`/`seq`, rotation phase, counters for signature
  failures / rejections.
- Immutable per-site command history: every issued command, response verdict,
  latency, result summary (site strings escaped — §11).
- Fleet dashboard: green / yellow / red per site.
- `link.diag` allow-listed op: full signed round-trip returning plugin diagnostics
  (plugin/WP/PHP versions, clock, `seq`, `kid`, capability flags) — the ping with
  receipts.
- Alerts: invalid-signature spike (probing), `seq`-rollback attempts (replay),
  clock skew over threshold, rotation aborted, site silent longer than interval.

Security note: everything the plugin logs is readable by whoever owns the site — by
design it contains nothing secret. Key material and enrollment secrets never hit any
log on either side.

---

## 13. Build phases (for the follow-up implementation prompt)

1. **Protocol core (shared):** envelope schema, JCS canonicalization, dual-sign /
   dual-verify, domain separation, nonce/exp — as a small TS lib (IW) + PHP lib
   (plugin, incl. pure-PHP SLH-DSA-192s verification). **[DONE v1.2]**
2. **Enrollment:** IW bundle generator + console "Add external site" UI; plugin
   upload handler + `enroll-proof` endpoint; IW verify-pull + `WP-PK` pinning;
   §5.1 `wp infraweaver enroll` automated path. **[DONE v1.2 — lib + plugin flows;
   console UI wiring lands with phase 4 dispatch]**
3. **Signer service:** isolated IW service, `IW-SK` from OpenBao, both algorithms.
4. **Command dispatch + first ops:** `health.check`, `version.report`, `core.update`,
   `plugin.update`, `backup.run` (thin vertical slice end-to-end).
5. **App-layer hybrid KEM** (X25519 + ML-KEM-768) for secret-bearing `params` —
   encrypt in signer, pure-PHP decapsulation in plugin. **Gates phase 4's
   secret-bearing ops (§10) — must ship before `user.upsert`-class commands.**
6. **Catalog fill-out:** remaining maintenance/security/provisioning ops.
7. **Lifecycle:** rotation, revocation, kill switch, audit log.
8. **Hardening + tests:** replay/downgrade/fuzz tests, threat-model regression suite.
9. **Provisioning integration + observability:** auto-install/enroll in the IW
   WordPress deploy flow (§5.1); status panels, rejection log, selftest,
   `link.diag`, alerts (§12.5). Minimum diagnostics (status + rejection reasons)
   ship WITH phase 4, not last — you debug the link while building it.

---

## 14. Open decisions for the operator

1. **PQ enrollment policy default** — strict-PQ (refuse PQ-incapable hosts) vs
   hybrid-preferred? Recommend **strict-PQ** for sites you host, hybrid-preferred for
   customer-owned shared hosting. *(v1.2: largely moot after item 5 — pure-PHP
   SLH-DSA verification makes every host PQ-capable for command verify; strict-PQ is
   the effective default everywhere.)*
2. **Site reachability** — will IW be able to reach remote sites for the enroll-proof
   pull and for command delivery, or do you need the NAT'd copy-paste fallback as a
   first-class path? (Affects whether you also need an outbound-only relay later.)
3. **Break-glass ops** — do you want a gated free-form op at all, or keep the plugin
   strictly allow-listed forever? Recommend **strictly allow-listed**.
4. **Multi-tenancy of `IW-SK`** — one cluster key (simpler) vs per-customer signing
   keys (blast-radius isolation if you resell). Recommend **one cluster key** to start.
5. **✅ ACCEPTED (v1.2, 2026-07-04) — PQ layer = SLH-DSA on commands, none on
   responses, with operator modifications:**
   - **SLH-DSA-192s, not 128s** — NIST security category 3, parity with the
     ML-DSA-65 level it replaces. Cost accepted: 16 224-byte signatures (vs 7 856
     for 128s) and slower IW-side signing (Node, `@noble/post-quantum`
     `slh_dsa_sha2_192s`; plugin only verifies — pure SHA-2, plain PHP).
   - **Responses Ed25519-only** (untrusted data regardless — §2/§10). `WP-SK`
     becomes a single Ed25519 keypair.
   - **App-layer hybrid KEM (X25519 + ML-KEM-768) for secret-bearing params is
     phase 1**, not deferred — it gates any secret-bearing op going live (§10, §13
     item 5).
   - Effect: liboqs-FFI/WASM/sidecar dependency and §10 capability negotiation
     deleted; strict-PQ enrollable on shared hosting; item 1 above effectively moot.
