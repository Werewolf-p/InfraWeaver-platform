# InfraWeaver Phone UX: 100 Ideas (May 2026)

Scope: phone-first improvements for the InfraWeaver console, centered on 360–430px widths with 390px as the validation baseline.

1. **Phone summary-first layout for dashboard shell**
   - Plan: Lead the route with a compact mobile summary card that surfaces safe-area spacing, bottom nav clarity, and keyboard-safe scrolling. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/layout.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

2. **Stacked mobile actions for dashboard shell**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/layout.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

3. **Card fallback for dashboard shell**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/layout.tsx for widths below the tablet breakpoint. Each card should highlight safe-area spacing, bottom nav clarity, and keyboard-safe scrolling, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

4. **390px regression check for dashboard shell**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/layout.tsx. Verify there is no horizontal overflow, the content still emphasizes safe-area spacing, bottom nav clarity, and keyboard-safe scrolling, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

5. **Phone summary-first layout for top bar**
   - Plan: Lead the route with a compact mobile summary card that surfaces global search, notifications, and route context. Implement the summary in apps/infraweaver-console/src/components/layout/topbar.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

6. **Stacked mobile actions for top bar**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/components/layout/topbar.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

7. **Card fallback for top bar**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/components/layout/topbar.tsx for widths below the tablet breakpoint. Each card should highlight global search, notifications, and route context, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

8. **390px regression check for top bar**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/components/layout/topbar.tsx. Verify there is no horizontal overflow, the content still emphasizes global search, notifications, and route context, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

9. **Phone summary-first layout for More navigation sheet**
   - Plan: Lead the route with a compact mobile summary card that surfaces route discovery and one-thumb navigation. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/layout.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

10. **Stacked mobile actions for More navigation sheet**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/layout.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

11. **Card fallback for More navigation sheet**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/layout.tsx for widths below the tablet breakpoint. Each card should highlight route discovery and one-thumb navigation, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

12. **390px regression check for More navigation sheet**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/layout.tsx. Verify there is no horizontal overflow, the content still emphasizes route discovery and one-thumb navigation, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

13. **Phone summary-first layout for notification center**
   - Plan: Lead the route with a compact mobile summary card that surfaces alert triage and unread state. Implement the summary in apps/infraweaver-console/src/components/ui/notification-center.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

14. **Stacked mobile actions for notification center**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/components/ui/notification-center.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

15. **Card fallback for notification center**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/components/ui/notification-center.tsx for widths below the tablet breakpoint. Each card should highlight alert triage and unread state, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

16. **390px regression check for notification center**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/components/ui/notification-center.tsx. Verify there is no horizontal overflow, the content still emphasizes alert triage and unread state, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

17. **Phone summary-first layout for floating action button**
   - Plan: Lead the route with a compact mobile summary card that surfaces fast access to high-frequency actions. Implement the summary in apps/infraweaver-console/src/components/floating-action-button.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

18. **Stacked mobile actions for floating action button**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/components/floating-action-button.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

19. **Card fallback for floating action button**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/components/floating-action-button.tsx for widths below the tablet breakpoint. Each card should highlight fast access to high-frequency actions, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

20. **390px regression check for floating action button**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/components/floating-action-button.tsx. Verify there is no horizontal overflow, the content still emphasizes fast access to high-frequency actions, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

21. **Phone summary-first layout for global search**
   - Plan: Lead the route with a compact mobile summary card that surfaces recent destinations, aliases, and fast route switching. Implement the summary in top bar search flow so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

22. **Stacked mobile actions for global search**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update top bar search flow so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

23. **Card fallback for global search**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in top bar search flow for widths below the tablet breakpoint. Each card should highlight recent destinations, aliases, and fast route switching, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

24. **390px regression check for global search**
   - Plan: Add or run a repeatable 390px validation pass for top bar search flow. Verify there is no horizontal overflow, the content still emphasizes recent destinations, aliases, and fast route switching, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

25. **Phone summary-first layout for webhook tester**
   - Plan: Lead the route with a compact mobile summary card that surfaces request composition and readable responses. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/webhook-tester/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

26. **Stacked mobile actions for webhook tester**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/webhook-tester/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

27. **Card fallback for webhook tester**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/webhook-tester/page.tsx for widths below the tablet breakpoint. Each card should highlight request composition and readable responses, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

28. **390px regression check for webhook tester**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/webhook-tester/page.tsx. Verify there is no horizontal overflow, the content still emphasizes request composition and readable responses, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

29. **Phone summary-first layout for health tester**
   - Plan: Lead the route with a compact mobile summary card that surfaces endpoint status and retest actions. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/health-tester/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

30. **Stacked mobile actions for health tester**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/health-tester/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

31. **Card fallback for health tester**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/health-tester/page.tsx for widths below the tablet breakpoint. Each card should highlight endpoint status and retest actions, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

32. **390px regression check for health tester**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/health-tester/page.tsx. Verify there is no horizontal overflow, the content still emphasizes endpoint status and retest actions, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

33. **Phone summary-first layout for log analytics**
   - Plan: Lead the route with a compact mobile summary card that surfaces chart readability and query focus. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/log-analytics/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

34. **Stacked mobile actions for log analytics**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/log-analytics/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

35. **Card fallback for log analytics**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/log-analytics/page.tsx for widths below the tablet breakpoint. Each card should highlight chart readability and query focus, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

36. **390px regression check for log analytics**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/log-analytics/page.tsx. Verify there is no horizontal overflow, the content still emphasizes chart readability and query focus, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

37. **Phone summary-first layout for secret expiry**
   - Plan: Lead the route with a compact mobile summary card that surfaces expiring-secret urgency and renewal actions. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/secret-expiry/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

38. **Stacked mobile actions for secret expiry**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/secret-expiry/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

39. **Card fallback for secret expiry**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/secret-expiry/page.tsx for widths below the tablet breakpoint. Each card should highlight expiring-secret urgency and renewal actions, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

40. **390px regression check for secret expiry**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/secret-expiry/page.tsx. Verify there is no horizontal overflow, the content still emphasizes expiring-secret urgency and renewal actions, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

41. **Phone summary-first layout for cost explorer**
   - Plan: Lead the route with a compact mobile summary card that surfaces cost summaries, trends, and owner context. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

42. **Stacked mobile actions for cost explorer**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

43. **Card fallback for cost explorer**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx for widths below the tablet breakpoint. Each card should highlight cost summaries, trends, and owner context, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

44. **390px regression check for cost explorer**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/cost/page.tsx. Verify there is no horizontal overflow, the content still emphasizes cost summaries, trends, and owner context, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

45. **Phone summary-first layout for registry**
   - Plan: Lead the route with a compact mobile summary card that surfaces repo and tag management on narrow screens. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/registry/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

46. **Stacked mobile actions for registry**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/registry/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

47. **Card fallback for registry**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/registry/page.tsx for widths below the tablet breakpoint. Each card should highlight repo and tag management on narrow screens, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

48. **390px regression check for registry**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/registry/page.tsx. Verify there is no horizontal overflow, the content still emphasizes repo and tag management on narrow screens, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

49. **Phone summary-first layout for node-top**
   - Plan: Lead the route with a compact mobile summary card that surfaces hotspot visibility and saturation sorting. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/node-top/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

50. **Stacked mobile actions for node-top**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/node-top/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

51. **Card fallback for node-top**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/node-top/page.tsx for widths below the tablet breakpoint. Each card should highlight hotspot visibility and saturation sorting, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

52. **390px regression check for node-top**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/node-top/page.tsx. Verify there is no horizontal overflow, the content still emphasizes hotspot visibility and saturation sorting, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

53. **Phone summary-first layout for apps page**
   - Plan: Lead the route with a compact mobile summary card that surfaces install, sync, and uninstall flows. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

54. **Stacked mobile actions for apps page**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

55. **Card fallback for apps page**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx for widths below the tablet breakpoint. Each card should highlight install, sync, and uninstall flows, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

56. **390px regression check for apps page**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx. Verify there is no horizontal overflow, the content still emphasizes install, sync, and uninstall flows, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

57. **Phone summary-first layout for users page**
   - Plan: Lead the route with a compact mobile summary card that surfaces user triage and account actions. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/users/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

58. **Stacked mobile actions for users page**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/users/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

59. **Card fallback for users page**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/users/page.tsx for widths below the tablet breakpoint. Each card should highlight user triage and account actions, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

60. **390px regression check for users page**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/users/page.tsx. Verify there is no horizontal overflow, the content still emphasizes user triage and account actions, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

61. **Phone summary-first layout for security page**
   - Plan: Lead the route with a compact mobile summary card that surfaces finding severity and remediation focus. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/security/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

62. **Stacked mobile actions for security page**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/security/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

63. **Card fallback for security page**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/security/page.tsx for widths below the tablet breakpoint. Each card should highlight finding severity and remediation focus, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

64. **390px regression check for security page**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/security/page.tsx. Verify there is no horizontal overflow, the content still emphasizes finding severity and remediation focus, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

65. **Phone summary-first layout for game hub**
   - Plan: Lead the route with a compact mobile summary card that surfaces server actions, status, and dense operational cards. Implement the summary in apps/infraweaver-console/src/app/(dashboard)/game-hub/page.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

66. **Stacked mobile actions for game hub**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/app/(dashboard)/game-hub/page.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

67. **Card fallback for game hub**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/app/(dashboard)/game-hub/page.tsx for widths below the tablet breakpoint. Each card should highlight server actions, status, and dense operational cards, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

68. **390px regression check for game hub**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/app/(dashboard)/game-hub/page.tsx. Verify there is no horizontal overflow, the content still emphasizes server actions, status, and dense operational cards, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

69. **Phone summary-first layout for storage dashboards**
   - Plan: Lead the route with a compact mobile summary card that surfaces Longhorn capacity, volume health, and replica context. Implement the summary in storage-related dashboard routes so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

70. **Stacked mobile actions for storage dashboards**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update storage-related dashboard routes so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

71. **Card fallback for storage dashboards**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in storage-related dashboard routes for widths below the tablet breakpoint. Each card should highlight Longhorn capacity, volume health, and replica context, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

72. **390px regression check for storage dashboards**
   - Plan: Add or run a repeatable 390px validation pass for storage-related dashboard routes. Verify there is no horizontal overflow, the content still emphasizes Longhorn capacity, volume health, and replica context, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

73. **Phone summary-first layout for cluster dashboards**
   - Plan: Lead the route with a compact mobile summary card that surfaces node health, workload actions, and event triage. Implement the summary in cluster-related dashboard routes so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

74. **Stacked mobile actions for cluster dashboards**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update cluster-related dashboard routes so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

75. **Card fallback for cluster dashboards**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in cluster-related dashboard routes for widths below the tablet breakpoint. Each card should highlight node health, workload actions, and event triage, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

76. **390px regression check for cluster dashboards**
   - Plan: Add or run a repeatable 390px validation pass for cluster-related dashboard routes. Verify there is no horizontal overflow, the content still emphasizes node health, workload actions, and event triage, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

77. **Phone summary-first layout for audit log surfaces**
   - Plan: Lead the route with a compact mobile summary card that surfaces time, actor, and action scanning. Implement the summary in apps/infraweaver-console/src/components/security/audit-log-table.tsx so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

78. **Stacked mobile actions for audit log surfaces**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update apps/infraweaver-console/src/components/security/audit-log-table.tsx so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

79. **Card fallback for audit log surfaces**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in apps/infraweaver-console/src/components/security/audit-log-table.tsx for widths below the tablet breakpoint. Each card should highlight time, actor, and action scanning, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

80. **390px regression check for audit log surfaces**
   - Plan: Add or run a repeatable 390px validation pass for apps/infraweaver-console/src/components/security/audit-log-table.tsx. Verify there is no horizontal overflow, the content still emphasizes time, actor, and action scanning, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

81. **Phone summary-first layout for table-heavy shared components**
   - Plan: Lead the route with a compact mobile summary card that surfaces card fallbacks and horizontal overflow handling. Implement the summary in shared table and list components so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

82. **Stacked mobile actions for table-heavy shared components**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update shared table and list components so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

83. **Card fallback for table-heavy shared components**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in shared table and list components for widths below the tablet breakpoint. Each card should highlight card fallbacks and horizontal overflow handling, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

84. **390px regression check for table-heavy shared components**
   - Plan: Add or run a repeatable 390px validation pass for shared table and list components. Verify there is no horizontal overflow, the content still emphasizes card fallbacks and horizontal overflow handling, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

85. **Phone summary-first layout for chart-heavy shared components**
   - Plan: Lead the route with a compact mobile summary card that surfaces single-column charts and legend usability. Implement the summary in shared analytics components so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

86. **Stacked mobile actions for chart-heavy shared components**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update shared analytics components so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

87. **Card fallback for chart-heavy shared components**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in shared analytics components for widths below the tablet breakpoint. Each card should highlight single-column charts and legend usability, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

88. **390px regression check for chart-heavy shared components**
   - Plan: Add or run a repeatable 390px validation pass for shared analytics components. Verify there is no horizontal overflow, the content still emphasizes single-column charts and legend usability, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

89. **Phone summary-first layout for filter toolbars**
   - Plan: Lead the route with a compact mobile summary card that surfaces active-filter visibility and one-thumb control. Implement the summary in shared toolbar and filter components so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

90. **Stacked mobile actions for filter toolbars**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update shared toolbar and filter components so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

91. **Card fallback for filter toolbars**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in shared toolbar and filter components for widths below the tablet breakpoint. Each card should highlight active-filter visibility and one-thumb control, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

92. **390px regression check for filter toolbars**
   - Plan: Add or run a repeatable 390px validation pass for shared toolbar and filter components. Verify there is no horizontal overflow, the content still emphasizes active-filter visibility and one-thumb control, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

93. **Phone summary-first layout for forms and confirmation flows**
   - Plan: Lead the route with a compact mobile summary card that surfaces validation clarity and safe destructive actions. Implement the summary in shared form and dialog components so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

94. **Stacked mobile actions for forms and confirmation flows**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update shared form and dialog components so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

95. **Card fallback for forms and confirmation flows**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in shared form and dialog components for widths below the tablet breakpoint. Each card should highlight validation clarity and safe destructive actions, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

96. **390px regression check for forms and confirmation flows**
   - Plan: Add or run a repeatable 390px validation pass for shared form and dialog components. Verify there is no horizontal overflow, the content still emphasizes validation clarity and safe destructive actions, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.

97. **Phone summary-first layout for mobile QA workflow**
   - Plan: Lead the route with a compact mobile summary card that surfaces 390px regression confidence for future dashboard work. Implement the summary in test and release workflow so the first screen at 390px shows status, one primary action, and the most important count before any long lists begin.

98. **Stacked mobile actions for mobile QA workflow**
   - Plan: Replace crowded multi-column controls with a one-column action stack or ResponsiveSheet on phone widths. Update test and release workflow so the most common actions stay thumb-reachable, destructive actions are separated, and every tap target remains at least 44px high.

99. **Card fallback for mobile QA workflow**
   - Plan: Keep the existing desktop presentation, but add a dedicated mobile card view in test and release workflow for widths below the tablet breakpoint. Each card should highlight 390px regression confidence for future dashboard work, expose the primary action inline, and hide secondary metadata behind expansion or progressive disclosure.

100. **390px regression check for mobile QA workflow**
   - Plan: Add or run a repeatable 390px validation pass for test and release workflow. Verify there is no horizontal overflow, the content still emphasizes 390px regression confidence for future dashboard work, fixed controls do not collide with safe areas, and a screenshot can be compared during future UX work.
