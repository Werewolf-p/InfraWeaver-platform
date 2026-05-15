# Modularity audit — 100 ideas (2026-05)

## Scope audited

- Repo: `/home/runner/platform` on branch `feat/modularity`.
- Console scope reviewed: 65 dashboard pages, 180 API routes, 53 UI components, 5 layout components, 31 hooks, 41 lib files, and 4 type entry files.
- Goal: future developers or agents should be able to add a well-structured page in minutes, not hours.

## Status legend

- **implemented** — landed in this branch.
- **planned** — analyzed and documented for the next modularity passes.

## 1-20. Pages, navigation, and dashboard architecture

### 1. Central page registry
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/page-registry.ts, src/lib/nav-config.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/lib/page-registry.ts, src/lib/nav-config.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 2. Page scaffold CLI
- Status: **implemented**
- Target files: `apps/infraweaver-console/scripts/scaffold-page.mjs, package.json`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/scripts/scaffold-page.mjs, package.json`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 3. Standard PageScaffold wrapper
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/components/ui/page-scaffold.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/page-scaffold.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 4. Settings card pattern
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/components/ui/settings-card.tsx, src/app/(dashboard)/settings/page.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/settings-card.tsx, src/app/(dashboard)/settings/page.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 5. Registry-driven settings/profile/wiki headers
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/app/(dashboard)/settings/page.tsx, profile/page.tsx, wiki/page.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/app/(dashboard)/settings/page.tsx, profile/page.tsx, wiki/page.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 6. Shared quota page pattern
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/app/(dashboard)/quota/page.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/app/(dashboard)/quota/page.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 7. Shared cost page pattern
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 8. Registry-backed nav merging
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/nav-config.ts, src/lib/page-registry.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/lib/nav-config.ts, src/lib/page-registry.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 9. Page config manifests per route
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/(dashboard)/**/page.config.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/app/(dashboard)/**/page.config.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 10. Page permission enforcement wrapper
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/page-scaffold.tsx, src/hooks/use-permissions.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/page-scaffold.tsx, src/hooks/use-permissions.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 11. Page-specific refresh policies
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/page-registry.ts, shared hooks`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/lib/page-registry.ts, shared hooks`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 12. Generated breadcrumbs from page config
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/page-header.tsx, page registry`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/page-header.tsx, page registry`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 13. Standard list-page shell
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/list-page-shell.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/list-page-shell.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 14. Shared page toolbar
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/page-toolbar.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/page-toolbar.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 15. List filter state hook
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-list-filters.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/hooks/use-list-filters.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 16. Namespace filter helper
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-namespace-filter.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/hooks/use-namespace-filter.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 17. Page-level error boundaries
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/error-boundary.tsx, page wrappers`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/error-boundary.tsx, page wrappers`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 18. Dashboard skeleton presets
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/page-loading-state.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/page-loading-state.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 19. Detail summary card pattern
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/detail-summary-card.tsx`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/src/components/ui/detail-summary-card.tsx`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

### 20. Navigation contract tests
- Status: **planned**
- Target files: `apps/infraweaver-console/tests/unit/nav-config.test.ts`
- Implementation plan:
  1. Consolidate the current page-specific behavior behind a shared page primitive or metadata contract in `apps/infraweaver-console/tests/unit/nav-config.test.ts`.
  1. Refactor at least one existing dashboard page to use the new pattern so the abstraction proves itself against real code.
  1. Make the pattern the default path for future pages through the scaffold script, docs, or registry metadata.

## 21-40. API route modularity

### 21. Route middleware-style auth helper
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/route-utils.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-utils.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 22. Standard response envelope adoption
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api/**/route.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api/**/route.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 23. Shared route utilities
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/route-utils.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-utils.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 24. Permission-checked route migrations
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/app/api/cluster/scheduled-tasks/route.ts, cluster/config-drift/route.ts, rbac/my-permissions/route.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api/cluster/scheduled-tasks/route.ts, cluster/config-drift/route.ts, rbac/my-permissions/route.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 25. Route-level zod validation helpers
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/route-utils.ts, src/lib/validate.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-utils.ts, src/lib/validate.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 26. Centralized route config metadata
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api/**/route.config.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api/**/route.config.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 27. CRUD route factory for simple resources
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/route-factories.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-factories.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 28. Shared route error logging
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/route-utils.ts, src/lib/audit-log.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-utils.ts, src/lib/audit-log.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 29. Kubernetes adapter helpers
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/k8s-adapters.ts, src/lib/kube-client.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/k8s-adapters.ts, src/lib/kube-client.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 30. Mock data factories
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/mock-data.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/mock-data.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 31. Route cache-header helper
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/route-utils.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/route-utils.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 32. Route rate-limit manifest
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/rate-limit.ts, route metadata`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/rate-limit.ts, route metadata`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 33. Shared route tests
- Status: **planned**
- Target files: `apps/infraweaver-console/tests/unit/routes`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/tests/unit/routes`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 34. Profile route consolidation
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api/profile/**/route.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api/profile/**/route.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 35. Config route consolidation
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api/config/**/route.ts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api/config/**/route.ts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 36. Route inventory generator
- Status: **planned**
- Target files: `apps/infraweaver-console/scripts, src/app/api`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/scripts, src/app/api`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 37. Route contract linting
- Status: **planned**
- Target files: `apps/infraweaver-console/eslint rules or validation scripts`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/eslint rules or validation scripts`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 38. Incremental OpenAPI manifest
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api, docs`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api, docs`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 39. Route permissions audit report
- Status: **planned**
- Target files: `apps/infraweaver-console/src/app/api, memories/docs`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/app/api, memories/docs`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

### 40. Shared audit-friendly mutation path
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/audit-log.ts, route helpers`
- Implementation plan:
  1. Standardize repeated API handler concerns in `apps/infraweaver-console/src/lib/audit-log.ts, route helpers`, especially auth, envelopes, validation, or serialization.
  1. Migrate low-risk existing routes first so the helper replaces old code instead of living beside it unused.
  1. Back the contract with tests or docs so future routes keep the same server-side shape and safety guarantees.

## 41-60. Hooks, data flow, and React Query

### 41. Central API client
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/api-client.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/lib/api-client.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 42. Shared React Query wrappers
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/hooks/use-api-query.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-api-query.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 43. Query key coverage expansion
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/query-keys.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/lib/query-keys.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 44. Central query timing constants
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/query-defaults.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/lib/query-defaults.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 45. Shared hook migrations
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/hooks/use-cluster-data.ts, use-config-drift.ts, use-scheduled-tasks.ts, useRBAC.ts, use-platform-config.ts, use-users-config.ts, use-audit-log.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-cluster-data.ts, use-config-drift.ts, use-scheduled-tasks.ts, useRBAC.ts, use-platform-config.ts, use-users-config.ts, use-audit-log.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 46. Hook barrel exports
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/hooks/index.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/index.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 47. useProfile hook
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-profile.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-profile.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 48. useConnectionStatus hook
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-connection-status.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-connection-status.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 49. useTableState hook
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-table-state.ts, ResourceTable`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-table-state.ts, ResourceTable` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 50. Mutation toast presets
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-api-query.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-api-query.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 51. Optimistic mutation helpers
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-api-query.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-api-query.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 52. Preferences sync core extraction
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-server-preferences.ts, src/lib/preferences-sync.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-server-preferences.ts, src/lib/preferences-sync.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 53. Schema-aware local storage hook
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-local-storage.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-local-storage.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 54. Domain hook folders
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 55. Hook docs index
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/index.ts, docs`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/index.ts, docs` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 56. Hook test helpers
- Status: **planned**
- Target files: `apps/infraweaver-console/tests/unit/test-utils.tsx`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/tests/unit/test-utils.tsx` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 57. Automatic invalidation map
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/query-invalidation.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/lib/query-invalidation.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 58. Derived query selectors
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks, query helpers`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks, query helpers` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 59. Connection-aware refetch manager
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-refetch-interval.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-refetch-interval.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

### 60. Hook-level dev diagnostics
- Status: **planned**
- Target files: `apps/infraweaver-console/src/hooks/use-api-query.ts`
- Implementation plan:
  1. Move repeated client-side data-fetching or mutation logic into `apps/infraweaver-console/src/hooks/use-api-query.ts` so pages stop hand-rolling fetch code.
  1. Adopt the helper in shared hooks first, then fan it out to the rest of the console as pages are touched.
  1. Tie the helper to query keys, typed responses, and small tests so cache behavior stays explicit and safe.

## 61-80. UI components and shared patterns

### 61. ResourceTable generic cleanup
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/components/ui/resource-table.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/resource-table.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 62. EmptyState type safety
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/components/ui/empty-state.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/empty-state.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 63. UI barrel exports
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/components/ui/index.ts, src/components/layout/index.ts`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/index.ts, src/components/layout/index.ts` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 64. Central status color registry
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/status-tokens.ts, status-badge.tsx, utils.ts`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/lib/status-tokens.ts, status-badge.tsx, utils.ts` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 65. Shared stat grid component
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/stat-card-grid.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/stat-card-grid.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 66. Shared connection status component
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/connection-status.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/connection-status.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 67. Shared chart panel wrapper
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/chart-panel.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/chart-panel.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 68. Table column preset helpers
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/resource-table-presets.ts`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/resource-table-presets.ts` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 69. Reusable mobile row cards
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/mobile-resource-card.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/mobile-resource-card.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 70. Shared preference toggle row
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/preference-toggle-row.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/preference-toggle-row.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 71. Shared section layout primitive
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/section-layout.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/section-layout.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 72. Shared form field primitives
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/form-field.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/form-field.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 73. Story fixtures for shared components
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui, docs`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui, docs` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 74. Component-level JSDoc sweep
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui, src/hooks, src/lib`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui, src/hooks, src/lib` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 75. Mobile nav from registry
- Status: **planned**
- Target files: `apps/infraweaver-console/src/lib/nav-config.ts, page registry`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/lib/nav-config.ts, page registry` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 76. Command palette from registry
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/command-palette.tsx, page registry`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/command-palette.tsx, page registry` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 77. Shared export/download actions
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/export-button.tsx, src/lib/exporters.ts`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/export-button.tsx, src/lib/exporters.ts` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 78. Shared copy/value primitives
- Status: **planned**
- Target files: `apps/infraweaver-console/src/components/ui/copy-button.tsx, copy-value.tsx`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `apps/infraweaver-console/src/components/ui/copy-button.tsx, copy-value.tsx` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 79. Chart/table composition docs
- Status: **planned**
- Target files: `docs, memories, refactored cost page`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `docs, memories, refactored cost page` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

### 80. Operator-centric empty-state copy guide
- Status: **planned**
- Target files: `docs, EmptyState usage across dashboard pages`
- Implementation plan:
  1. Extract or refine a reusable UI primitive in `docs, EmptyState usage across dashboard pages` to replace repeated markup or styling drift.
  1. Apply the primitive to at least one current dashboard page or panel so the shared API is shaped by real usage.
  1. Document the intended usage with examples, tests, or JSDoc so future contributors reach for the primitive first.

## 81-100. Types, tooling, testing, and process

### 81. Typed shared domain responses
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/types/api.ts, src/types/cluster.ts, src/types/profile.ts, src/types/index.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/types/api.ts, src/types/cluster.ts, src/types/profile.ts, src/types/index.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 82. Profile type centralization
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/types/profile.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/types/profile.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 83. Cluster cost and quota type centralization
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/types/cluster.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/types/cluster.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 84. Scheduled task type centralization
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/types/cluster.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/types/cluster.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 85. Centralized platform user type
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/types/index.ts, src/hooks/use-users-config.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/types/index.ts, src/hooks/use-users-config.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 86. Type-safe icon registry
- Status: **implemented**
- Target files: `apps/infraweaver-console/src/lib/page-registry.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src/lib/page-registry.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 87. Page registry type tests
- Status: **implemented**
- Target files: `apps/infraweaver-console/tests/unit/page-registry.test.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/tests/unit/page-registry.test.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 88. Generated type stubs from scaffold
- Status: **implemented**
- Target files: `apps/infraweaver-console/scripts/scaffold-page.mjs`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/scripts/scaffold-page.mjs` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 89. Automatic type barrel updates
- Status: **planned**
- Target files: `apps/infraweaver-console/scripts/scaffold-page.mjs, src/types/index.ts`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/scripts/scaffold-page.mjs, src/types/index.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 90. Response-shape migration guide
- Status: **planned**
- Target files: `.github/memories, docs`
- Implementation plan:
  1. Capture the shared contract in `.github/memories, docs` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 91. Add-page workflow guide
- Status: **planned**
- Target files: `README or docs/console, scaffold output`
- Implementation plan:
  1. Capture the shared contract in `README or docs/console, scaffold output` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 92. Shared console architecture map
- Status: **planned**
- Target files: `.github/memories, docs`
- Implementation plan:
  1. Capture the shared contract in `.github/memories, docs` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 93. Folder conventions for hooks/components/types
- Status: **planned**
- Target files: `apps/infraweaver-console/src`
- Implementation plan:
  1. Capture the shared contract in `apps/infraweaver-console/src` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 94. Changed-file lint helper
- Status: **planned**
- Target files: `package.json, scripts`
- Implementation plan:
  1. Capture the shared contract in `package.json, scripts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 95. Scaffolder smoke test
- Status: **planned**
- Target files: `CI workflows, scaffold script`
- Implementation plan:
  1. Capture the shared contract in `CI workflows, scaffold script` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 96. Foundation regression test suite
- Status: **planned**
- Target files: `tests/unit`
- Implementation plan:
  1. Capture the shared contract in `tests/unit` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 97. Fixture library for k8s and profile data
- Status: **planned**
- Target files: `tests/unit/fixtures`
- Implementation plan:
  1. Capture the shared contract in `tests/unit/fixtures` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 98. Permission matrix documentation
- Status: **planned**
- Target files: `docs, memories, src/lib/rbac.ts`
- Implementation plan:
  1. Capture the shared contract in `docs, memories, src/lib/rbac.ts` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 99. Strict TypeScript backlog tracking
- Status: **planned**
- Target files: `.github/memories, issue tracker`
- Implementation plan:
  1. Capture the shared contract in `.github/memories, issue tracker` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.

### 100. Foundation change checklist
- Status: **planned**
- Target files: `.github/memories, CONTRIBUTING.md`
- Implementation plan:
  1. Capture the shared contract in `.github/memories, CONTRIBUTING.md` so types, tooling, or docs become the canonical source instead of page-local definitions.
  1. Wire the contract into the current foundation work so the improvement is exercised immediately, not left theoretical.
  1. Use automation, tests, or documentation to keep the contract discoverable as more console features are added.
