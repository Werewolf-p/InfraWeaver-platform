# Modularity Improvements — 2026-05

## Shared foundations added
- Added `apps/infraweaver-console/src/lib/query-keys.ts` to centralize React Query keys for config, RBAC, pods, cluster, ArgoCD, and security data.
- Added typed domains under `src/types/`:
  - `api.ts`
  - `kubernetes.ts`
  - `cluster.ts`
- Added reusable hooks:
  - `use-debounce`
  - `use-copy-to-clipboard`
  - `use-local-storage`
  - `use-refetch-interval`
  - `use-permissions`
  - `use-scheduled-tasks`
  - `use-config-drift`
  - `use-cluster-data`

## Shared UI added or improved
- Added new UI primitives:
  - `DataCard`
  - `ResourceBar`
  - `SearchInput`
  - `SortableHeader`
- Improved existing shared UI:
  - `StatusBadge` now normalizes raw status strings and supports broader reuse.
  - `CopyButton` and `CopyValue` now share clipboard state logic.
  - `EmptyState` now supports either declarative button actions or custom action nodes.
  - `PageHeader` now supports `description` alongside legacy `subtitle`.
  - `ResourceTable` now uses `SortableHeader` for consistent sorting UI.
  - `NamespaceUsage` now consumes `ResourceBar`.

## Pages refactored to use shared abstractions
### `scheduled-tasks/page.tsx`
- Replaced inline queries and mutations with `useScheduledTasks()`.
- Added shared search, summary cards, table abstraction, empty state, status badge, and confirm dialog.
- Search state is now persisted with `useLocalStorage()`.

### `config-drift/page.tsx`
- Replaced inline data layer with `useConfigDrift()`.
- Added shared search, summary cards, resource bar, table abstraction, empty state, and status badge.
- Search state is now persisted with `useLocalStorage()`.

### `pods/page.tsx`
- Switched to `usePods()` and `usePermissions()`.
- Added shared search input, summary cards, empty state, copy button, and normalized status badges.
- Namespace/status/search filters now persist via `useLocalStorage()`.

## Validation notes
- Targeted ESLint passes for all newly added or modified modularity files.
- Jest unit tests pass.
- Full repo lint still has pre-existing React purity / set-state-in-effect issues outside this modularity work.
- Next.js build is still blocked in this environment because Node 18.19.1 is installed while Next.js requires Node >= 20.9.0.
