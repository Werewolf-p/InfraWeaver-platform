---
title: Mobile drawer / modal layout patterns
description: Reliable CSS patterns for full-screen drawers on iOS Safari + Android Chrome
---

# Mobile Drawer Layout Patterns

## Memory

- **File paths:** `apps/infraweaver-console/src/app/(dashboard)/gameservers/page.tsx`
- **Decision:** Use CSS Grid `gridTemplateRows: "auto auto 1fr auto"` for header/progress/content/footer drawers

## iOS Safari: backdrop-filter z-index bug

**NEVER use `backdrop-blur-*` on an overlay/backdrop that is a SIBLING to a drawer panel.**

On iOS Safari, `backdrop-filter: blur()` creates a GPU compositing layer that can visually render ABOVE sibling elements even if they have a higher z-index. Symptom: content inside the drawer becomes invisible (but is still in the DOM — selectable via "Select All"). Header/footer with opaque backgrounds may still be visible; transparent/semi-transparent content (like cards with `bg-white/5`) becomes invisible.

**Fix:** Remove `backdrop-blur` from backdrop. Use higher opacity instead: `bg-black/70` instead of `bg-black/50 backdrop-blur-sm`.

## CSS Grid vs Flexbox for header/content/footer layout

`flex-1 overflow-y-auto` REQUIRES `min-h-0` on the flex child to work in a flex-column container. Without `min-h-0`, the child expands to intrinsic height, overflowing the parent and pushing content off-screen.

**More reliable:** CSS Grid with explicit row sizing:
```jsx
<div style={{ display: "grid", gridTemplateRows: "auto auto 1fr auto" }}>
  <div>header</div>
  <div>progress</div>
  <div style={{ overflow: "auto", WebkitOverflowScrolling: "touch" }}>content</div>
  <div>footer</div>
</div>
```
`1fr` means "take exactly the remaining space" — no min-height gotcha.

## Card visibility: never use bg-white/5 or border-white/10 for important UI

`bg-white/5` (5% white) and `border-white/10` (10% white) are nearly invisible on dark backgrounds AND completely invisible if any rendering layer issue exists.

**Use solid colors for interactive cards:** `bg-slate-800 border-2 border-slate-600` — always visible, easier to debug.

## WebkitOverflowScrolling

Add `style={{ WebkitOverflowScrolling: "touch" }}` to any scrollable container on mobile for momentum scrolling on older iOS:
```jsx
<div style={{ overflow: "auto", WebkitOverflowScrolling: "touch" }}>
```

- **Why it matters:** iOS Safari historically needs this for smooth scroll in overflow containers
- **Validation:** Open on iOS Safari, scroll through content, verify momentum scroll
- **Lesson learned:** backdrop-blur-sm on overlay sibling caused card content to be invisible on phone (visible via "Select All" but not visually rendered)
