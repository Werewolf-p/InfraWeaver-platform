# InfraWeaver Console — IA Restructure Plan

Status: **proposal — awaiting approval before implementation**
Audited: 2026-06-29 · App: `apps/infraweaver-console` (Next.js 16, custom build)

## Problem

The console has **79 dashboard routes** under `src/app/(dashboard)/`. Related
features live on separate pages with no connection (you can open a pod but its
firewall is a different page), addon pages aren't discoverable (the WordPress
page only matters when the addon is on, but nav doesn't reflect that), the
WordPress entry point re-opens the setup wizard instead of the management panel,
and global search doesn't surface live resources. The result feels sprawling.

The fix is mostly **consolidation, not new plumbing** — the architecture already
has the right bones.

## What already exists (use it, don't rebuild)

- **Nav definition + RBAC gating:** `src/lib/navigation-rbac.ts` (115 lines),
  rendered by `src/components/layout/sidebar.tsx`. Favorites in
  `src/components/layout/nav-favorites-config.tsx`.
- **Addon system:** SDK in `src/lib/addon-sdk/` (`types.ts` defines the manifest
  schema), manifests at `src/addons/gamehub/addon.manifest.ts` and
  `src/addons/wordpress-manager/addon.manifest.ts`, generated registry at
  `src/generated/addon-registry.ts`, and the `src/hooks/use-addons.ts` hook for
  enabled state. → Addon-driven conditional nav = let manifests **contribute nav
  items** that the sidebar renders only when the addon is enabled.
- **Search:** `src/components/layout/cmd-palette.tsx` (419 lines) — the single
  place to extend so it also indexes live resources.
- **Per-pod firewall (shipped):** `(dashboard)/network/firewall` already does
  per-pod ingress/egress allow + remove. Embed/cross-link it into the pod view.

## Target IA — collapse 79 routes into 7 RBAC-gated groups + an Addons group

Groups appear only if the session's RBAC grants at least one child. Exact route
homes are a starting point; a few are judgment calls noted inline.

### 1. Overview
`home`, `status`, `cluster`, `cost`, `changelog`, `feedback`, `wiki` (+`wiki/[...slug]`)

### 2. Workloads
`pods` (+`pods/[namespace]/[name]` — **embed firewall + `pod-shell` + logs here**),
`apps` (+`apps/[name]`), `all-services`, `app-graph`, `cronjobs`,
`scheduled-tasks`, `deployment-compare`, `resource-optimizer`, `node-top`,
`memory`, `quota`, `power-groups`, `namespace-cleanup`

### 3. Networking
`network`, `network/firewall`, `network-policies`, `dns`, `ingress`, `routes`, `uptime`

### 4. Storage & Config
`storage`, `storage-timeline`, `pv-browser`, `backups`, `registry`,
`config`, `config-maps`, `config-drift`, `secrets`, `secret-expiry`, `certificates`

### 5. Observability
`monitoring`, `logs`, `log-analytics`, `events`, `health`, `alert-silence`,
`self-test`, `tests`, `health-tester`, `webhook-tester`

### 6. Security & Access
`security`, `access`, `users`, `rbac-viz`, `image-vulnerabilities`

### 7. Platform (GitOps & admin)
`gitops-diff`, `automations`, `pipelines`, `catalog-install`, `community-apps`,
`maintenance`, `admin/updates`, `settings` (+`settings/addons`,
`settings/infrastructure`, `settings/platform`, `settings/rbac`), `profile`

### Addons (conditional — only when enabled)
- **WordPress** (`wordpress`, `wordpress/[site]`) — only when `wordpress-manager` enabled
- **Game Hub** (`game-hub` + `[name]`/`create`/`new`/`setup`, `gameservers`) — only when `gamehub` enabled

## The four specific fixes

1. **Compact, grouped sidebar.** Refactor `navigation-rbac.ts` into the 7 groups
   above (collapsible sections), rendered by `sidebar.tsx`. Group hidden entirely
   when RBAC grants none of its children.
2. **Addon-conditional nav.** Extend the addon manifest schema (`addon-sdk/types.ts`)
   with a `nav` contribution; `sidebar.tsx` merges enabled addons' nav (via
   `use-addons`) into the Addons group. No hardcoded addon links.
3. **Pod ↔ firewall consolidation.** In `pods/[namespace]/[name]`, surface the
   per-pod firewall controls (reuse the `network/firewall` components) as a tab or
   panel. `network/firewall` stays as the fleet-wide view; the two cross-link.
4. **WordPress entry fix.** A site **name** links to its **management panel**
   (status, plugins, SSO, domains). The setup wizard is reachable only via an
   explicit "New site" action. Audit `wordpress/[site]` to confirm/repair this.
5. **Search surfaces resources.** Extend `cmd-palette.tsx` to query live pods,
   services, and (when enabled) game servers, **filtered by RBAC**, each result a
   deep link into its combined panel (pod→pod+firewall, game server→game panel).

## Constraints (non-negotiable)

- Preserve every capability — **relocate/merge/redirect, never delete**. Add
  redirects so old URLs (`/network/firewall`, etc.) still resolve.
- RBAC gating applies to nav items, embedded panels, and every search result.
- Reuse existing components + design system (tokens, framer-motion); match the
  firewall surface just shipped. No new dependencies without asking.
- Read `node_modules/next/dist/docs/` before changing routing/layout (custom Next 16).
- Keep the test suite green. Many small files over few large ones.
- GitOps/ArgoCD with selfHeal — do **not** deploy; finish with build + git-pin commands.

## Phased implementation (each phase = its own session, approval-gated)

1. **Nav regroup** — `navigation-rbac.ts` → 7 groups + `sidebar.tsx` collapsible
   sections, RBAC group-hiding. Redirects for any renamed paths.
2. **Addon-conditional nav** — manifest `nav` contribution + sidebar merge.
3. **Pod + firewall** — embed firewall panel into the pod detail view.
4. **WordPress entry** — name→manage, setup behind an explicit new-site action.
5. **Search resources** — RBAC-filtered live pods/services/game servers in cmd-palette.

## Open decision

Pull the firewall **fully into** the pod view (one combined page) vs. keep it as
its own page **cross-linked** from each pod. This shapes how much is merge vs. link.
