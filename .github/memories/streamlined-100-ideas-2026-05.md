---
title: Streamlined workflow ideas — 100 ideas — 2026-05
description: Exact workflow streamlining ideas for InfraWeaver Console with implementation plans and status on feat/streamlined.
---

# Streamlined workflow ideas for InfraWeaver Console

Branch: `feat/streamlined`

## Legend
- **Implemented** = shipped in this iteration
- **Planned** = concrete next step, not yet shipped

## Search, command, and navigation workflows

1. **Implemented — Personalized global search ranking** — Re-rank `src/components/search/global-search.tsx` results from `/api/search` using exact-match, prefix, pinned-page, and recent-page boosts from `use-favorites` and `use-recent-pages`, while keeping empty/error states safe when categories return empty.
2. **Implemented — Server-synced recent searches** — Extend `src/lib/user-preferences.ts`, `src/lib/user-preferences-server.ts`, `src/hooks/use-server-preferences.ts`, and `src/app/api/user/preferences/route.ts` so search history persists across browsers and falls back to local storage without breaking old preference payloads.
3. **Implemented — Arrow-key result navigation** — Make `src/components/search/global-search.tsx` a proper combobox/listbox with `aria-activedescendant`, Up/Down movement, Enter to open, and safe index resets when results or queries change.
4. **Implemented — Quick-access search home** — When search is empty, show pinned and recently visited pages inside `src/components/search/global-search.tsx` so power users can jump without typing, while deduping paths and capping the list for mobile.
5. **Implemented — Search loading skeletons** — Replace blank waiting states in `src/components/search/global-search.tsx` with skeleton rows so operators know the query is running even when the cluster APIs are slow.
6. **Implemented — Breadcrumb quick jump** — Extend `src/components/ui/breadcrumb.tsx` with a jump menu that mixes sibling pages from `src/lib/nav-config.ts` and `useRecentPages`, closes on outside click/Escape, and avoids showing the current route.
7. **Implemented — Bulk pod selection** — Add durable row/card selection in `src/app/(dashboard)/pods/page.tsx` so visible pods can be triaged together on both mobile and desktop with accessible toggle buttons.
8. **Implemented — Bulk pod restart API** — Add `src/app/api/pods/bulk-restart/route.ts` to accept up to 20 pods, de-duplicate targets, respect `cluster:admin`, audit the action, surface partial failures, and simulate safely if the kube client is unavailable.
9. **Implemented — Copy selected pod identities** — Add a bulk clipboard action in `src/app/(dashboard)/pods/page.tsx` that copies `namespace/name` pairs for visible selections and fails gracefully with toast feedback.
10. **Implemented — Direct log shortcuts from pod inventory** — Add per-row and per-card deep links from `src/app/(dashboard)/pods/page.tsx` to `/logs?namespace=...&pod=...` so log inspection is one tap from triage.
11. **Implemented — Deep-linked log targets** — Teach `src/app/(dashboard)/logs/page.tsx` to respect `namespace`, `pod`, and `container` query params on load so links from pods and future alerts land in the right stream immediately.
12. **Implemented — Smart default log target** — When no explicit target is valid, `src/app/(dashboard)/logs/page.tsx` now chooses the highest-priority pod by bad status and recency, so crash loops surface before healthy noise.
13. **Implemented — Remembered log viewer preferences** — Persist filter text, wrap mode, level filter, and auto-scroll in `src/components/logs/log-stream-viewer.tsx` so repeated troubleshooting sessions reopen in the operator’s preferred mode.
14. **Implemented — Updated keyboard-shortcut reference** — Expand `src/components/ui/keyboard-shortcuts-modal.tsx` to document `/`, `Ctrl+K`, arrow navigation, and Enter selection so new search behavior is discoverable.
15. **Planned — Search result preview panel** — Split `src/components/search/global-search.tsx` into result list + preview so hovering an app shows health/sync badges and hovering a pod shows namespace/status without opening a page.
16. **Planned — Multi-open search results** — Add modifier-click and explicit “open in new tab” affordances to `src/components/search/global-search.tsx`, including keyboard hints and mobile-safe overflow actions.
17. **Planned — Search aliases for platform jargon** — Extend `src/lib/search.ts` and `/api/search` so terms like “argocd”, “rollout”, “longhorn”, and “vault/openbao” resolve to the right pages and resources even when labels differ.
18. **Planned — Search pagination for large clusters** — Add cursors or `limit/offset` support to `src/app/api/search/route.ts` and render “load more” states in `src/components/search/global-search.tsx` for clusters exceeding the current caps.
19. **Planned — Search scope chips** — Add chips for Pages, Apps, Pods, Game Servers, and Settings inside `src/components/search/global-search.tsx`, remembering the last scope and resetting safely on close.
20. **Planned — Search action verbs** — Let operators type command-like phrases such as `restart pod foo` or `open app bar` in `src/components/search/global-search.tsx`, dispatching to existing APIs only after RBAC and confirmation checks.

## Pod, log, and cluster-control workflows

21. **Planned — Inline namespace chips in pod rows** — Turn namespace text in `src/app/(dashboard)/pods/page.tsx` into filter chips that update `pods-namespace-filter` without a trip back to the toolbar.
22. **Planned — Bulk pod delete with staged confirmation** — Reuse the new bulk-selection flow in `src/app/(dashboard)/pods/page.tsx` with a destructive confirmation model and a dedicated delete endpoint beside `bulk-restart`.
23. **Planned — Bulk pod evict/recreate for stuck workloads** — Add a second bulk action near `bulk-restart` that uses owner-aware recreation semantics so operators can reset unhealthy workloads without touching healthy selections.
24. **Planned — Pod saved filter presets** — Store named pod filter combos in user preferences so operators can jump between “Crash loops”, “Pending in argocd”, and “All VPN services” views.
25. **Planned — Pod column visibility persistence** — Move the desktop table in `src/app/(dashboard)/pods/page.tsx` onto reusable column metadata so users can hide Node or Containers columns and keep that choice per device.
26. **Planned — Pod restart rate-limit countdown** — Surface `429` cooldown hints from `/api/pods/restart` and `/api/pods/bulk-restart` directly in the pod toolbar so operators know when the next restart is allowed.
27. **Planned — Pod quick-peek hover card** — Add a hover/focus card to `src/app/(dashboard)/pods/page.tsx` showing owner, first container, node, and restart spikes without forcing navigation.
28. **Planned — Pod owner breadcrumb chain** — On pod detail pages under `src/app/(dashboard)/pods/[namespace]`, show back-links to owner deployment/app and cluster node so drills don’t dead-end.
29. **Planned — Copy-ready kubectl commands** — Add “copy kubectl logs/describe/delete” buttons to `src/app/(dashboard)/pods/page.tsx` and pod detail views using the existing copy primitives.
30. **Planned — Pod sorting controls** — Add explicit sort controls for age, restarts, and namespace in `src/app/(dashboard)/pods/page.tsx`, keeping mobile cards in the same order as the desktop table.
31. **Planned — Compare two log streams side-by-side** — Extend `src/app/(dashboard)/logs/page.tsx` and `src/components/logs/log-stream-viewer.tsx` to support dual-pane viewing for canary vs stable pods.
32. **Planned — Saved log queries per workload** — Store reusable filters like `error`, `timeout`, or namespace-specific patterns in user preferences and expose them beside the log filter input.
33. **Implemented — Jump to warning / jump to info** — Generalize the existing error-jump in `src/components/logs/log-stream-viewer.tsx` so operators can hop between WARN/INFO anchors too.
34. **Implemented — Pause live stream without reconnect** — Add a client-side pause toggle in `src/components/logs/log-stream-viewer.tsx` that buffers lines locally while keeping the SSE connection open.
35. **Implemented — Next/previous pod hotkeys** — Wire `src/app/(dashboard)/logs/page.tsx` to move through the current `PodSelectorTree` result set with keyboard shortcuts for rapid triage.
36. **Planned — Structured log export** — Let `src/components/logs/log-stream-viewer.tsx` export filtered logs as plain text, ndjson, or timestamped JSON so incidents can be shared fast.
37. **Planned — Sticky log error summary** — Add an always-visible count of current error lines and last-seen error timestamp above the log stream.
38. **Planned — Mobile log action bar** — Collapse filter, wrap, level, and download controls into a sticky bottom action tray on small screens using the existing mobile drawer patterns memory.
39. **Planned — Log-to-resource context links** — Add direct links from `src/components/logs/log-stream-viewer.tsx` back to the pod detail, owning app, and node page for whichever stream is open.
40. **Planned — Cluster page keyboard maintenance shortcuts** — Add safe shortcuts on `src/app/(dashboard)/cluster/page.tsx` for common actions like open migrate modal, cordon selected node, or filter hot nodes after RBAC checks.

## App, deploy, and operational workflows

41. **Planned — Bulk app sync for selected rows** — Build a selective bulk-sync flow in `src/app/(dashboard)/apps/page.tsx` using the existing sync mutation patterns rather than only `sync-all`.
42. **Planned — Bulk uninstall for selected community apps** — Extend the app selection model in `src/app/(dashboard)/apps/page.tsx` so community installs can be removed in batches with clear partial-failure reporting.
43. **Planned — Saved app triage views** — Persist the apps page search, health, sync, and source filters under named views for “OutOfSync”, “Community only”, or “Degraded prod”.
44. **Planned — App detail quick-action strip** — Add sync, open URL, open ArgoCD, logs, and rollback shortcuts directly into `src/app/(dashboard)/apps/[name]/page.tsx` header actions.
45. **Planned — Recent pods drawer on app detail** — Add a side drawer in `src/app/(dashboard)/apps/[name]/page.tsx` that highlights recent pod churn and links straight into the logs workspace.
46. **Planned — Resource-health filters on app detail** — Add quick filters above the tracked resource list so degraded, progressing, or missing resources can be isolated instantly.
47. **Planned — Compare last two revisions** — Extend app activity/config tabs to diff the two newest history entries without leaving the detail page.
48. **Planned — Permission impact summary** — Improve the Permissions tab in `src/app/(dashboard)/apps/[name]/page.tsx` with grouped scopes and conflict hints so operators know who can touch the app.
49. **Planned — Home portal internal search mode** — Replace the current Google-only `SearchBar` in `src/app/(dashboard)/home/page.tsx` with a toggle between internet search and the console’s own resource search.
50. **Planned — Morning operator checklist on Home** — Add a compact checklist card to `home/page.tsx` that summarizes unhealthy pods, expiring certs, degraded apps, and pending tasks with one-click jump targets.
51. **Planned — Continue-where-I-left-off on Home** — Surface recent pages, recent searches, and last active resource directly on the home portal using the new preference data.
52. **Planned — Drag-reorder home favorites** — Let pinned service cards on `home/page.tsx` be reordered and persisted rather than only displayed in static groups.
53. **Planned — Outage shortcuts from service cards** — Add “open monitoring”, “open logs”, or “open health” quick actions to home service cards when health checks degrade.
54. **Planned — Service-group rollups on Home** — Aggregate health per group in `home/page.tsx` so operators can collapse all-green sections and focus on the broken slice first.
55. **Planned — Cluster node quick-maintenance toolbar** — Expose cordon, drain, and open-pods actions directly in each node card/table row inside `src/app/(dashboard)/cluster/page.tsx`.
56. **Planned — Cluster rebalance suggestions** — Use node pod data already loaded in `cluster/page.tsx` to suggest which movable pods should shift off the hottest node first.
57. **Planned — Hot-node jump links** — Turn cluster capacity hotspots into direct jumps to the exact node pod section and suggested migration targets.
58. **Planned — Event acknowledgement shortcuts** — Add acknowledge/ignore actions to recent cluster events where the backing API already supports action-style workflows elsewhere.
59. **Planned — Cluster filter persistence** — Persist node search and section expansion states in `cluster/page.tsx` using the same preference patterns as other dashboards.
60. **Planned — Sync-and-wait action flow** — Add an app action that triggers sync then polls until healthy/synced, with progress toasts and timeout handling built around the existing Argo APIs.

## Preferences, dashboards, and operator defaults

61. **Planned — Search/favorite management in Settings** — Add a preferences panel under `src/app/(dashboard)/settings` to clear recent searches, review pinned pages, and restore defaults without touching storage manually.
62. **Planned — Command palette default mode** — Let operators choose whether `Ctrl+K` opens navigation-first or resource-first search, persisting the choice in user preferences.
63. **Planned — Logs default configuration in Settings** — Surface the same `recentSearches`-style persistence UI for default log level, wrap, and auto-scroll under Settings.
64. **Planned — Start-page enforcement** — Wire the existing `dashboardLayout.startPage` preference into the dashboard entry path so `/` or `/home` can optionally redirect to a user-chosen landing page.
65. **Planned — Preferences export/import** — Add JSON export/import for user preferences so operators can carry favorites, recents, and defaults across environments.
66. **Planned — Mobile-specific preferences** — Let users decide whether mobile opens search, pods, or home first and whether the selector drawer defaults open or collapsed.
67. **Planned — Grouped notification bundles** — Update `src/components/ui/notification-center.tsx` to merge repeated alerts from the same resource into a single actionable card.
68. **Planned — Undo queue for dismissals and actions** — Add a short-lived undo stack to the notification center and destructive resource actions so accidental clicks are recoverable.
69. **Planned — Notification noise presets** — Add presets like Quiet, Operator, and Incident mode to show only important categories in the notification center.
70. **Planned — Route-aware notification filtering** — When on Logs, Pods, or Apps, pin relevant notifications to the top of `NotificationCenter` instead of mixing unrelated events.
71. **Planned — Pull-to-refresh per page family** — Extend the existing `src/components/ui/pull-to-refresh.tsx` so pages like Pods, Apps, and Cluster can opt into mobile refresh consistently.
72. **Planned — Floating action button route awareness** — Tune `src/components/floating-action-button.tsx` so it hides or repositions itself on pages where it currently overlaps heavy bottom controls.
73. **Planned — Bottom-sheet snap points** — Upgrade `src/components/ui/bottom-sheet.tsx` to support medium/full snap positions for selectors, logs, and future action drawers.
74. **Planned — Page-header action overflow for mobile** — Add an overflow sheet to `src/components/ui/page-header.tsx` so dense action sets stay reachable on phones.
75. **Planned — Global pending-actions bar** — Show a top-level pending operations strip in dashboard layout so app syncs, pod restarts, and long-running calls are visible across routes.
76. **Planned — Cross-page recent-resource rail** — Add a tiny rail under the top bar with recent apps/pods/log targets, not just recent top-level pages.
77. **Planned — Offline retry queue** — Extend the offline indicator + optimistic preferences patterns so queued mutations can retry when connectivity returns.
78. **Planned — Density memory by page family** — Move density choice beyond the global toggle so data-heavy pages like Pods and Apps can stay compact while overview pages stay comfortable.
79. **Planned — Simple/advanced mode reuse** — Expand the existing simple-mode context from Pods into Apps, Cluster, and Logs for consistent progressive disclosure.
80. **Planned — Shared refresh countdowns** — Reuse `src/components/ui/refresh-countdown.tsx` more broadly so operators know exactly when the next auto-refresh fires on each live page.

## Networking, storage, security, and service workflows

81. **Planned — Network page jump chain** — Let service rows in `src/app/(dashboard)/network/page.tsx` open related ingress routes, DNS records, and app detail in a single jump menu.
82. **Planned — Saved network topology filters** — Persist the page’s search and layer filters so operators can keep a “VPN”, “public ingress”, or “database” topology view ready.
83. **Planned — Ingress test snippet copy** — Add copyable `curl`/host-header examples to `src/app/(dashboard)/ingress/page.tsx` for faster route verification.
84. **Planned — DNS clone record flow** — In `src/app/(dashboard)/dns/page.tsx`, add “clone” from an existing record so repetitive internal/public record creation is two clicks instead of full re-entry.
85. **Planned — Certificates quick renew context** — Add “renew now”, “open secret”, and “open ingress consumer” shortcuts in `src/app/(dashboard)/certificates/page.tsx`.
86. **Planned — Secret-expiry bulk acknowledge** — Add multi-select and acknowledge flows on `src/app/(dashboard)/secret-expiry/page.tsx` so repeated alerts don’t have to be cleared one by one.
87. **Planned — Registry quick tag actions** — Add copy-pull-command, copy-image-ref, and promote-to-deploy actions in `src/app/(dashboard)/registry/page.tsx`.
88. **Planned — Security findings grouped by owner** — Reshape `src/app/(dashboard)/security/page.tsx` so vulnerabilities group by workload/team and each group has one remediation action set.
89. **Planned — Monitoring status bar shortcuts** — Extend `src/app/(dashboard)/monitoring/page.tsx` to deep-link alert groups directly into logs, pods, and health detail views.
90. **Planned — Scheduled-task bundles** — Add batch rerun/disable/enable actions to `src/app/(dashboard)/scheduled-tasks/page.tsx` and the related cluster scheduled-tasks API routes.
91. **Planned — Namespace-cleanup dry-run reuse** — Rework `src/app/(dashboard)/namespace-cleanup/page.tsx` to save and replay the last dry-run result when operators reopen the page during the same session.
92. **Planned — Cost watchlist namespaces** — Add a pinned namespace watchlist to `src/app/(dashboard)/cost/page.tsx` so expensive tenants stay at the top automatically.
93. **Planned — Optimizer-to-scale handoff** — Add “apply recommendation” buttons in `src/app/(dashboard)/resource-optimizer/page.tsx` that call the existing cluster scale endpoints with confirmation.
94. **Planned — Game Hub quick action palette** — Surface start/stop/restart/open-console actions for selected servers in `src/app/(dashboard)/game-hub` using the existing bulk server endpoint family.
95. **Planned — Users page bulk session revoke** — Extend `src/app/(dashboard)/users/page.tsx` and the profile/session APIs so operators can revoke selected stale sessions in one pass.
96. **Planned — Profile resume card** — Add a “resume last operator session” block to `src/app/(dashboard)/profile/page.tsx` using recent pages, recent searches, and current alerts.
97. **Planned — Wiki to console handoff** — Let `src/components/wiki/WikiSearch.tsx` hand a term into global resource search so docs and live resources connect seamlessly.
98. **Planned — App graph adjacent-resource tabs** — Turn `src/app/(dashboard)/app-graph/page.tsx` nodes into quick-open adjacent tabs for app detail, logs, and config-diff.
99. **Planned — Consistent ARIA for row actions** — Audit action buttons across Pods, Apps, Logs, Cluster, and Home so every icon-only control has a stable accessible label and focus ring.
100. **Planned — Live SSE-backed table refresh** — Replace some 30s polling on Pods, Logs, and future search suggestions with SSE/WebSocket feeds so the console feels instantaneous under load.

## Implemented in this iteration

- #1 Personalized global search ranking
- #2 Server-synced recent searches
- #3 Arrow-key result navigation
- #4 Quick-access search home
- #5 Search loading skeletons
- #6 Breadcrumb quick jump
- #7 Bulk pod selection
- #8 Bulk pod restart API
- #9 Copy selected pod identities
- #10 Direct log shortcuts from pod inventory
- #11 Deep-linked log targets
- #12 Smart default log target
- #13 Remembered log viewer preferences
- #14 Updated keyboard-shortcut reference
- #33 Jump to warning / jump to info
- #34 Pause live stream without reconnect
- #35 Next/previous pod hotkeys
