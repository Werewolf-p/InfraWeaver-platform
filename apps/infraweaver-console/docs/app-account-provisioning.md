# RBAC-driven local account provisioning (app-accounts)

Status: implemented (engine + Jellyfin adapter + tests). Two small edits to
RBAC-core files are required to wire it in — see **Required edits** at the end.

## The problem

Some apps InfraWeaver fronts only support SSO in their **web** UI. Jellyfin is the
motivating case: its native / TV clients (iOS, Android, tvOS, Roku, LG WebOS) and
its DLNA endpoints authenticate with a **local Jellyfin username + password**, not
OIDC. The Jellyfin `IngressRoute` therefore intentionally carries **no** Authentik
forward-auth (a browser redirect breaks every native client —
`kubernetes/catalog/jellyfin/manifests/ingressroute.yaml`).

Consequences:

- The WordPress / NAS model — reconcile an **Authentik access group** from RBAC
  (`lib/sso/access.ts`, `lib/nas/access.ts`) — cannot onboard native users, because
  those users never touch Authentik.
- "Granted Jellyfin in InfraWeaver" has to become a **real local account** in
  Jellyfin, created over its admin API, with a credential the user can actually use.

The owner asked for this to be **generic**, not a Jellyfin-only hack, and to propose
better approaches than the naive "email the password."

## What already exists (prior art this mirrors)

| Concern | Existing pattern | This design's analogue |
| --- | --- | --- |
| RBAC → desired app users (pure) | `addons/wordpress-manager/lib/access-policy.ts#computeSiteWordpressUsers`; `lib/nas/access-policy.ts` | `lib/app-accounts/policy.ts#computeDesiredAppUsers` |
| Materialize accounts in the app | `addons/wordpress-manager/lib/provision.ts#syncSiteWpUsers` | `lib/app-accounts/reconcile.ts#syncAppUsers` |
| Grant/revoke fan-out with retry | `lib/rbac-assignments.ts#reconcileWordpressAccessWithRetry` / `reconcileStorageAccessWithRetry` | `lib/jellyfin/access.ts#reconcileJellyfinAccessWithRetry` |
| App scope as first-class RBAC | `lib/nas/scope.ts`, `wordpress/sites/<site>` | scope `/jellyfin` |
| Secrets at rest | `lib/nas/store.ts` (OpenBao KV v2, console token) | `lib/app-accounts/store.ts` |
| CSPRNG password | `addons/wordpress-manager/lib/secrets.ts#generatePassword` | `lib/app-accounts/password.ts` |

## Chosen design

A small **app-agnostic capability** under `src/lib/app-accounts/`, with Jellyfin as
the first adapter under `src/lib/jellyfin/`:

```
lib/app-accounts/
  types.ts       AppAccountProvider + AccountNotifier + AppAccountStore contracts
  policy.ts      computeDesiredAppUsers(scope, permRead, permAdmin, users, groups)  [PURE]
  password.ts    generateAppPassword()  [PURE, CSPRNG]
  plan.ts        buildAppUserSyncPlan(desired, existing, managed, protected)  [PURE]
  reconcile.ts   syncAppUsers(provider, desired, {store, notifier})  [generic engine]
  store.ts       OpenBao-backed roster + per-user credentials
  notify.ts      consoleAccountNotifier (default delivery)
lib/jellyfin/
  config.ts      in-cluster URL, launch URL, service-account name, secret paths
  client.ts      thin typed Jellyfin REST client (verified vs the OpenAPI spec)
  provider.ts    JellyfinAccountProvider implements AppAccountProvider (+ bootstrap)
  access.ts      RBAC → provider wiring, scope, permissions, retry fan-out
```

**Why this shape:** everything app-specific is behind `AppAccountProvider` (six
methods). The pure policy/plan/password modules and the reconcile engine are the
same for every app. **A second app (Immich, Audiobookshelf) is one new file** —
another `provider.ts` + a three-line `access.ts` — not a fork of the engine. That is
the real deliverable; Jellyfin just proves it.

### Scope & role model

Jellyfin is a single instance, so it gets one top-level scope, `/jellyfin`, matching
the per-resource convention (`/wordpress/sites/<site>`, `/game-hub/servers/<s>`,
`/nas/...`). Grants inherit the usual way: a grant on `/jellyfin` or an ancestor
(`/` = platform owner) authorizes an account.

Two RBAC permissions gate it: `jellyfin:read` (has an account) and `jellyfin:admin`
(mapped to a Jellyfin administrator). Two built-in roles expose them:

- `jellyfin-user` → `[jellyfin:read]`
- `jellyfin-admin` → `[jellyfin:read, jellyfin:admin]`

The pure policy takes the permission **pair as parameters**, so it hardcodes nothing
app-specific — its tests exercise it with `nas:read`/`nas:write` to prove that.

### Secret model

Everything sensitive lives in OpenBao under `secret/platform/app-accounts/<app>/`,
read at request time with the console token (same mechanism as `lib/nas/store.ts`):

- `.../service-account` — the Jellyfin service admin's API key + admin credentials.
- `.../roster` — the list of accounts InfraWeaver provisioned (the "managed" set +
  "already notified" flag). This is what stops the reconcile from disabling a
  manual/app-native account and from re-emailing on a re-run.
- `.../users/<username>` — one per provisioned account: the generated password +
  email, so the console can **reveal** it for hand-off or reset it.

No credential is ever written to git, `users.yaml`, a manifest, or a log line.

### The service-account bootstrap

`JellyfinAccountProvider.ensureServiceAccount()` is idempotent and covers a fresh
cluster's two real states:

1. **First-run wizard not completed** → the console runs it
   (`POST /Startup/User` + `/Startup/Complete`), creating the "InfraWeaver service
   account" admin, then mints a persistent API key (`POST /Auth/Keys`). Hands-off.
2. **Wizard already completed by hand** → the console cannot self-mint a key, so it
   uses a one-time `JELLYFIN_BOOTSTRAP_TOKEN` (an existing admin API key) or
   previously-stored admin creds. Absent both, it throws a clear, actionable error
   rather than silently no-op'ing.

The API key is then cached and reused; a stored key is re-validated (`GET /System/Info`)
each bootstrap so a rotated/revoked key self-heals.

## The email story — and why *not* a plaintext emailed password

The naive reading of the request is "email the random password." Two findings and
three reasons steer away from it.

**Finding 1 — the platform has no first-party email sender.** There is **no**
`nodemailer`/SMTP dependency in the console (`grep` of `package.json` + `src`), and
no server-side mail helper. Authentik *is* configured to send its **own** templated
mail (recovery/invite) via `secret/platform/authentik` SMTP creds
(`kubernetes/platform/authentik/values.yaml` → `smtp-mail.outlook.com:587`), but
there is no API to make it send an arbitrary "here is your Jellyfin password" body.
So a plaintext-email design would require **inventing an SMTP client**, which the
brief explicitly says to flag rather than do silently.

**Finding 2 — Jellyfin has no invite / reset-link / must-change-on-first-login
flow.** Unlike the "better than a permanent password" options, Jellyfin core simply
has a local password an admin can set/reset; there is no link-based onboarding to
lean on. So a one-time-link design isn't available at the app layer either.

**Reasons a permanent emailed password is the wrong default:**

1. It sits in an inbox forever — the weakest link becomes the user's mailbox.
2. There is no transport to send it without new, unreviewed SMTP code.
3. It cannot be rotated or revoked from where it landed.

**Chosen approach — store-and-reveal, delivery behind a seam.** The reconcile:

- generates the password with `node:crypto` CSPRNG (`generateAppPassword`, rejection-
  sampled, unambiguous alphabet, never logged);
- persists it **per-user in OpenBao** so the console can reveal it to the admin for a
  secure out-of-band hand-off and can reset it on request; and
- calls an `AccountNotifier` **exactly once** per newly-created account. The default
  `consoleAccountNotifier` writes an audit line (WITHOUT the password) recording that
  a credential is ready for hand-off. Swapping in an SMTP- or Authentik-invitation-
  backed notifier is a new file wired at one call site — **no engine change** — and is
  where a real email (or, better, a one-time reveal link) would be sent.

**Store per-user vs fire-and-forget — tradeoff, and the pick.** Fire-and-forget
(email then forget) is only defensible when you *have* reliable email; we don't, and
the owner wants users to actually receive working credentials. So we **retain** the
credential in OpenBao. Cost: a standing secret at rest. Mitigations: OpenBao ACL
scoping, no logging, and the low blast radius of a Jellyfin local password (the NAS
mount is read-only — a Jellyfin compromise cannot alter media). This is the right
trade here; an operator who wants true fire-and-forget can supply an SMTP notifier
and have it `deleteCredential` after send.

## Failure / retry & idempotency semantics

- **Fan-out with retry.** A grant/revoke that changes `/jellyfin` (or `/`) triggers
  `reconcileJellyfinAccessWithRetry` (backoff `[1s, 5s, 15s]`, then a loud
  `console.error`) — the same discipline as `reconcileStorageAccessWithRetry`,
  because a **revoke** that silently failed would leave a user still able to log in.
- **Idempotency.** `buildAppUserSyncPlan` only *creates* accounts that don't exist,
  so a re-run with unchanged grants creates nothing, resets no password, and (since
  notify happens only on create) **emails no one again**. Covered by tests.
- **Revocation = disable, not delete.** A revoked user's account is disabled
  (`IsDisabled`) and its roster entry + credential retained, so a re-grant re-enables
  the *same* account with no password churn and no second notification. Deletion is
  available as an explicit admin/teardown action, not a side effect of a sync.
- **Ordering.** Creations/enables/role-changes run before disables, so a mid-run
  failure never locks out a still-authorized user while a soon-to-be-revoked one
  lingers — the revoke just retries next pass.
- **Crash window.** If `createUser` succeeds but the roster write fails, the next run
  sees the account exists (won't re-create, won't re-notify) but not "managed" (won't
  auto-disable). At-least-once account creation, never a duplicate; the small "not
  auto-revocable until re-adopted" gap is documented and acceptable.

## What is NOT covered (out of scope / follow-ups)

- **No real email is sent** by the default notifier (see the email story). Providing
  an SMTP/Authentik-invite notifier is the obvious next step; the seam exists.
- **No console UI** for the Jellyfin access panel / credential reveal in this change.
  `readAppAccountCredential` + `syncJellyfinUsers` are the server primitives a
  `/api/jellyfin/access` route + panel would call (mirrors `/api/nas/access`).
- **No API route** wired yet — grant/revoke fan-out is via the reported
  `rbac-assignments.ts` edit; a manual "sync now" route is a small follow-up.
- **Jellyfin ↔ OIDC linking.** When a native user *later* signs in via the web SSO,
  linking the local account to the Authentik identity is a Jellyfin-plugin concern,
  not handled here.
- **Password-strength/lockout policy** in Jellyfin (`LoginAttemptsBeforeLockout`) is
  left at Jellyfin defaults.

## Required edits (RBAC-core files I was asked not to touch)

Everything above is in **new** files. Wiring it in needs three minimal edits, kept
out of this change to avoid conflicting with concurrent work:

1. **`src/lib/rbac.ts`** — add the permissions and roles (see report / below).
2. **`src/lib/rbac-assignments.ts`** — call a Jellyfin fan-out inside
   `syncAccessForScope`.
3. **`kubernetes/.../bootstrap-openbao.sh`** (infra) — grant the console token
   CRUD on `secret/data/platform/app-accounts/*`.
