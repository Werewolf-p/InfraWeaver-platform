---
title: Console Navigation — Mandatory Checklist for New Pages
description: Every new page added to InfraWeaver Console MUST be registered in all three navigation locations or it will be invisible on mobile.
---

# Console Navigation — Mandatory Checklist

## ⚠️ Rule: New page = update all 3 nav locations

Whenever a new page/route is added to the InfraWeaver Console, it **MUST** be registered in all of the following files. Missing even one leaves the page unreachable on mobile.

---

## The Three Nav Locations

### 1. Desktop Sidebar (always required)
**File:** `apps/infraweaver-console/src/components/layout/sidebar.tsx`

- Add to the correct `navGroups` array entry (Core / Platform / Infrastructure / Tools / Services / Settings)
- Add to `hrefIconMap` so the active-page icon resolves correctly

```ts
// In navGroups → appropriate section:
{ href: "/my-new-page", icon: MyIcon, label: "My Page", shortcut: "G X" },

// In hrefIconMap:
"/my-new-page": MyIcon,
```

### 2. Mobile Drawer Nav (always required — this is how mobile users navigate!)
**File:** `apps/infraweaver-console/src/app/(dashboard)/layout.tsx`

- Add to `drawerNavItems` array
- Import the icon at the top of the file

```ts
const drawerNavItems = [
  // ... existing items ...
  { href: "/my-new-page", icon: MyIcon, label: "My Page" },
];
```

### 3. Mobile Bottom Nav Bar (add only if it's a top-level/frequently used page)
**File:** `apps/infraweaver-console/src/app/(dashboard)/layout.tsx`

- Add to `mobileNavItems` array (keep to 6 items max — limited space)
- Only add core navigation items here (Home, Dashboard, Apps, Health, Network, Config)

---

## Lesson Learned

**Date:** 2026-05-10
**What broke:** Game Servers page was added to `sidebar.tsx` only. It was completely invisible on mobile because `drawerNavItems` in `layout.tsx` was not updated. The user had to report this as a bug.

**Fix applied:** Added `{ href: "/gameservers", icon: Gamepad2, label: "Game Servers" }` to `drawerNavItems` in commit `5d8d351`.

---

## Version Badge

The version badge is baked at build time via `NEXT_PUBLIC_APP_VERSION` (set by CI as the git short SHA).
- **Topbar** (`components/layout/topbar.tsx`): shows `v{SHA}` next to the title — always visible
- **Desktop sidebar** (`components/layout/sidebar.tsx`): shows `v{SHA}` at the bottom when expanded
- **Mobile drawer** (`app/(dashboard)/layout.tsx`): shows `v{SHA}` in the drawer footer

Never remove these — the user needs them to verify what version is deployed.

---

## CI Build Timing Warning

The CI (`build-console.yml`) builds and pushes the image to the OneDev registry. **The build takes ~8–12 minutes.** 

**Never update `deployment.yaml` image tag until the CI build has fully completed.** Updating too early causes `ImagePullBackOff` because the image doesn't exist yet.

Safe pattern:
1. Push code changes → CI starts
2. Wait for CI to post "✅ Built and pushed" in the job summary (~10 min)
3. Then update `deployment.yaml` image tag to `main-{sha}`
4. Push deployment.yaml → ArgoCD syncs → rollout completes
