---
title: Enterprise UI System 2026-05
description: Azure-quality UI design system and component library
---
# Enterprise UI

## Memory
- **Tokens**: globals.css CSS variables, light + dark via .dark/.light class, Tailwind v4 (NO darkMode config needed)
- **Sidebar**: framer-motion animated, 220px expanded / 48px collapsed, localStorage persist, mobile off-canvas via Sheet
- **Command palette**: custom framer-motion + fuse.js based (NOT cmdk), ⌘K trigger
- **Data table**: @tanstack/react-table v8, sort/filter/pagination/export/row-select/bulk-actions
- **Page shell**: components/layout/page-shell.tsx — standardised title/subtitle/actions header
- **Theme**: custom ThemeProvider in providers.tsx (NOT next-themes)
- **Status Badge**: supports healthy/degraded/failed/pending/syncing/unknown/suspended + more
- **Metric Card**: components/ui/metric-card.tsx with sparklines (recharts), trends, loading skeleton
