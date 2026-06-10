# Game Hub Addon

Self-contained addon for deploying and managing game servers on Kubernetes.

## Structure

- `addon.manifest.ts` — typed AddonManifest (contract with the host)
- `pages/` — route page components (stub in P1; AddonPageHost lazy-loads in P2)
- `components/` — addon-private UI components (moved from `src/components/game-hub/`)
- `lib/` — server-side logic (moved from `src/lib/game-hub*.ts`, `game-eggs.ts`, `pelican-eggs.ts`)
- `api/` — API handler functions (P2: will be wired via `/api/addons/gamehub/*` dispatcher)

## Routing (P1 MVP)

App Router files at `src/app/(dashboard)/game-hub/**` remain the live route entry points.
`src/lib/game-hub*.ts` and `src/components/game-hub/**` are forwarding shims → addon lib/components.

## P2 follow-ups

- Move actual page content into `pages/` and make App Router files thin shims
- Wire API routes through `/api/addons/gamehub/[...path]` dispatcher
- Register hooks (fab actions, dashboard widgets)
