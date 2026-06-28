# WordPress Manager — addon design

Status: building. This addon lives entirely under `src/addons/wordpress-manager/`.
The intent is that nothing in core needs to change for it to exist or for the next
addon after it — it declares its own permissions, its own pages, its own routes,
and carries its own provisioning logic. Where core genuinely lacked a generic
seam, the design notes it and prefers building the seam once over hardcoding
WordPress into core.

## What it does, in one breath

You give it a site name. It generates every secret — database name, user,
password, the eight WordPress auth salts, the admin password — writes them to the
vault, brings up a WordPress pod and its own MariaDB pod with PVCs, wires a
Cloudflare DNS record and a Traefik IngressRoute with TLS, and hands you a working
site. From there a plugin manager lets you pick what's installed, including an
Authentik SSO plugin that provisions an OIDC provider and application in Authentik
and configures WordPress to log in through it — no manual copying of client IDs.

The person never types a password and never sees one unless they ask the vault.

## Why secrets are generated, never asked

Asking a human to choose a database password is how weak passwords and reused
passwords get into a system. Every credential here is `crypto.randomBytes` at
provisioning time, written to OpenBao under a deterministic path, and surfaced to
the pods only as Kubernetes Secret references — never baked into a manifest, never
logged, never returned over the API in full. The vault is the source of truth; the
k8s Secret is a projection the addon can rebuild from it.

Vault layout, one site per tree:

    secret/wordpress/<site>/db          db root + app password, user, database name
    secret/wordpress/<site>/wp          the eight WP salts + admin password
    secret/wordpress/<site>/authentik   OIDC client id + secret, issuer

## How a site is shaped on the cluster

Everything is built by pure functions in `lib/manifest.ts` so the shape is
unit-tested without a cluster. One site is: a MariaDB Deployment + Service + PVC,
a WordPress Deployment + Service + PVC, an IngressRoute, and a DNS record. All of
it is labelled `infraweaver/wordpress: "true"` and `infraweaver.io/site: <name>`
so the addon owns a clean, selectable slice of the namespace and nothing else.
WordPress reads its DB credentials and salts from Secret references, so rotating a
secret in the vault and re-projecting the Secret is the whole rotation story.

The IngressRoute optionally carries the `forward-auth` middleware. WordPress's own
Authentik SSO is application-level OIDC; the edge forward-auth is a separate,
coarser gate you can layer on for non-public sites. They compose.

## RBAC — access maps to the site, and the owner is always in

Permissions are declared in `addon.manifest.ts` (`wordpress:read`,
`wordpress:write`, `wordpress:admin`) with `scopePrefix: /wordpress/`, exactly the
shape game-hub uses. Per-site scopes are `/wordpress/sites/<name>`, so you can give
someone write on one site and nothing on the others. The platform owner (`*` /
admin) always passes — that check is the existing core one, reused, so there is no
way to lock the owner out and no manual grant needed for them.

Core's `Permission` type is a closed union with a compile-time exhaustiveness
guard, so the addon does not widen it. Instead `lib/wordpress-rbac.ts` is a thin
adapter: it evaluates WordPress permission strings through the same underlying
string-based permission engine, casting at the addon boundary. Core is untouched;
the permission still resolves through real role assignments.

## Plugin manager and Authentik SSO

`lib/plugins.ts` holds a catalog (security, caching, SEO, and the Authentik SSO
plugin) and builds the `wp-cli` commands to install, activate, or remove plugins
inside the running pod. A desired-vs-installed diff drives a converge: pick what
you want, the manager installs the delta and removes what you deselected, gated by
`wordpress:write` (owner always allowed), and it can reconcile on read so drift
self-heals.

The Authentik path is the interesting one. `lib/authentik.ts` builds the OIDC
provider + application as an Authentik blueprint (and the equivalent API calls),
mints a client id/secret into the vault, and builds the `wp-cli` option updates
that point the `openid-connect-generic` plugin at the Authentik issuer with that
client. Turning on SSO is one action that provisions both sides.

## What needs a live cluster to finish

The pure core — manifest shapes, secret generation, plugin diffs, Authentik
blueprint shapes, RBAC scoping — is built and unit-tested here. The orchestration
in `lib/provision.ts` (talking to the live k8s API, OpenBao, Cloudflare, and
Authentik) and the final image build → Zot → `kubectl set image` deploy are real
code but can only be verified against a running cluster and a reachable Authentik,
which this build environment cannot reach. Those steps are scripted and documented
rather than claimed as verified — see the README. Everything that can be proven
without a cluster is proven by the test suite.
