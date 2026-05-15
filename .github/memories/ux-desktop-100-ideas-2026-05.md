# InfraWeaver — Desktop UX Ideas (May 2026)
<!-- branch: feat/ux-desktop | file: .github/memories/ux-desktop-100-ideas-2026-05.md -->

This memory captures **exactly 100 desktop-first UX ideas** grounded in the current `apps/infraweaver-console` codebase, including dashboard pages, shared UI/layout components, and supporting lib utilities. The aim is to make the console denser, clearer, faster to scan, and more delightful for desktop operators.

## 100 Desktop UX Ideas

**1. Sidebar workspace memory**

**Where:** `apps/infraweaver-console/src/components/layout/sidebar.tsx`, `apps/infraweaver-console/src/lib/nav-config.ts`

**Idea:** Treat the desktop sidebar as a persistent operator workspace by remembering collapsed state, open groups, and the last-used section emphasis.

**Plan:**
- Persist the rail width and open group state with `localStorage` keys already adjacent to the existing section-state logic so the sidebar feels stable between sessions.
- Add a subtle “active workspace” label above the active group and keep the `favorites` + `recent` areas visually distinct from the core nav groups.
- Apply smoother hover/active transitions so group changes feel intentional rather than abrupt.

**Accessibility/edge cases:** Keyboard focus order must remain linear when groups are collapsed, and the remembered state must fall back safely when nav items disappear because of RBAC or addon filtering.

**2. Sidebar group density presets**

**Where:** `sidebar.tsx`, `DensityToggle`, `settings-context.tsx`

**Idea:** Let desktop users make the sidebar denser than the content area so the left rail can hold more information without stealing main-canvas width.

**Plan:**
- Introduce a sidebar-only density variant that tightens nav item padding while leaving cards and tables on the main canvas unchanged.
- Reuse the existing density preference infrastructure so desktop users can pick compact/comfortable/spacious rail spacing.
- Add a tiny preview row in Settings to show how many items fit per density level.

**Accessibility/edge cases:** Keep clickable targets above WCAG-friendly minimums and avoid shrinking icon-only collapsed controls below pointer-friendly size.

**3. Sidebar color legend for nav groups**

**Where:** `sidebar.tsx`, `apps/infraweaver-console/src/app/(dashboard)/layout.tsx`

**Idea:** Make the existing nav-group accents meaningful by showing a tiny desktop legend so blue/emerald/amber/violet groups become recognizable at a glance.

**Plan:**
- Convert the group color accent dots into a stable semantic legend in the desktop shell header or footer.
- Match the same accent family in page-level breadcrumbs and `PageHeader` badges for continuity.
- Use the legend to help users learn where “apps”, “compute”, “operations”, and “monitoring” live in the IA.

**Accessibility/edge cases:** Color must not be the sole cue; the group label and icon still need to carry the meaning for color-blind users.

**4. Topbar operator quick-create matrix**

**Where:** `apps/infraweaver-console/src/components/layout/topbar.tsx`

**Idea:** Turn the desktop “New” button into a richer quick-create launcher that shows destination, permissions, and likely follow-up steps.

**Plan:**
- Expand the existing quick-create dropdown into a 2-column desktop menu with short descriptions and shortcut hints beside each action.
- Surface RBAC-disabled actions in a muted state so operators know a workflow exists even if they cannot run it.
- Group items by “Deploy”, “Network”, and “Automation” to reduce scan time.

**Accessibility/edge cases:** The menu must be fully keyboard-navigable with Escape-to-close and proper `aria-expanded` state.

**5. Topbar density and theme shortcuts**

**Where:** `topbar.tsx`, `ThemeToggle`, `DensityToggle`, `settings/page.tsx`

**Idea:** Bring the most-used desktop appearance controls into the topbar so users can tune the UI without leaving the current page.

**Plan:**
- Add compact variants of `DensityToggle` and `ThemeToggle` to the topbar on xl+ screens.
- Persist the choice with the existing settings and theme hooks so the toggle reflects server-backed preferences.
- Show a small tooltip preview describing what changes when each density level is selected.

**Accessibility/edge cases:** Hide redundant controls on smaller breakpoints and ensure the condensed toggle still has an accessible label.

**6. PageHeader as a real desktop command bar**

**Where:** `apps/infraweaver-console/src/components/ui/page-header.tsx`

**Idea:** Use the shared header to create a strong desktop hierarchy: title, context, breadcrumb, action rail, and badge in one consistent surface.

**Plan:**
- Standardize `PageHeader` into a card-like surface with more breathing room for multi-button action sets.
- Add optional secondary metadata slots for page status, data source, and last refresh without duplicating ad-hoc banners in each page.
- Reuse the component on pages that still build headers manually so the dashboard shell feels cohesive.

**Accessibility/edge cases:** Breadcrumbs must remain readable when they overflow horizontally, and action buttons cannot lose visible focus styling inside dense headers.

**7. DashboardPanel desktop header alignment**

**Where:** `apps/infraweaver-console/src/components/ui/dashboard-panel.tsx`

**Idea:** Make `DashboardPanel` feel like the canonical desktop container for analysis sections, not just a plain bordered card.

**Plan:**
- Strengthen the header row with icon tiles, action alignment, and a subtle top highlight so dense dashboards get clearer section boundaries.
- Add optional sticky section headers for long panels such as event feeds or activity lists.
- Encourage pages like `home`, `cluster`, `security`, and `monitoring` to use `DashboardPanel` for all major sections.

**Accessibility/edge cases:** Sticky headers must not obscure keyboard-focused items, and decorative gradients should not reduce contrast.

**8. DashboardStatCard micro-trends**

**Where:** `DashboardStatCard`, `home/page.tsx`, `cluster/page.tsx`, `status/page.tsx`

**Idea:** Every major desktop metric card should be able to show a sparkline so the user sees movement, not only a number.

**Plan:**
- Extend `DashboardStatCard` with optional trend data and a tiny shared sparkline component.
- Feed recent samples from React Query refresh cycles into cards for CPU, memory, readiness, warnings, and service health.
- Use color semantics that match `StatusBadge` so trend and status speak the same visual language.

**Accessibility/edge cases:** Include an `aria-label` summarizing the trend direction because tiny charts alone are not enough for screen readers.

**9. DataCard contextual subtitles**

**Where:** `DataCard`, `config-drift/page.tsx`, `scheduled-tasks/page.tsx`, `cost/page.tsx`

**Idea:** Use `DataCard` as a compact desktop KPI block with richer subtitle context, not just a label/value pair.

**Plan:**
- Add optional sparkline and footer support for “why this number matters” context.
- Standardize subtitle copy to explain time range, scope, or threshold on every page that uses the component.
- Introduce subtle hover states so cards feel clickable only when they actually drill down.

**Accessibility/edge cases:** Avoid putting critical context only in hover states; subtitles must remain visible in keyboard-only use.

**10. Semantic StatusBadge library**

**Where:** `apps/infraweaver-console/src/components/ui/status-badge.tsx`, `apps/infraweaver-console/src/lib/utils.ts`

**Idea:** Enforce one shared green/yellow/red/blue/slate language for every status indicator across the console.

**Plan:**
- Expand `normalizeStatus` to cover more edge statuses such as disabled, cordoned, paused, expiring, and mock/fallback data.
- Add optional descriptions/tooltips so the badge can explain what a state means on hover.
- Replace page-local ad-hoc pills in `home`, `apps`, `events`, `cronjobs`, `registry`, and `cluster` with `StatusBadge` variants.

**Accessibility/edge cases:** The badge text must remain present even when a dot or icon is shown so users are not forced to interpret color alone.

**11. ResourceTable column visibility picker**

**Where:** `apps/infraweaver-console/src/components/ui/resource-table.tsx`, `config-drift/page.tsx`, `scheduled-tasks/page.tsx`

**Idea:** Let desktop users hide low-value columns so wide tables adapt to the job at hand.

**Plan:**
- Add a “Columns” popover that persists visible columns per page using a table-specific storage key.
- Seed sensible defaults by page so `config-drift` and `scheduled-tasks` start useful without requiring setup.
- Extend the same control to more table pages later, especially `pods`, `quota`, and `node-top`.

**Accessibility/edge cases:** Never allow users to hide every column, and keep the popover keyboard-operable with checkbox semantics.

**12. ResourceTable density persistence**

**Where:** `ResourceTable`, `DensityToggle`, `settings-context.tsx`

**Idea:** Make table row height respect the global density setting so desktop operators can switch between “scan everything” and “read everything” modes.

**Plan:**
- Apply compact/comfortable/spacious row padding directly inside `ResourceTable` and use the existing settings context as the source of truth.
- Expose the active density in the table toolbar so users understand why row height changed.
- Use the same density logic in `mobileCardRender` to keep desktop and small-screen layouts visually related.

**Accessibility/edge cases:** Spacious mode must not create excessive vertical scrolling on pages with high item counts, and compact mode cannot hurt legibility.

**13. ResourceTable sticky headers and scroll hint**

**Where:** `ResourceTable`, `HorizontalScrollHint`, `globals.css`

**Idea:** Wide desktop tables should keep context while scrolling and clearly communicate when more columns exist off-screen.

**Plan:**
- Use the existing `sticky-header` utility on header cells so labels remain visible during vertical scroll.
- Wrap the table in `HorizontalScrollHint` to show gradient fades and a “Scroll for columns” pill on overflow.
- Add this pattern to future migrations of `pods`, `node-top`, `quota`, and `dns` tables.

**Accessibility/edge cases:** Sticky elements must preserve contrast against changing backgrounds and not overlap focused cells.

**14. ToolbarSearchInput filter chips**

**Where:** `ToolbarSearchInput`, `home/page.tsx`, `cluster/page.tsx`, `apps/page.tsx`

**Idea:** Pair desktop search with fast filter chips so users can combine text search and one-click narrowing in the same visual cluster.

**Plan:**
- Add a companion chip row API to `ToolbarSearchInput` so pages can render state filters directly beside the field.
- Persist recent queries for resource-heavy pages like `cluster` and `home`.
- Reserve the `/` key hint for focus and show active-filter count in the field wrapper.

**Accessibility/edge cases:** Chips must expose selected state programmatically and stay reachable after the input in tab order.

**15. RefreshCountdown progress indicator**

**Where:** `RefreshCountdown`, `home/page.tsx`, `cluster/page.tsx`, `events/page.tsx`

**Idea:** Turn refresh timers into readable desktop status pills with visible progress rather than plain text.

**Plan:**
- Add a micro progress bar inside the `RefreshCountdown` pill so operators can anticipate the next pull without parsing numbers alone.
- Make the pill intensify as the refresh approaches, matching the page’s dominant accent color.
- Reuse the reset key to keep the indicator aligned with React Query fetch completion.

**Accessibility/edge cases:** Progress bars need text fallback because animation alone is not sufficient for reduced-motion users.

**16. ThemeToggle visual preview**

**Where:** `ThemeToggle`, `settings/page.tsx`, `topbar.tsx`

**Idea:** Show what light/dark/system actually look like before the user clicks.

**Plan:**
- Add tiny swatch backgrounds behind the light and dark icons using the same surface colors defined in `globals.css`.
- Show the current resolved theme when “system” is selected so desktop users understand what the machine preference is doing.
- Mirror the same language in Settings and the compact topbar toggle.

**Accessibility/edge cases:** Swatches are decorative; button labels must remain explicit and high contrast.

**17. Keyboard shortcut context map**

**Where:** `keyboard-shortcuts-modal.tsx`, `topbar.tsx`, `sidebar.tsx`

**Idea:** The shortcut modal should change based on the current page so desktop power users learn relevant commands faster.

**Plan:**
- Feed pathname-aware sections into the modal so `cluster` shows `/`, `Esc`, filter, and maintenance shortcuts while `logs` shows selector and pane shortcuts.
- Cross-link shortcut rows to the visual control that owns them by reusing labels from `PageHeader` or `TopBar`.
- Add “new in this page” tags for freshly shipped desktop interactions.

**Accessibility/edge cases:** The modal must trap focus correctly and remain dismissible via Escape and close button.

**18. NotificationCenter action chips**

**Where:** `NotificationCenter`, `sonner` toasts, `events/page.tsx`, `scheduled-tasks/page.tsx`

**Idea:** Convert notifications into desktop workflow accelerators by letting users jump directly to the affected page or row.

**Plan:**
- Add optional action chips such as “Open logs”, “Inspect app”, or “Go to task” inside toast payloads.
- Group notifications by page and severity so the center becomes a compact triage queue.
- Use the same green/amber/red language as `StatusBadge` to avoid mixed semantics.

**Accessibility/edge cases:** Toasts must not auto-dismiss before a keyboard user can reach the action, especially for destructive or warning states.

**19. EmptyState recovery patterns**

**Where:** `EmptyState`, `config-drift/page.tsx`, `scheduled-tasks/page.tsx`, `home/page.tsx`, `events/page.tsx`

**Idea:** Empty states should always tell the operator what to do next on a wide screen.

**Plan:**
- Add optional secondary help text or docs links so empty states can support both “no data yet” and “filter returned zero” situations.
- Standardize icon scale, heading hierarchy, and action placement for better consistency.
- Use dashboard-specific copy, e.g. “Capture baseline”, “Create task”, or “Reset filters”.

**Accessibility/edge cases:** Action buttons should be present only when the user has permission to use them, otherwise the copy must explain the limitation.

**20. User preference-backed desktop layouts**

**Where:** `apps/infraweaver-console/src/lib/user-preferences.ts`, `use-user-preferences`, `use-settings.ts`

**Idea:** Expand preferences beyond theme/density into desktop layout memory such as default split ratios, table columns, and pinned widgets.

**Plan:**
- Add a durable preference schema for dashboard layout choices and expose helper hooks so pages can opt in gradually.
- Start with safe desktop-only state: panel size, preferred density, and saved table views.
- Reconcile server-backed preferences with local fallbacks to keep anonymous/browser-only use functioning.

**Accessibility/edge cases:** Preference corruption must not break page rendering; unknown keys should be ignored and resettable.

**21. Home hero as an operator cockpit**

**Where:** `apps/infraweaver-console/src/app/(dashboard)/home/page.tsx`, `PageHeader`, `AutoRefreshControl`

**Idea:** The home page should feel like a desktop mission-control view, not just a portal landing page.

**Plan:**
- Keep the hero region wide, concise, and status-rich: greeting, current system mode, refresh cadence, and key operator status in one row.
- Promote the most important actions into the hero action rail and demote descriptive text into subtler supporting copy.
- Align the home hero visual density with `TopBar` and `DashboardPanel` so the first fold feels intentional.

**Accessibility/edge cases:** The hero cannot overwhelm screen readers with decorative content; key stats need a meaningful read order.

**22. Home system health summary trends**

**Where:** `home/page.tsx`, `DashboardStatCard`, `SegmentedBar`, `RefreshCountdown`

**Idea:** The “System health summary” should show motion over time, not only current totals.

**Plan:**
- Feed `DashboardStatCard` trend lines from the page’s refresh cadence for services, ArgoCD apps, warnings, and cluster readiness.
- Add subtle legend copy that explains the sampling window directly in the panel description.
- Let clicking a stat card jump to the matching detailed page (`apps`, `events`, `cluster`, `monitoring`).

**Accessibility/edge cases:** Trend cards need text summaries for reduced-motion and assistive-technology users.

**23. Home service explorer saved views**

**Where:** `home/page.tsx`, `ToolbarSearchInput`, `user-preferences.ts`

**Idea:** Desktop operators should be able to save common filter combinations for the service explorer.

**Plan:**
- Persist combinations of category, state filter, and text query as named “views”.
- Render the saved views as pills above the explorer on xl+ screens.
- Add default presets such as “VPN-only”, “Degraded services”, and “Catalog apps”.

**Accessibility/edge cases:** Saved view names must be editable via keyboard and deletable without relying on hover-only controls.

**24. Home quick action cards with secondary stats**

**Where:** `home/page.tsx`, `DashboardPanel`, quick action card grid

**Idea:** Quick action cards should carry live context so they are not just navigation tiles.

**Plan:**
- Add one secondary metric to each card, such as warning count for `events`, unhealthy apps for `apps`, or ready-node ratio for `cluster`.
- Use the card footer or badge area for this context so layout stays compact on desktop.
- Animate the count transitions with `AnimatedNumber` where the value changes often.

**Accessibility/edge cases:** Secondary metrics must not replace the descriptive sentence; both purpose and status need to remain visible.

**25. Home pinned pages reordering**

**Where:** `home/page.tsx`, `use-favorites`, `sidebar.tsx`

**Idea:** Let desktop users reorder pinned pages on the home screen to match their real workflow.

**Plan:**
- Add drag handles or up/down controls to the pinned page cards while persisting the order beside favorites.
- Keep the sidebar pinned list and home pinned list in sync so the dashboard has one mental model.
- Show a small “last used” timestamp on each pin to help users prune stale shortcuts.

**Accessibility/edge cases:** Provide non-drag reorder controls so keyboard users can move items too.

**26. Cluster filter workspace**

**Where:** `apps/infraweaver-console/src/app/(dashboard)/cluster/page.tsx`, `ToolbarSearchInput`, `RefreshCountdown`

**Idea:** The cluster filter bar should act like a reusable desktop workspace for node operations.

**Plan:**
- Save the last-used node filter and search term so operators coming back to “high pressure” or “cordoned” views land where they left off.
- Add a compact summary chip row under the search field showing visible node count, migratable pods, and active refresh cadence.
- Allow `Esc` to reset only transient filters while preserving the saved default view.

**Accessibility/edge cases:** Saved filters must not hide nodes unexpectedly for first-time visitors; offer a visible “reset to all” path.

**27. Cluster node card sparklines**

**Where:** `cluster/page.tsx`, `MetricSparkline`, node card grid

**Idea:** Each node card should show short CPU and memory trends so desktop users can compare nodes side by side without opening another panel.

**Plan:**
- Track recent node metric samples keyed by node name and render separate CPU and memory sparklines in the card footer.
- Color the sparkline based on the same thresholds used in node heat cards and quota bars.
- Keep the card readable by pairing the trend with the current percent label.

**Accessibility/edge cases:** The sparklines need descriptive `aria-label`s and should degrade to plain numbers if chart rendering fails.

**28. Cluster 1-hour live metrics story**

**Where:** `cluster/page.tsx`, `MetricAreaChart`, `RefreshCountdown`

**Idea:** The “Live Metrics” section should clearly read as a short-term desktop trend board.

**Plan:**
- Extend the sample history to cover roughly an hour using the selected refresh cadence and label the effective time span in the panel header.
- Add peak/min annotations for CPU and memory so users do not need to eyeball the chart.
- Keep the charts side by side on desktop and stacked on narrower layouts.

**Accessibility/edge cases:** Chart tooltips must have text alternatives and remain usable with reduced motion.

**29. Cluster heatmap threshold legend**

**Where:** `cluster/page.tsx`, `NodeHeatCard`, `SegmentedBar`

**Idea:** The node heatmap needs an explicit legend so “pressure” is visually obvious instead of implied by card colors.

**Plan:**
- Add a slim legend row above the heatmap for healthy / warning / critical bands with numeric thresholds.
- Use the same 60/80 or 70/90 breakpoints already present in metric logic to avoid conflicting rules.
- Let the legend filter the heatmap when clicked so users can isolate hot nodes instantly.

**Accessibility/edge cases:** Filtering by color band must also update visible text, not just repaint the cards.

**30. Cluster smart-drain comparison drawer**

**Where:** `cluster/page.tsx`, `MigratePodModal`, smart drain workflow

**Idea:** Before draining, desktop users should see a side-by-side capacity comparison of source and target nodes.

**Plan:**
- Add a preview drawer that summarizes movable pods, predicted target saturation, and skipped workloads before the drain begins.
- Reuse the quota and capacity bar styles already present on the page for a consistent visual language.
- Show an execution timeline below the confirmation button once the drain starts.

**Accessibility/edge cases:** Destructive actions need explicit confirmation language and should never rely on color to indicate risk.

**31. Cluster quota hotspot compare drawer**

**Where:** `cluster/page.tsx`, quota hotspot cards, `ResourceBar`

**Idea:** Let users compare hotspot namespaces side by side from the cluster page instead of jumping into `/quota`.

**Plan:**
- Add a desktop drawer that opens from a quota hotspot card and shows all resource bars for the selected namespace.
- Allow a second namespace to be pinned for side-by-side comparison.
- Surface a suggested follow-up link to `/quota` when the comparison exceeds the drawer’s scope.

**Accessibility/edge cases:** The comparison drawer should not trap users inside nested scroll areas without a clear close control.

**32. Apps list composite health/sync badges**

**Where:** `apps/page.tsx`, `StatusBadge`, ArgoCD data from `useArgoApps`

**Idea:** Replace duplicated health and sync pills with a compact desktop-ready composite summary.

**Plan:**
- Use one leading badge for health and one subordinate tag for sync only when it differs from healthy/synced happy path.
- Collapse repetitive badge stacks in dense list and grid layouts to keep app cards scan-friendly.
- Keep the full state available in hover/tooltips or a details row.

**Accessibility/edge cases:** Composite badges still need text labels for both states; the hidden secondary state must remain discoverable to keyboard users.

**33. Apps list density-aware views**

**Where:** `apps/page.tsx`, `DensityToggle`, app card/list modes

**Idea:** Desktop users should be able to fit more apps on screen without losing critical state.

**Plan:**
- Introduce compact, comfortable, and spacious variants for the installed-app grid and table/list views.
- Tighten icon, badge, and spacing rules in compact mode while keeping action buttons discoverable.
- Remember the view mode and density combination per user preference.

**Accessibility/edge cases:** Compact mode cannot hide text that is the only explanation of a badge or link destination.

**34. Apps list resource mini-graphs**

**Where:** `apps/page.tsx`, app cards, `MetricSparkline`

**Idea:** Each desktop app card should preview 1-hour CPU/memory or sync-activity trends.

**Plan:**
- Add a tiny trend strip to the card footer that shows either runtime resource usage or recent deployment activity.
- Use blue for steady-state GitOps activity and amber/red when drift or degraded health exists.
- Keep the graph optional so cards remain fast even when metrics are unavailable.

**Accessibility/edge cases:** Cards must still communicate state clearly when trend data is missing or loading.

**35. App detail split inspector**

**Where:** `apps/[name]/page.tsx`, tabs for overview/logs/activity/config/permissions`

**Idea:** Desktop app detail should use horizontal space for an inspector rather than forcing constant tab swapping.

**Plan:**
- Turn the resource list into a left pane and use the right pane for logs, YAML, health, or RBAC details based on the selected resource.
- Preserve the existing tabs as mode switches for the inspector, not the whole page.
- Remember the active tab and pane size for the current app.

**Accessibility/edge cases:** The split view must collapse gracefully to a single column when viewport width is reduced.

**36. Pods page ResourceTable migration**

**Where:** `apps/infraweaver-console/src/app/(dashboard)/pods/page.tsx`, `ResourceTable`

**Idea:** Migrate the desktop pod table to the shared `ResourceTable` so column visibility, density, and sorting behave consistently.

**Plan:**
- Map the current bespoke table columns into `ResourceTable` definitions and keep `mobileCardRender` for smaller layouts.
- Add saved column views for “Operations”, “Scheduling”, and “Containers”.
- Reuse `StatusBadge`, `SearchInput`, and the new table toolbar patterns instead of page-local table styling.

**Accessibility/edge cases:** The migration must preserve row click behavior and keep pod names readable when columns are hidden.

**37. Pod detail split YAML/events inspector**

**Where:** `pods/[namespace]/[name]/page.tsx`

**Idea:** On desktop, pod details should allow the overview to stay visible while YAML, logs, and events rotate in a secondary pane.

**Plan:**
- Keep the summary cards pinned on the left and show the selected detail tab in a right-side inspector.
- Add copy helpers for image, node, IP, labels, and container resources directly in the summary.
- Highlight readiness transitions and restart counts in the inspector header.

**Accessibility/edge cases:** Users must still reach all content in a linear order with keyboard navigation when the split view is active.

**38. Logs page saved split-pane presets**

**Where:** `logs/page.tsx`, `react-resizable-panels`, `PodSelectorTree`, `LogStreamViewer`

**Idea:** Desktop operators need to preserve their preferred selector/log ratio and quickly toggle between “wide viewer” and “browse” modes.

**Plan:**
- Store the panel sizes from `react-resizable-panels` in user preferences.
- Add buttons for “focus logs”, “focus selector”, and “balanced” presets in the `PageHeader` actions.
- Keep the last pod/container selection bound to the active preset.

**Accessibility/edge cases:** Resizable handles need visible focus styling and a non-drag way to reset layout.

**39. Inline log find and jump**

**Where:** `logs/page.tsx`, `LogStreamViewer`

**Idea:** Desktop log analysis needs in-stream find/jump instead of relying only on the selector tree.

**Plan:**
- Add a local search bar inside the log viewer with next/previous result controls.
- Highlight matches using a non-destructive overlay so ANSI or colorized logs remain readable.
- Persist the last query only for the current pod/container to avoid cross-context confusion.

**Accessibility/edge cases:** Highlight colors must remain high-contrast in both dark and light themes.

**40. Log analytics autopopulation**

**Where:** `log-analytics/page.tsx`

**Idea:** Reduce desktop friction by preselecting the most likely namespace/pod/container trio instead of starting from empty dropdowns.

**Plan:**
- Seed the selectors from the current logs-page selection or the most recent successful run.
- Prefetch dependent lists when the parent select opens so the workflow feels instant.
- Add saved presets for “app logs”, “system logs”, and “error-heavy pods”.

**Accessibility/edge cases:** Auto-selection should be reversible and clearly visible so users know the page made a choice for them.

**41. Events command center header**

**Where:** `events/page.tsx`, `PageHeader`, `StatusBadge`, `SegmentedBar`

**Idea:** Turn the events page into a desktop triage hub with a strong severity story above the feed.

**Plan:**
- Add a segmented severity bar showing errors, warnings, normals, and acknowledged warnings.
- Expose a “focus mode” for only unacknowledged warnings while preserving the current filter bar.
- Show the current refresh status and data source state in the header rather than as isolated controls.

**Accessibility/edge cases:** Acknowledged vs open states must be distinguishable beyond color and remain understandable in screen-reader output.

**42. Events acknowledgement work queue**

**Where:** `events/page.tsx`, `lib/event-ack.ts`

**Idea:** Make acknowledgements feel like a desktop workflow, not a raw toggle.

**Plan:**
- Group visible warnings by namespace or involved object and let users acknowledge groups from a side panel.
- Add timestamps and acknowledgement age to the local acknowledgement model.
- Surface quick “reopen” or “show hidden” actions when hide-acked mode is on.

**Accessibility/edge cases:** Users need a clear way to understand whether acknowledgements are local-browser only or shared state.

**43. Monitoring narrative dashboard**

**Where:** `monitoring/page.tsx`, `DashboardPanel`, `HealthTimeline`, `RefreshCountdown`

**Idea:** The desktop monitoring page should tell a story from SLA to incidents to current risk instead of reading like a stack of widgets.

**Plan:**
- Reorder the page into a top narrative band: SLA cards, current incidents, and latency trend first.
- Keep secondary technical panels below the fold inside `DashboardPanel` sections.
- Use a shared incident color language so monitoring, health, and events are visually aligned.

**Accessibility/edge cases:** Do not rely on chart color alone to explain whether a service is failing or merely slow.

**44. Health page right-side endpoint inspector**

**Where:** `health/page.tsx`, `HealthTimeline`, health cards

**Idea:** Use desktop width for a persistent endpoint inspector that opens alongside the endpoint list.

**Plan:**
- Keep the endpoint cards/list on the left and open a detail pane on the right with last checks, response history, and SLA explanation.
- Add a tiny line chart for response time and a textual incident summary in the pane header.
- Preserve the selected endpoint in the URL query string for sharable links.

**Accessibility/edge cases:** The inspector must be closable and should not create two competing primary scroll regions without clear focus handling.

**45. Health tester request presets**

**Where:** `health-tester/page.tsx`

**Idea:** Desktop users often retest the same endpoints; the page should remember useful request presets.

**Plan:**
- Add saved presets for name, URL, method, and timeout with an inline preset switcher.
- Show last result status and latency next to each preset for quick regression checks.
- Keep the batch-test action pinned in the header when multiple presets exist.

**Accessibility/edge cases:** Preset names must be editable without depending on drag/drop or icon-only actions.

**46. Uptime endpoint micro-histories**

**Where:** `uptime/page.tsx`, `MetricSparkline`, status legend

**Idea:** Replace the purely dot-based history with a compact desktop sparkline plus uptime badge to reveal direction and volatility.

**Plan:**
- Keep the dots for incident detection but add a thin response/availability trend beside each endpoint.
- Add sort modes for “lowest uptime”, “most volatile”, and “slowest average latency”.
- Let hovering either history view show exact timestamps and result reasons.

**Accessibility/edge cases:** The history view needs a textual explanation for the meaning of dots and sparkline movement.

**47. Node-top sticky leaderboard**

**Where:** `node-top/page.tsx`, `SortableHeader`, export controls

**Idea:** The desktop node-top page should feel like a leaderboard with a stable header and saved sort/filter state.

**Plan:**
- Freeze the table header and the node name column during scroll.
- Persist the last sort and export format so operators can reopen the page in their preferred order.
- Add quick filter chips for CPU, memory, system pods, and namespaces.

**Accessibility/edge cases:** Sticky columns must not cover cell focus outlines or clip long node names.

**48. Namespace cleanup preview diff drawer**

**Where:** `namespace-cleanup/page.tsx`

**Idea:** Use desktop space for a two-pane preview: list on the left, destructive preview on the right.

**Plan:**
- Keep candidate namespaces in a stable list while the right pane shows the exact resources that would be removed.
- Add diff-like coloring for “safe”, “requires manual review”, and “blocked by policy”.
- Let users compare two namespaces without closing the preview.

**Accessibility/edge cases:** Destructive preview states need explicit text labels and not only warning colors.

**49. PV browser compare mode**

**Where:** `pv-browser/page.tsx`

**Idea:** Desktop storage review benefits from comparing a PV and its PVC together instead of tab-switching.

**Plan:**
- Add a compare toggle that shows the related PV/PVC pair side by side with status, size, storage class, and claim history.
- Highlight mismatches such as capacity drift or missing claims in amber/red badges.
- Keep the existing tab mode as a simpler fallback.

**Accessibility/edge cases:** Side-by-side compare must remain readable at common desktop widths and collapse cleanly if no pair exists.

**50. Storage timeline ribbon charts**

**Where:** `storage-timeline/page.tsx`, `MetricSparkline`

**Idea:** Replace the static feeling of the timeline table with slim utilization ribbons that show change over time.

**Plan:**
- Add a small trend strip per volume for utilization, replica health, or reclaim progress.
- Make the ribbons sortable by current utilization or growth rate.
- Use a shared tooltip style with `MetricAreaChart` so storage visuals feel related to cluster charts.

**Accessibility/edge cases:** Volume names must remain the primary content; ribbons are secondary signal, not the only clue.

**51. Storage threshold bands**

**Where:** `storage/page.tsx`, `ResourceBar`, pie/chart components

**Idea:** Make every storage bar reveal what “healthy”, “warning”, and “critical” mean.

**Plan:**
- Add threshold markers and labels directly on `ResourceBar` so the operator sees 65/85/95% bands at a glance.
- Pair the bar with exact used/total capacity and predicted headroom text.
- Reuse the same threshold language in the pie-chart legend and volume table badges.

**Accessibility/edge cases:** Thresholds must remain visible in light mode and understandable without color alone.

**52. Storage hot-volume spotlight**

**Where:** `storage/page.tsx`, `DashboardPanel`, `DataCard`

**Idea:** Highlight the noisiest or fullest volumes in a desktop spotlight panel above the long table.

**Plan:**
- Create a “Hot volumes” strip using `DataCard` or a compact card variant for the top 3 risky volumes.
- Show utilization, replica state, and direct actions like “open timeline”.
- Keep the full table below for exhaustive inspection.

**Accessibility/edge cases:** Spotlight panels must not hide volumes that are important but simply do not rank high by utilization.

**53. Network topology minimap and focus mode**

**Where:** `network/page.tsx`, topology SVG section, `CollapsibleSection`

**Idea:** The network topology should behave like a desktop canvas with zoomed focus rather than a static SVG block.

**Plan:**
- Add a minimap and focus chips for service, peer, or ingress overlays.
- Let hovering a service highlight related peers and routes without leaving the page.
- Add a desktop-only “focus mode” that widens the topology panel and dims peripheral cards.

**Accessibility/edge cases:** Hover interactions need keyboard equivalents such as focusable nodes with the same highlight behavior.

**54. Network peer compare cards**

**Where:** `network/page.tsx`, NetBird peer cards

**Idea:** Desktop users should be able to compare two peers’ health and recency without mentally juggling cards.

**Plan:**
- Add a compare toggle that pins one peer and overlays delta badges for latency, last seen, and status against another peer.
- Introduce sorting by “stale”, “offline”, and “recently restored”.
- Link the compare row into `/dns` or route views when a peer affects reachability.

**Accessibility/edge cases:** Comparison states must be announced clearly and removable without pointer-only interaction.

**55. Network policies YAML diff and copy tools**

**Where:** `network-policies/page.tsx`, expanded YAML rows, `CopyButton`

**Idea:** Expanded YAML on desktop should be easier to scan, diff, and reuse.

**Plan:**
- Add copy and compare actions directly in the expanded row header.
- Preserve expansion state while filters change so desktop users can inspect several policies in sequence.
- Add inline syntax highlighting for rule sections such as ingress/egress and pod selectors.

**Accessibility/edge cases:** Expanded content should be reachable after the row trigger and remain understandable without colorized syntax.

**56. Ingress host cards with route health**

**Where:** `ingress/page.tsx`

**Idea:** Desktop ingress cards should show not only configuration but also confidence that the route is working.

**Plan:**
- Add host-level health badges, TLS presence, and latency/availability hints beside each route card.
- Surface middleware counts and backend fan-out in compact stat blocks.
- Use color-coded host pills that match `StatusBadge` semantics instead of ad-hoc text styling.

**Accessibility/edge cases:** Internal vs external route states must have text labels, not only different hues.

**57. Certificates expiry heat ladder**

**Where:** `certificates/page.tsx`, expiry countdown cards

**Idea:** Desktop operators need a stronger visual gradient between “renew later” and “renew now”.

**Plan:**
- Replace plain day counters with a heat ladder using green/amber/red bands and exact dates.
- Group certificates by expiry window (7, 30, 90+ days) at the top of the page.
- Add a quick filter to show only expiring or externally facing certificates.

**Accessibility/edge cases:** Exact expiry dates must remain readable even if the color scheme is not perceived.

**58. Certificates renewal queue**

**Where:** `certificates/page.tsx`, `PageHeader`, `EmptyState`

**Idea:** Turn expiring certs into a desktop work queue rather than a passive list.

**Plan:**
- Add a “Renewal queue” panel that sorts expiring certs by urgency and business importance.
- Provide actions like “open issuer details”, “copy DNS names”, and “jump to ingress”.
- Show completion state once a cert returns to a safe window after renewal.

**Accessibility/edge cases:** Queue actions must not assume automation exists; if renewal is manual the copy should explain that.

**59. Cronjobs micro timeline**

**Where:** `cronjobs/page.tsx`

**Idea:** Replace tiny recent-job dots with a richer desktop micro timeline.

**Plan:**
- Render the last N runs as a horizontal strip with color-coded success/failure duration markers.
- Add a hover summary for start time, duration, and exit outcome.
- Let the user switch between “last 10 runs” and “last 24 hours”.

**Accessibility/edge cases:** Timeline dots need textual equivalents for users who cannot distinguish the colors or hover states.

**60. Cronjobs next-run rail**

**Where:** `cronjobs/page.tsx`, `cron-utils.ts`

**Idea:** Use desktop horizontal space to show when jobs are expected to fire next.

**Plan:**
- Build a simple time rail using parsed cron output from `cron-utils.ts` for the next few scheduled executions.
- Group jobs visually when several fire in the same hour to expose contention.
- Highlight overdue or suspended jobs with the same warning palette used elsewhere.

**Accessibility/edge cases:** Time rails need timezone clarity and should never imply exact guarantees when schedules are approximate.

**61. Quota threshold legend and warnings**

**Where:** `quota/page.tsx`, `ResourceBar`

**Idea:** The quota page should explain pressure explicitly instead of leaving users to infer what 71% means.

**Plan:**
- Add a top legend for safe/warning/critical with the threshold percentages already used in the bars.
- Show a warning banner when any namespace crosses the critical threshold.
- Keep used/hard values aligned to the right so desktop scanning is faster.

**Accessibility/edge cases:** Warning banners should not duplicate the same information endlessly for every namespace.

**62. Cost time-range switching**

**Where:** `cost/page.tsx`, Recharts usage

**Idea:** Desktop cost analysis needs quick time-range switching without burying the user in chart controls.

**Plan:**
- Add 7d / 30d / 90d segmented controls above the namespace cost chart.
- Reflect the selected range in subtitles and export metadata.
- Use a consistent tooltip format with currency and trend direction.

**Accessibility/edge cases:** Currency formatting must be explicit and not depend on locale guesses alone.

**63. Cost compare columns**

**Where:** `cost/page.tsx`, namespace cost table

**Idea:** Make cost tables more actionable by comparing current cost with prior period and efficiency signals.

**Plan:**
- Add delta columns for change vs previous period and simple efficiency badges from resource usage context.
- Let users hide/show delta columns with the same table controls used elsewhere.
- Highlight sudden jumps with amber/red rather than silently sorting them into a long list.

**Accessibility/edge cases:** Negative and positive deltas need symbols and words, not only color-coded signs.

**64. DNS saved filters and bulk export**

**Where:** `dns/page.tsx`, `ExportButton`, search/pagination controls

**Idea:** DNS is a classic desktop data-management page; it needs reusable filtered views and exports.

**Plan:**
- Add saved views for “internal”, “public”, “TXT”, “records with notes”, and “recently changed”.
- Extend `ExportButton` to export the visible filtered set instead of the whole table only.
- Keep filter state pinned above the table with removable chips.

**Accessibility/edge cases:** Saved views should respect RBAC and never expose records a user cannot currently see.

**65. Registry tag health ribbon**

**Where:** `registry/page.tsx`, tag rows, `CopyButton`

**Idea:** The registry page should surface age, size, and risk in a compact desktop ribbon per repository/tag.

**Plan:**
- Add small inline pills for “new”, “stale”, “large”, and “in use” beside tags.
- Link tag rows to image vulnerability pages when a digest is already known there.
- Keep pull-command copy affordances anchored in one predictable place per row.

**Accessibility/edge cases:** Ribbon labels must remain text-first so operators do not need to memorize icon meaning.

**66. Config Drift summary header**

**Where:** `config-drift/page.tsx`, `DashboardPanel`, `DashboardStatCard`, `ResourceTable`

**Idea:** Give config drift a desktop summary tier before the table so the user sees urgency instantly.

**Plan:**
- Add summary cards for tracked workloads, drifted workloads, and baseline freshness above the `ResourceTable`.
- Use the table toolbar to persist a drift-focused column view and sort order.
- Add a direct “show only drifted” quick filter chip near the search field.

**Accessibility/edge cases:** If baseline data is missing, the summary tier must clearly explain why the drift state cannot be trusted.

**67. Config Drift focus mode**

**Where:** `config-drift/page.tsx`, baseline/current image columns

**Idea:** Desktop users should be able to switch from list scanning to a drift-only inspection mode.

**Plan:**
- Collapse low-signal columns and expand image/replica drift columns in a “focus mode”.
- Add inline diff highlighting for changed image tags and replica count mismatches.
- Keep the mode persistent per user so the page reopens in the preferred inspection layout.

**Accessibility/edge cases:** Highlighted diffs need text markers such as arrows and labels so changes remain understandable without color.

**68. Deployment Compare semantic JSON diff**

**Where:** `deployment-compare/page.tsx`

**Idea:** Replace raw side-by-side JSON dumps with a semantic diff that uses desktop width effectively.

**Plan:**
- Add a line-aware diff view with added/removed/changed highlighting and foldable unchanged regions.
- Provide a concise “changed fields” summary above the full payloads.
- Include copy buttons for left, right, and diff-only output.

**Accessibility/edge cases:** Diff colors must be paired with plus/minus labels or icons so the change type is unambiguous.

**69. GitOps diff grouped sections**

**Where:** `gitops-diff/page.tsx`

**Idea:** The GitOps diff page should group changes by file or resource so long diff output becomes navigable on desktop.

**Plan:**
- Detect hunk boundaries and render collapsible groups with a summary of adds/removes.
- Add a sticky mini-index on the right for quick jumps to changed resources.
- Keep a raw-text toggle for users who still want the full CLI-like diff.

**Accessibility/edge cases:** The grouped view cannot hide important content by default without an obvious way to expand it.

**70. Resource optimizer patch drawer**

**Where:** `resource-optimizer/page.tsx`

**Idea:** Turn recommendations into a desktop workflow by previewing the generated patch before apply/copy.

**Plan:**
- Add a drawer that builds a YAML patch from selected rows and displays affected requests/limits side by side.
- Pair the patch with restart-impact notes or rollout warnings.
- Offer copy, export, and “open in config diff” actions from the drawer footer.

**Accessibility/edge cases:** Patch previews must remain selectable and copyable without relying on custom drag interactions.

**71. Scheduled tasks cron timeline**

**Where:** `scheduled-tasks/page.tsx`, `ResourceTable`, `cron-utils.ts`

**Idea:** Make cron-based automation easier to reason about on desktop with a visual next-run summary.

**Plan:**
- Add a “next 3 runs” computed column or expandable detail row using `cron-utils.ts`.
- Let the `ResourceTable` save a compact operational column set versus an authoring-focused set.
- Show enabled/disabled state with richer `StatusBadge` descriptions.

**Accessibility/edge cases:** Cron previews should explain timezone and not imply guaranteed execution when the cluster is degraded.

**72. Status page latency sparklines**

**Where:** `status/page.tsx`, `RefreshCountdown`, status cards

**Idea:** Service status is more informative when latency direction is visible beside current state.

**Plan:**
- Add a latency or availability sparkline to each service card in the desktop grid.
- Group cards into healthy, degraded, and unreachable bands using a segmented header.
- Keep the auto-refresh explanation concise and visible in the page header.

**Accessibility/edge cases:** Sparkline movement must be backed by text like “latency rising” or “stable”.

**73. Security posture landing tier**

**Where:** `security/page.tsx`, `DashboardPanel`, `CollapsibleSection`, audit-related panels

**Idea:** The security page is dense enough to need a desktop overview layer before detailed sections.

**Plan:**
- Add a top posture strip with critical findings, certificate issues, image issues, policy failures, and auth events.
- Sort detailed sections by severity and recent change rather than a static document order.
- Use stronger section dividers and severity badges so the page reads like triage, not a dump.

**Accessibility/edge cases:** Severity ordering must not hide low-severity items permanently; all sections still need discoverable navigation.

**74. Image vulnerability severity matrix**

**Where:** `image-vulnerabilities/page.tsx`, `StatusBadge`

**Idea:** Desktop users should be able to compare repositories and severity distribution without reading one long list.

**Plan:**
- Add a matrix view with repositories on the left and severity bands across the top.
- Use `StatusBadge` variants for trusted/untrusted state and filter chips for “critical only” or “untrusted only”.
- Provide a drill-down drawer for the selected image digest.

**Accessibility/edge cases:** The matrix must include numeric labels because cell color saturation alone is insufficient.

**75. RBAC visual graph canvas**

**Where:** `rbac-viz/page.tsx`, `settings/rbac/page.tsx`, `navigation-rbac.ts`

**Idea:** The RBAC “viz” page should actually visualize relationships between subject, role, and scope on desktop.

**Plan:**
- Replace the two-column list with a node-link canvas or at minimum a layered relationship board.
- Add hover/focus highlighting from subject → binding → permission area.
- Cross-link the visual view to the configuration page so edits are one click away.

**Accessibility/edge cases:** Provide a list/table fallback for users who cannot effectively use a graph view.

**76. Users role heatmap**

**Where:** `users/page.tsx`, role config tables, permission matrix

**Idea:** Large desktop screens are ideal for a permission heatmap that summarizes who can do what.

**Plan:**
- Add a heatmap row/column view with users or roles on one axis and product areas on the other.
- Keep the current detailed matrix as an expandable detail mode for exact permissions.
- Use sticky headers and a filter for dormant users or high-privilege roles.

**Accessibility/edge cases:** Heatmaps need numeric or textual cell labels so permission density is understandable without color.

**77. Users invite workflow status rail**

**Where:** `users/page.tsx`, invite modal, access badges

**Idea:** Desktop invitation flows should show progress, not just a modal submission.

**Plan:**
- Add invite states such as drafted, sent, accepted, expired, and revoked in a small timeline rail.
- Surface pending invites as a dedicated list section with resend and copy-invite actions.
- Reuse `StatusBadge` descriptions to explain each invite state.

**Accessibility/edge cases:** Expired and pending states must be understandable to assistive tech and not rely on badge color only.

**78. Settings search and quick-links**

**Where:** `settings/page.tsx`, `ThemeToggle`, `DensityToggle`, tab buttons

**Idea:** Desktop settings should be searchable because the page already spans multiple conceptual areas.

**Plan:**
- Add a local settings search that filters cards and scrolls to matches.
- Surface quick links for theme, density, refresh interval, and platform editor in a sticky side rail on xl+ screens.
- Keep general/platform tabs but show match counts on each tab.

**Accessibility/edge cases:** Search results must preserve the original heading structure so screen-reader navigation still works.

**79. Addon dependency map**

**Where:** `settings/addons/page.tsx`, addon card grid

**Idea:** Desktop addon management should reveal which addons depend on others or enhance a shared workflow.

**Plan:**
- Add dependency badges and a simple relationship drawer for each addon card.
- Group addons into enabled, recommended, and inactive sections with counts.
- Show direct links to setup pages or health pages when an addon is enabled but misconfigured.

**Accessibility/edge cases:** Relationship lines or grouping must have textual summaries for users who cannot follow a visual map.

**80. RBAC task-based permission builder**

**Where:** `settings/rbac/page.tsx`, `navigation-rbac.ts`

**Idea:** Help desktop admins assign permissions by real tasks instead of raw permission strings.

**Plan:**
- Add presets such as “Operate apps”, “Inspect logs”, “Manage storage”, and “Administer security”.
- Show which exact permissions each preset toggles and which nav groups it unlocks.
- Provide a side-by-side diff before saving role changes.

**Accessibility/edge cases:** Presets should never hide the underlying permissions; expert users still need transparent control.

**81. Game Hub capacity board**

**Where:** `game-hub/page.tsx`, server cards, `ResourceBar`, `StatusBadge`

**Idea:** The Game Hub landing page should become a desktop capacity board for all game servers.

**Plan:**
- Add a top summary row for total players, hot servers, memory pressure, and offline servers.
- Show live resource mini-graphs directly on server cards and a quick filter for “needs attention”.
- Support multi-select and bulk start/stop on desktop card grids.

**Accessibility/edge cases:** Bulk actions must be disabled with explicit explanations when no server is eligible.

**82. Game Hub detail activity split view**

**Where:** `game-hub/[name]/page.tsx`

**Idea:** The server detail page should keep server state visible while swapping console, players, files, and activity in a secondary desktop pane.

**Plan:**
- Make the left rail a persistent summary with status, version, resources, and actions.
- Use the right pane for the active tab content with per-tab toolbar actions.
- Remember the active tab and pane sizing per server.

**Accessibility/edge cases:** When the split view collapses, the active pane order must remain predictable and readable.

**83. Game Hub create wizard sticky review panel**

**Where:** `game-hub/new/page.tsx`, `onboarding-wizard.tsx`

**Idea:** Keep the user’s choices visible during the multi-step server creation wizard.

**Plan:**
- Add a sticky right-hand summary on desktop showing game, resources, ports, storage, and selected template.
- Update the summary live as fields change and highlight missing required fields.
- Add an estimated cost/capacity note where applicable.

**Accessibility/edge cases:** The sticky review panel must not obscure step navigation or trap keyboard focus.

**84. Gameservers bulk toolbar**

**Where:** `gameservers/page.tsx`, card/list toggle, action buttons

**Idea:** Desktop gameserver operations benefit from selection and bulk management patterns.

**Plan:**
- Add checkbox selection in list view and a floating bulk-action toolbar for start/stop/restart/delete.
- Show selection count, incompatible actions, and confirmation text clearly.
- Preserve the existing single-row actions for quick one-off management.

**Accessibility/edge cases:** Bulk selections must be announced and easy to clear without pointer-only interactions.

**85. Pipelines success-rate trend strip**

**Where:** `pipelines/page.tsx`, summary metrics grid, refresh workflow

**Idea:** CI/CD monitoring on desktop should reveal recent health direction, not only current counts.

**Plan:**
- Add a sparkline or compact bar trend for passing, failing, and running workflows across recent runs.
- Make the top summary cards clickable filters for the main pipeline list.
- Surface queue age and longest-running job as quick badges.

**Accessibility/edge cases:** Trend visuals need descriptive text like “pass rate improving” or “failures spiking”.

**86. Maintenance window timeline**

**Where:** `maintenance/page.tsx`

**Idea:** Maintenance mode should feel like a schedule-aware desktop control surface.

**Plan:**
- Add a simple future timeline for planned maintenance windows per app/service.
- Distinguish current, scheduled, and expired windows with shared status language.
- Allow quick links into the affected app or service page from the timeline row.

**Accessibility/edge cases:** Planned windows need exact timestamps and timezone labels, not only relative phrases.

**87. Secret expiry rotation board**

**Where:** `secret-expiry/page.tsx`

**Idea:** Present expiring secrets as a desktop rotation queue instead of a plain summary and table.

**Plan:**
- Create buckets for critical, soon, and healthy secrets with counts and fast filters.
- Show namespace, owner workload, and next action in a card/table hybrid view.
- Add copyable rotation notes or destination links where available.

**Accessibility/edge cases:** “Soon” and “critical” must be defined numerically on screen, not only implied by color.

**88. All Services spotlight cards**

**Where:** `all-services/page.tsx`, search, favorites toggle

**Idea:** The all-services grid should support desktop discovery by elevating favorite and recently used tools.

**Plan:**
- Add spotlight sections for pinned services, recently opened services, and admin-only utilities.
- Show lightweight tags for category, risk, or external-link behavior on each card.
- Keep the search result count pinned while the user scrolls the grid.

**Accessibility/edge cases:** The spotlight order must not bury the complete alphabetical/service-group access path.

**89. App graph hover inspector**

**Where:** `app-graph/page.tsx`

**Idea:** The app graph is naturally a desktop inspection surface and should expose details without navigation.

**Plan:**
- Add a hover/focus inspector that shows resource owner, health, dependencies, and quick links.
- Color the graph by health or sync mode via a toggle in the header.
- Let users pin a node so other related nodes stay highlighted.

**Accessibility/edge cases:** Every hover interaction must have a keyboard-focus equivalent and a textual summary region.

**90. Community apps confidence badges**

**Where:** `community-apps/page.tsx`, install/deploy workflows

**Idea:** Help desktop users evaluate community apps before deployment by showing confidence signals in the list.

**Plan:**
- Add badges for update recency, manifest completeness, docs availability, and install success history.
- Use the install card footer for “requires manual config”, “Helm-ready”, or “experimental” notes.
- Link confidence signals to the deploy or convert actions.

**Accessibility/edge cases:** Confidence badges must be explained in text so users do not need to infer meaning from iconography.

**91. Config editor side-by-side draft/live mode**

**Where:** `config/page.tsx`, `platform-editor-panel.tsx`

**Idea:** Desktop config editing should support comparing the current live config with the draft being edited.

**Plan:**
- Add a split editor mode with the live config on one side and the editable draft on the other.
- Show unsaved changes count, modified sections, and validation state in the header.
- Reuse copy/export helpers so users can safely extract either side.

**Accessibility/edge cases:** Side-by-side editors must still be usable with keyboard and high zoom settings.

**92. Profile activity heatmap**

**Where:** `profile/page.tsx`, session/activity tabs

**Idea:** Turn profile activity into a desktop-friendly heatmap and session timeline.

**Plan:**
- Add a weekly/monthly activity heatmap for navigation and changes, plus a list of active sessions.
- Highlight unusual session patterns or recent privileged actions with badges.
- Keep inline profile editing available without displacing the activity context.

**Accessibility/edge cases:** Heatmap data needs textual totals and date labels for screen-reader use.

**93. Webhook tester response diff and saves**

**Where:** `webhook-tester/page.tsx`

**Idea:** Desktop webhook debugging benefits from comparing responses over several runs.

**Plan:**
- Save recent test payloads and responses in a sidebar history.
- Add compare mode to diff the last response against the current one.
- Surface status, latency, and content-type as a compact summary before the raw body.

**Accessibility/edge cases:** Diff views should preserve plain-text readability and not depend on syntax coloring alone.

**94. Pod shell snippet bar**

**Where:** `pod-shell/page.tsx`, `CopyButton`

**Idea:** The pod shell page should help operators reuse common commands without retyping.

**Plan:**
- Add a horizontal snippet bar for common debugging commands such as `ls`, `env`, `df -h`, and log paths.
- Let users save a small personal snippet set per namespace or workload type.
- Keep snippet insertion separate from execution so commands are never run accidentally.

**Accessibility/edge cases:** Insert and run must be distinct controls with explicit labels to avoid dangerous mistakes.

**95. Tests and self-test result timeline**

**Where:** `tests/page.tsx`, `self-test/page.tsx`, `StatusBadge`, `DashboardStatCard`

**Idea:** Show recent run history so desktop users can judge whether failures are new, transient, or recurring.

**Plan:**
- Add a result timeline strip above the latest run summary for both pages.
- Use shared success/warning/error semantics so test health matches the rest of the dashboard.
- Provide quick links to logs or failing categories when a run regresses.

**Accessibility/edge cases:** Timelines need textual summaries like “3 passing runs, 1 failing run” alongside the visual markers.

**96. Wiki desktop reading mode with TOC rail**

**Where:** `wiki/page.tsx`, `wiki/[...slug]/page.tsx`

**Idea:** Use desktop width for a documentation reading layout with a sticky table of contents and reading progress.

**Plan:**
- Add a right-hand TOC rail generated from headings in the rendered markdown.
- Provide a “focus reading” toggle that hides nonessential shell chrome while staying inside the app.
- Show related pages or recently viewed docs in a subtle left-side rail.

**Accessibility/edge cases:** Heading anchors and TOC items must stay keyboard-navigable and readable at high zoom.

**97. Changelog grouped by area and impact**

**Where:** `changelog/page.tsx`

**Idea:** Let desktop users scan what changed by product area rather than just in chronological order.

**Plan:**
- Group entries by shell, apps, cluster, security, gaming, and docs in addition to date.
- Highlight “operator-visible changes” vs “internal maintenance” with separate badges.
- Link each entry to the relevant page so the changelog becomes an onboarding surface.

**Accessibility/edge cases:** Grouping must preserve a sensible reading order and not require expanding dozens of accordions.

**98. Alert silence expiry bar**

**Where:** `alert-silence/page.tsx`

**Idea:** Silence management should emphasize time remaining and scope on desktop.

**Plan:**
- Add an expiry progress bar and a timeline grouping of active silences by urgency.
- Show affected matchers/targets in a compact summary row instead of only raw form fields.
- Surface quick actions to extend or expire a silence early.

**Accessibility/edge cases:** Time-remaining bars need exact dates and durations to avoid ambiguity.

**99. Export button report profiles**

**Where:** `export-button.tsx`, `cost/page.tsx`, `node-top/page.tsx`, `dns/page.tsx`

**Idea:** Treat exports as report profiles on desktop, not just file downloads.

**Plan:**
- Extend `ExportButton` so pages can expose named profiles such as “Ops review CSV”, “Finance JSON”, or “DNS change audit”.
- Include current filters, sort order, and visible columns in the export metadata.
- Keep the control visually compact and consistent across pages.

**Accessibility/edge cases:** Profile names and formats must be explicit so users do not download the wrong report accidentally.

**100. Preference-driven custom desktop dashboards**

**Where:** `query-keys.ts`, `search.ts`, `user-preferences.ts`, `home/page.tsx`, `widget-card.tsx`

**Idea:** Build toward a desktop dashboard builder where the home page is assembled from reusable widgets and remembered per user.

**Plan:**
- Use `user-preferences.ts` to store widget order, visibility, and saved filters for `WidgetCard`-based sections.
- Reuse `query-keys.ts` and `search.ts` to keep widget data fetches predictable and sharable.
- Start with a safe subset of widgets already on the home page: health summary, recent activity, pinned pages, service explorer, and quick actions.

**Accessibility/edge cases:** Widget customization must offer non-drag reorder controls and a “reset to default layout” option.

## Summary

The strongest desktop opportunities in InfraWeaver cluster around three themes: **consistent shared primitives**, **trend-aware dense dashboards**, and **split-view/operator workflows** that use widescreen layouts well. The most leverage comes from improving shared building blocks (`PageHeader`, `DashboardPanel`, `DashboardStatCard`, `StatusBadge`, `ResourceTable`, search inputs, and refresh controls), then applying them to the highest-traffic pages (`home`, `cluster`, `apps`, `events`, `logs`, `monitoring`, `storage`, `security`, and `settings`).