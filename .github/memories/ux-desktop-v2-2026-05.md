# Desktop UX overhaul v2 — 2026-05

## Scope
- Reworked desktop UX for dashboard pages:
  - `home`
  - `apps`
  - `cluster`
  - new `monitoring`
- Added shared dashboard primitives for consistent desktop summaries, search bars, and distribution visuals.

## Files changed
- `apps/infraweaver-console/src/app/(dashboard)/home/page.tsx`
- `apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx`
- `apps/infraweaver-console/src/app/(dashboard)/cluster/page.tsx`
- `apps/infraweaver-console/src/app/(dashboard)/monitoring/page.tsx`
- `apps/infraweaver-console/src/lib/nav-config.ts`
- `apps/infraweaver-console/src/hooks/use-argocd.ts`
- `apps/infraweaver-console/src/components/ui/dashboard-panel.tsx`
- `apps/infraweaver-console/src/components/ui/dashboard-stat-card.tsx`
- `apps/infraweaver-console/src/components/ui/toolbar-search-input.tsx`
- `apps/infraweaver-console/src/components/ui/segmented-bar.tsx`

## What shipped
- New `/monitoring` route with observability summary, alert feed, service watchlist, SLA/latency views, platform status cross-checks, export, refresh controls, and keyboard search.
- Home dashboard upgraded with system summary cards, service distribution, quick actions, activity stream, richer service explorer, and desktop-first layout density.
- Apps dashboard upgraded with denser installed-apps triage: search shortcut, multi-filter toolbar, namespace/source/sync filters, bulk selection, bulk sync, export, and richer app metadata.
- Cluster dashboard upgraded with desktop posture summary, node search/filtering, quota hotspot panels, recent event feed, node maintenance controls, and smart-drain confirmation flow.
- Shared UI primitives added so future dashboard work can reuse the same panel/stat/search/bar patterns.
- Navigation updated so Monitoring appears in dashboard navigation.
- Extended Argo app typing to include optional `metadata.creationTimestamp` for app age displays.

## Constraints respected
- Avoided protected dashboard layout file and other protected areas.
- Did not modify Kubernetes YAML, `package.json`, or dashboard routes explicitly called out as off-limits.

## Validation
- `npx eslint --no-error-on-unmatched-pattern ...changed dashboard files...` ✅
- `npm test -- --runInBand` ✅ (4 suites / 14 tests)
- `npm run build` could not run in this environment because Node is `18.19.1` and Next.js requires `>=20.9.0`.

## Notes
- Repo had many unrelated pre-existing modifications in the working tree; only the UX-overhaul files above were intended for this change.
- Monitoring navigation was wired through `nav-config.ts` because protected layout/sidebar files were off-limits.
