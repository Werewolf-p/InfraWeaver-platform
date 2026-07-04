# InfraWeaver Connector (IWSL v1)

Client-side WordPress plugin for the InfraWeaver remote WordPress management
link. Spec: [`docs/infraweaver-wp-remote-management-design.md`](../../docs/infraweaver-wp-remote-management-design.md)
(FINAL v1.2). IW-side TS lib: [`apps/infraweaver-console/src/lib/iwsl/`](../infraweaver-console/src/lib/iwsl/).

**Invariant (§2):** a fully compromised WordPress site can never reach, act on,
or pivot into the InfraWeaver management plane. The plugin never initiates a
connection to IW — it only verifies dual-signed commands (Ed25519 +
SLH-DSA-192s, AND semantics) and answers with Ed25519-signed responses inside
the same HTTP exchange.

## What is implemented (build phases 1–2)

- **Protocol core:** RFC 8785 JCS canonicalization (integer-only wire profile),
  domain separation, dual signature verification — including **pure-PHP
  SLH-DSA-SHA2-192s verification** (`includes/class-iwsl-slhdsa.php`, SHA-2
  only, no FFI/WASM/sidecar, works on any host).
- **Fail-closed verifier (§12):** seq rollback, nonce replay, ±300s clock
  window, exp, alg downgrade-strip, kid epoch floor, method allow-list, param
  schemas. Every rejection maps to a §12.5 reason string.
- **Enrollment (§5/§5.1):** `.iwenroll` bundle upload (REST, admin-only) and
  `wp infraweaver enroll --file=…`; TOFU IW-PK pinning; passive
  `enroll-proof` document with HMAC-SHA-384 possession binding; automatic
  activation + secret burn on first verified command; bundle file shredded.
- **Rotation (§8 v1.2):** idempotent PREPARE/CONFIRM/ABORT keyed on
  rotation_id (lost-ack safe), monotonic epoch floor, kill switch
  (`site.deactivate` wipes all keys and state).

Fleet ops (`core.update`, backups, …) arrive with build phase 4 — the §7
catalog is deliberately NOT wired yet.

## REST surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /wp-json/infraweaver/v1/enroll-proof` | public while `pending`, 404 once active | §5 step 2 passive proof |
| `POST /wp-json/infraweaver/v1/enroll` | `manage_options` | manual bundle upload |
| `POST /wp-json/infraweaver/v1/command` | the dual signature IS the auth | signed command channel |

## WP-CLI

```
wp infraweaver enroll --file=/path/site.iwenroll
wp infraweaver status
wp infraweaver selftest
```

## Tests

Zero-dependency harness (no WordPress, no PHPUnit needed):

```
php tests/run-tests.php
```

Covers: TS↔PHP canonicalization parity, SLH-DSA verify against
`@noble/post-quantum` vectors, replay, seq rollback, downgrade-strip,
signature tamper, kid epochs, enrollment TOFU/TTL/tamper/shred, rotation
lost-ack idempotency + ratchet, full plugin flow incl. kill switch.

Fixtures are cross-language vectors signed by the IW TS lib. Regenerate after
protocol changes:

```
cd ../infraweaver-console
npm run iwsl:fixtures   # ~2 min — SLH-DSA-192s signing is slow by design
```

## Requirements

- PHP 7.4+ (64-bit), libsodium (PHP core since 7.2)
- No Composer dependencies, no PHP extensions beyond hash/json/sodium
