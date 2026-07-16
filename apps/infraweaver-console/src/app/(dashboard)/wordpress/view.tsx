"use client";

// Host bridge: the Workloads hub embeds the WordPress addon dashboard as a tab.
// Core code must not import addon internals directly (no-restricted-imports), so
// this re-export lives under the exempt `wordpress/**` tree — mirroring how the
// Game Servers tab consumes `../game-hub/view`. Workloads imports `WordpressView`
// from here, never `@/addons/*` directly.
export { WordpressDashboard as WordpressView } from "@/addons/wordpress-manager/components/wordpress-dashboard";
