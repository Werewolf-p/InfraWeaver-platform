/**
 * iwsl-media-viewer — the framework-free, no-build ES module behind the media
 * viewer. ONE source, three mounts: the console Explorer (a React wrapper), the
 * plugin Explorer page (WP adapter), and the gated native-media modal (Agent C).
 *
 * TWO LAYERS, deliberately separated so a visitor never receives an admin byte:
 *
 *   1. PRESENTATION CORE (public-safe) — the overlay/dialog shell, the zoom/pan
 *      engine, prev/next navigation, the keyboard map, focus trap and caption strip.
 *      It performs ZERO requests and reads ONLY the item data handed to it. This exact
 *      layer is Agent B's front-end lightbox (`createPresentationCore`).
 *
 *   2. PANEL REGISTRY + ADAPTER SEAM (admin-only) — the declarative option list
 *      (`PANEL_REGISTRY`, each entry { id, kind, gate, capability, verb }) and the
 *      injected data/action adapter. `createAdminViewer` composes the core WITH the
 *      panels; nothing here leaks into the presentation core.
 *
 * The adapter is the single seam every panel action goes through:
 *   { getAsset, updateMeta, edit, protect, folderOp, optimize, offload, restore,
 *     del, usage, list } — the console binds it to the signed `media.*` route; the
 *   WP side binds it to admin-ajax twins that call the same engines. The presentation
 *   core takes none of it.
 *
 * No imports, no framework, no external asset — plain DOM + the same inline-style
 * discipline as the Explorer UI, so a WordPress page with no build step can enqueue it.
 */

// ── panel registry — the declarative option list (the SHARED contract) ─────────
// kind: 'detail' (read-only), 'field' (editable text), 'action' (a link/verb),
//       'toggle' (boolean), 'panel' (a composed block: optimization/CDN/usage/edit).
// gate: the entitlement flag a panel needs unlocked, or null when always available.
// capability: the WP cap the mutating twin enforces (the console uses RBAC instead).
// verb: the adapter method the panel calls, or null for pure reads.

export const PANEL_REGISTRY = Object.freeze([
  { id: "details", kind: "detail", gate: null, capability: null, verb: null,
    label: "Details", fields: ["uploaded", "author", "filename", "filetype", "filesize", "dimensions"] },
  { id: "alt", kind: "field", gate: null, capability: "edit_post", verb: "updateMeta",
    label: "Alternative Text", multiline: true,
    help: "Describe the purpose of the image. Leave empty if the image is purely decorative." },
  { id: "title", kind: "field", gate: null, capability: "edit_post", verb: "updateMeta", label: "Title" },
  { id: "caption", kind: "field", gate: null, capability: "edit_post", verb: "updateMeta", label: "Caption", multiline: true },
  { id: "description", kind: "field", gate: null, capability: "edit_post", verb: "updateMeta", label: "Description", multiline: true },
  { id: "fileurl", kind: "detail", gate: null, capability: null, verb: null, label: "File URL", copy: true },
  { id: "optimization", kind: "panel", gate: "image_optimization", capability: "manage_options", verb: "optimize", label: "Optimization" },
  { id: "offload", kind: "panel", gate: "image_optimization", capability: "manage_options", verb: "offload", label: "CDN / Offload" },
  { id: "protect", kind: "toggle", gate: "media_protection", capability: "manage_options", verb: "protect",
    label: "Protect this image (discourage copying)",
    help: "Deterrent only — discourages casual right-click / drag saving. This is not DRM; a determined visitor can still capture pixels." },
  { id: "folder", kind: "field", gate: "media_folders", capability: "manage_options", verb: "folderOp", label: "Folder", single: true,
    help: "A file lives in at most one folder." },
  { id: "tags", kind: "field", gate: "media_folders", capability: "manage_options", verb: "folderOp", label: "Folder tags" },
  { id: "usage", kind: "panel", gate: null, capability: null, verb: "usage", label: "Where used" },
  { id: "edit", kind: "panel", gate: "image_optimization", capability: "manage_options", verb: "edit", label: "Edit Image" },
  { id: "actions", kind: "action", gate: null, capability: null, verb: null, label: "Actions",
    links: ["view", "editMore", "download", "deletePermanently"] },
]);

/** The subset a panel set is filtered to for a given feature/capability context. */
export function panelsFor(features, can) {
  const feats = features || {};
  const cap = can || (() => true);
  return PANEL_REGISTRY.filter((panel) => {
    if (panel.gate && !feats[panel.gate]) return true; // kept, rendered disabled-with-reason.
    if (panel.capability && !cap(panel.capability)) return panel.kind === "detail" || panel.kind === "panel";
    return true;
  });
}

// ── keyboard map (shared by core + admin) ─────────────────────────────────────
export const KEY_MAP = Object.freeze({
  Escape: "close",
  ArrowLeft: "prev",
  ArrowRight: "next",
  "+": "zoomIn",
  "=": "zoomIn",
  "-": "zoomOut",
  "0": "zoomReset",
});

// ── zoom/pan engine (pure, testable) ───────────────────────────────────────────
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.4;

// ── touch-gesture tuning (internal; NOT part of the export contract) ─────────────
const TOUCH_TAP_MOVE_TOL = 12;          // px of drift a tap may drift and still count.
const TOUCH_AXIS_LOCK_TOL = 10;         // px before a swipe commits to an axis.
const TOUCH_DOUBLE_TAP_MS = 300;        // max gap between taps for a double-tap.
const TOUCH_DOUBLE_TAP_DIST = 30;       // px the two taps must land within.
const TOUCH_SWIPE_NAV_RATIO = 0.22;     // fraction of stage width to commit prev/next.
const TOUCH_SWIPE_DISMISS_RATIO = 0.18; // fraction of stage height to dismiss.
const TOUCH_SETTLE_MS = 220;            // snap-back / fade animation window.
const OVERLAY_BG_ALPHA = 0.92;          // matches .iwsl-mv-overlay background alpha.

/** Clamp a zoom factor into [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * The next zoom for a "zoom in/out/reset/toggle" intent. Pure — the caller owns the
 * DOM transform. `toggle` flips between fit (1) and 100%-ish (2).
 */
export function nextZoom(current, intent) {
  if (intent === "zoomReset") return ZOOM_MIN;
  if (intent === "zoomIn") return clampZoom(current * ZOOM_STEP);
  if (intent === "zoomOut") return clampZoom(current / ZOOM_STEP);
  if (intent === "toggle") return current > ZOOM_MIN ? ZOOM_MIN : 2;
  return current;
}

/**
 * Clamp a pan offset so the zoomed image can't be dragged entirely off-stage. Pure.
 * Returns { x, y } bounded to half the overflow in each axis.
 */
export function clampPan(offset, zoom, stage) {
  if (zoom <= ZOOM_MIN) return { x: 0, y: 0 };
  const maxX = ((zoom - 1) * (stage?.width || 0)) / 2;
  const maxY = ((zoom - 1) * (stage?.height || 0)) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

// ── prev/next across a filtered set (pure) ─────────────────────────────────────
/**
 * Resolve the neighbour index for a nav intent within a set of length `total`.
 * Returns -1 when there is no neighbour (the caller then fetches the adjacent page).
 */
export function neighbourIndex(index, intent, total) {
  if (intent === "prev") return index > 0 ? index - 1 : -1;
  if (intent === "next") return index < total - 1 ? index + 1 : -1;
  return index;
}

// ── small DOM helpers (no framework) ───────────────────────────────────────────
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const child of children || []) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const CORE_STYLE_ID = "iwsl-media-viewer-css";
const CORE_CSS = [
  ".iwsl-mv-overlay{position:fixed;inset:0;z-index:100000;display:flex;background:rgba(9,9,11,.92);",
  "align-items:stretch;justify-content:center;}",
  ".iwsl-mv-stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;touch-action:none;}",
  ".iwsl-mv-img{max-width:100%;max-height:100%;transform-origin:center center;transition:transform .05s linear;",
  "user-select:none;-webkit-user-drag:none;cursor:grab;}",
  ".iwsl-mv-img.iwsl-mv-zoomed{cursor:grab;}",
  ".iwsl-mv-nav{position:absolute;top:50%;transform:translateY(-50%);border:0;background:rgba(0,0,0,.4);color:#fff;",
  "width:44px;height:64px;font-size:26px;cursor:pointer;border-radius:6px;}",
  ".iwsl-mv-nav[disabled]{opacity:.25;cursor:default;}",
  ".iwsl-mv-prev{left:12px;}.iwsl-mv-next{right:12px;}",
  ".iwsl-mv-close{position:absolute;top:12px;right:12px;border:0;background:rgba(0,0,0,.4);color:#fff;width:40px;",
  "height:40px;font-size:22px;cursor:pointer;border-radius:6px;}",
  ".iwsl-mv-pos{position:absolute;top:16px;left:16px;color:#e4e4e7;font:13px/1.4 system-ui,sans-serif;",
  "background:rgba(0,0,0,.4);padding:4px 10px;border-radius:99px;}",
  ".iwsl-mv-caption{position:absolute;bottom:0;left:0;right:0;padding:12px 16px;color:#fafafa;",
  "font:14px/1.5 system-ui,sans-serif;background:linear-gradient(to top,rgba(0,0,0,.7),transparent);}",
  ".iwsl-mv-zoombar{position:absolute;bottom:14px;right:16px;display:flex;gap:6px;}",
  ".iwsl-mv-zoombar button{border:0;background:rgba(0,0,0,.5);color:#fff;width:34px;height:34px;border-radius:6px;cursor:pointer;font-size:16px;}",
  // Detail aside (admin viewer). Desktop = fixed 360px slab beside the stage.
  ".iwsl-mv-aside-body{padding:16px;overflow:auto;width:360px;background:#fff;color:#18181b;}",
  ".iwsl-mv-handle{display:none;}",
  // Narrow screens: the viewer goes full-screen and the aside becomes a bottom sheet
  // stacked UNDER the image. The handle raises/lowers it so every panel from
  // panelsFor() stays reachable by scrolling.
  "@media (max-width:640px){",
  ".iwsl-mv-overlay{flex-direction:column;}",
  ".iwsl-mv-stage{flex:1 1 auto;min-height:0;}",
  ".iwsl-mv-aside{display:flex;flex-direction:column;width:100%;max-width:none;flex:0 0 auto;",
  "background:#fff;color:#18181b;max-height:42vh;border-radius:14px 14px 0 0;",
  "box-shadow:0 -4px 24px rgba(0,0,0,.35);transition:max-height .25s ease;}",
  ".iwsl-mv-aside.iwsl-mv-sheet-open{max-height:82vh;}",
  ".iwsl-mv-aside-body{width:auto;flex:1 1 auto;-webkit-overflow-scrolling:touch;}",
  ".iwsl-mv-handle{display:block;position:relative;border:0;background:transparent;color:#52525b;",
  "font:600 12px system-ui,sans-serif;padding:14px 12px 6px;width:100%;cursor:pointer;text-align:center;}",
  ".iwsl-mv-handle::before{content:'';position:absolute;top:6px;left:50%;transform:translateX(-50%);",
  "width:36px;height:4px;border-radius:99px;background:#d4d4d8;}",
  "}",
].join("");

function ensureCoreStyle(doc) {
  if (doc.getElementById(CORE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = CORE_STYLE_ID;
  style.textContent = CORE_CSS;
  (doc.head || doc.body).appendChild(style);
}

/**
 * PRESENTATION CORE — the public-safe viewer. Renders one image with zoom/pan,
 * prev/next, a caption strip, keyboard control and a focus trap. It NEVER touches an
 * adapter and issues no request; `items` is all it reads. Agent B mounts exactly this.
 *
 * @param {Object} opts
 * @param {Array<{src:string,thumb?:string,alt?:string,caption?:string}>} opts.items
 * @param {number} [opts.index]      Starting index.
 * @param {Document} [opts.document] Injectable for tests / iframes.
 * @param {(i:number)=>void} [opts.onIndexChange]  Fires when nav crosses items.
 * @param {()=>void} [opts.onClose]
 * @param {(intent:string,index:number)=>boolean} [opts.onEdgeNav]  Return true to
 *        signal the host fetched an adjacent page (cross-boundary prev/next).
 * @param {(node:HTMLElement)=>HTMLElement|null} [opts.renderAside]  Admin composer hook.
 * @returns {{ open:Function, close:Function, go:Function, setItems:Function, destroy:Function, root:HTMLElement }}
 */
export function createPresentationCore(opts) {
  const o = opts || {};
  const doc = o.document || document;
  ensureCoreStyle(doc);

  let items = Array.isArray(o.items) ? o.items.slice() : [];
  let index = Math.max(0, Math.min(o.index || 0, Math.max(0, items.length - 1)));
  let zoom = ZOOM_MIN;
  let pan = { x: 0, y: 0 };
  let lastFocus = null;

  const img = el("img", { class: "iwsl-mv-img", alt: "", draggable: "false" });
  const pos = el("div", { class: "iwsl-mv-pos" });
  const caption = el("div", { class: "iwsl-mv-caption" });
  const prevBtn = el("button", { class: "iwsl-mv-nav iwsl-mv-prev", "aria-label": "Previous", type: "button", text: "‹" });
  const nextBtn = el("button", { class: "iwsl-mv-nav iwsl-mv-next", "aria-label": "Next", type: "button", text: "›" });
  const closeBtn = el("button", { class: "iwsl-mv-close", "aria-label": "Close", type: "button", text: "×" });
  const zoomBar = el("div", { class: "iwsl-mv-zoombar" }, [
    el("button", { type: "button", "aria-label": "Zoom out", text: "−", onclick: () => applyZoom("zoomOut") }),
    el("button", { type: "button", "aria-label": "Reset zoom", text: "○", onclick: () => applyZoom("zoomReset") }),
    el("button", { type: "button", "aria-label": "Zoom in", text: "+", onclick: () => applyZoom("zoomIn") }),
  ]);
  const stage = el("div", { class: "iwsl-mv-stage" }, [img, pos, prevBtn, nextBtn, caption, zoomBar]);
  const root = el("div", { class: "iwsl-mv-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Media viewer", tabindex: "-1" }, [stage, closeBtn]);

  const aside = typeof o.renderAside === "function" ? o.renderAside(root) : null;
  if (aside) root.appendChild(aside);

  function applyTransform() {
    const p = clampPan(pan, zoom, { width: stage.clientWidth, height: stage.clientHeight });
    pan = p;
    img.style.transform = `translate(${p.x}px, ${p.y}px) scale(${zoom})`;
    img.classList.toggle("iwsl-mv-zoomed", zoom > ZOOM_MIN);
  }
  function applyZoom(intent) {
    zoom = nextZoom(zoom, intent);
    if (zoom === ZOOM_MIN) pan = { x: 0, y: 0 };
    applyTransform();
  }
  function render() {
    const item = items[index] || {};
    img.src = item.src || item.thumb || "";
    img.alt = item.alt || "";
    caption.textContent = item.caption || "";
    caption.style.display = item.caption ? "block" : "none";
    pos.textContent = items.length > 1 ? `${index + 1} of ${items.length}` : "";
    pos.style.display = items.length > 1 ? "block" : "none";
    prevBtn.disabled = index <= 0 && !o.onEdgeNav;
    nextBtn.disabled = index >= items.length - 1 && !o.onEdgeNav;
    zoom = ZOOM_MIN;
    pan = { x: 0, y: 0 };
    applyTransform();
  }
  function go(intent) {
    const target = neighbourIndex(index, intent, items.length);
    if (target === -1) {
      if (typeof o.onEdgeNav === "function" && o.onEdgeNav(intent, index)) return;
      return;
    }
    index = target;
    render();
    if (typeof o.onIndexChange === "function") o.onIndexChange(index);
  }
  function onKey(ev) {
    const intent = KEY_MAP[ev.key];
    if (!intent) {
      if (ev.key === "Tab") trapFocus(ev);
      return;
    }
    ev.preventDefault();
    if (intent === "close") return close();
    if (intent === "prev" || intent === "next") return go(intent);
    applyZoom(intent);
  }
  function trapFocus(ev) {
    const focusables = root.querySelectorAll("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])");
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && doc.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && doc.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  // Drag-to-pan when zoomed.
  let dragging = null;
  img.addEventListener("mousedown", (ev) => {
    if (zoom <= ZOOM_MIN) return;
    dragging = { x: ev.clientX - pan.x, y: ev.clientY - pan.y };
    ev.preventDefault();
  });
  doc.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    pan = { x: ev.clientX - dragging.x, y: ev.clientY - dragging.y };
    applyTransform();
  });
  doc.addEventListener("mouseup", () => { dragging = null; });
  img.addEventListener("dblclick", () => applyZoom("toggle"));
  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    applyZoom(ev.deltaY < 0 ? "zoomIn" : "zoomOut");
  }, { passive: false });

  // ── touch gestures (ADDITIVE; feature-gated; mouse/keyboard path untouched) ─────
  // Only touch/pen pointers are handled — a mouse still uses the mousedown/dblclick/
  // wheel handlers above, byte-identical. Every gesture reuses the pure primitives:
  //   pinch  → clampZoom + clampPan (focal point held stable)
  //   dbl-tap→ nextZoom("toggle") about the tap point + clampPan
  //   pan    → clampPan (only while zoomed)
  //   swipe  → neighbourIndex via go() + the onEdgeNav/onIndexChange path
  //   drag ↓ → the same close() the close button calls
  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
  if (win && win.PointerEvent) {
    const touchPts = new Map();   // pointerId -> { x, y }
    let pinch = null;             // { prevDist, prevMid }
    let oneFinger = null;         // { id, startX, startY, panX, panY, zoomedAtStart, axis, moved }
    let lastTap = { t: 0, x: 0, y: 0 };

    const isControl = (t) => !!(t && t.closest && t.closest("button, a, input, textarea, select, [role='button']"));
    const stageSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });
    const relToCenter = (cx, cy) => {
      const r = stage.getBoundingClientRect();
      return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
    };
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    // Zoom to z1 while keeping the content under (cx,cy) pinned. Pure math on top of
    // clampPan; a reset-to-fit re-centres (pan → 0).
    function zoomAbout(z1, cx, cy) {
      const z0 = zoom || ZOOM_MIN;
      if (z1 <= ZOOM_MIN) { zoom = ZOOM_MIN; pan = { x: 0, y: 0 }; return; }
      const f = relToCenter(cx, cy);
      zoom = z1;
      pan = clampPan({ x: f.x - (f.x - pan.x) * (z1 / z0), y: f.y - (f.y - pan.y) * (z1 / z0) }, zoom, stageSize());
    }

    // Restore the stage/img to the true zoom/pan transform, optionally with a short
    // settle animation (used for swipe snap-back and the dismiss fade cancel).
    function resetFeedback(animate) {
      if (animate) {
        img.style.transition = "transform .2s ease";
        root.style.transition = "background-color .2s ease";
        setTimeout(() => { img.style.transition = ""; root.style.transition = ""; }, TOUCH_SETTLE_MS);
      } else {
        img.style.transition = "";
      }
      root.style.backgroundColor = "";
      applyTransform();
    }

    function beginOneFinger(ev) {
      oneFinger = {
        id: ev.pointerId, startX: ev.clientX, startY: ev.clientY,
        panX: pan.x, panY: pan.y, zoomedAtStart: zoom > ZOOM_MIN, axis: null, moved: false,
      };
    }

    function updatePinch() {
      const pts = Array.from(touchPts.values());
      if (pts.length < 2) return;
      const newDist = distance(pts[0], pts[1]);
      const newMid = midpoint(pts[0], pts[1]);
      const z0 = zoom || ZOOM_MIN;
      const z1 = clampZoom(z0 * (newDist / (pinch.prevDist || newDist)));
      const fPrev = relToCenter(pinch.prevMid.x, pinch.prevMid.y);
      const fNew = relToCenter(newMid.x, newMid.y);
      const px = fPrev.x - (fPrev.x - pan.x) * (z1 / z0) + (fNew.x - fPrev.x);
      const py = fPrev.y - (fPrev.y - pan.y) * (z1 / z0) + (fNew.y - fPrev.y);
      zoom = z1;
      pan = z1 <= ZOOM_MIN ? { x: 0, y: 0 } : clampPan({ x: px, y: py }, zoom, stageSize());
      pinch.prevDist = newDist;
      pinch.prevMid = newMid;
      applyTransform();
    }

    function updateOneFinger() {
      const cur = touchPts.get(oneFinger.id);
      if (!cur) return;
      const dx = cur.x - oneFinger.startX;
      const dy = cur.y - oneFinger.startY;
      if (Math.abs(dx) > TOUCH_TAP_MOVE_TOL || Math.abs(dy) > TOUCH_TAP_MOVE_TOL) oneFinger.moved = true;
      if (oneFinger.zoomedAtStart) { // one-finger pan of the zoomed image.
        pan = clampPan({ x: oneFinger.panX + dx, y: oneFinger.panY + dy }, zoom, stageSize());
        applyTransform();
        return;
      }
      if (!oneFinger.axis) { // lock to horizontal (nav) or downward (dismiss) once past the tolerance.
        if (Math.abs(dx) > TOUCH_AXIS_LOCK_TOL && Math.abs(dx) > Math.abs(dy)) oneFinger.axis = "h";
        else if (dy > TOUCH_AXIS_LOCK_TOL && Math.abs(dy) >= Math.abs(dx)) oneFinger.axis = "v";
        else return;
        img.style.transition = "none";
      }
      if (oneFinger.axis === "h") {
        img.style.transform = `translate(${dx}px, 0) scale(1)`; // rubber-band follow.
      } else {
        const drop = Math.max(0, dy);
        const prog = Math.min(1, drop / (stageSize().height || 1));
        img.style.transform = `translate(0, ${drop}px) scale(1)`;
        root.style.backgroundColor = `rgba(9,9,11,${(OVERLAY_BG_ALPHA * (1 - prog)).toFixed(3)})`;
      }
    }

    function finishOneFinger(ev) {
      const dx = ev.clientX - oneFinger.startX;
      const dy = ev.clientY - oneFinger.startY;
      const size = stageSize();
      if (!oneFinger.moved) { // a tap — resolve double-tap toggle (works zoomed or not).
        const now = Date.now();
        const near = Math.abs(ev.clientX - lastTap.x) < TOUCH_DOUBLE_TAP_DIST && Math.abs(ev.clientY - lastTap.y) < TOUCH_DOUBLE_TAP_DIST;
        if (now - lastTap.t < TOUCH_DOUBLE_TAP_MS && near) {
          lastTap = { t: 0, x: 0, y: 0 };
          zoomAbout(nextZoom(zoom, "toggle"), ev.clientX, ev.clientY);
          resetFeedback(true);
        } else {
          lastTap = { t: now, x: ev.clientX, y: ev.clientY };
        }
        return;
      }
      if (oneFinger.zoomedAtStart) return; // pan already applied + clamped live.
      if (oneFinger.axis === "h") {
        const past = Math.abs(dx) >= (size.width || 1) * TOUCH_SWIPE_NAV_RATIO;
        resetFeedback(true);
        if (past) go(dx < 0 ? "next" : "prev");
        return;
      }
      if (oneFinger.axis === "v") {
        if (dy >= (size.height || 1) * TOUCH_SWIPE_DISMISS_RATIO) { close(); return; }
        resetFeedback(true);
        return;
      }
      resetFeedback(true);
    }

    stage.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;      // desktop mouse keeps its own handlers.
      if (isControl(ev.target)) return;            // let buttons/links/zoombar work.
      touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* best effort */ }
      if (ev.cancelable) ev.preventDefault();      // suppress compat mouse/dblclick.
      if (touchPts.size === 2) {
        const pts = Array.from(touchPts.values());
        pinch = { prevDist: distance(pts[0], pts[1]), prevMid: midpoint(pts[0], pts[1]) };
        oneFinger = null;
        resetFeedback(false);
      } else if (touchPts.size === 1) {
        beginOneFinger(ev);
      }
    });
    stage.addEventListener("pointermove", (ev) => {
      if (ev.pointerType === "mouse" || !touchPts.has(ev.pointerId)) return;
      touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ev.cancelable) ev.preventDefault();
      if (pinch && touchPts.size >= 2) updatePinch();
      else if (oneFinger && oneFinger.id === ev.pointerId) updateOneFinger();
    });
    const endPointer = (ev) => {
      if (ev.pointerType === "mouse" || !touchPts.has(ev.pointerId)) return;
      touchPts.delete(ev.pointerId);
      try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* best effort */ }
      if (pinch && touchPts.size < 2) { // pinch ended; hand a lone remaining finger a fresh pan.
        pinch = null;
        if (zoom <= ZOOM_MIN) { pan = { x: 0, y: 0 }; applyTransform(); }
        if (touchPts.size === 1) {
          const [id, pt] = Array.from(touchPts.entries())[0];
          oneFinger = { id, startX: pt.x, startY: pt.y, panX: pan.x, panY: pan.y, zoomedAtStart: zoom > ZOOM_MIN, axis: null, moved: false };
        }
        return;
      }
      if (oneFinger && oneFinger.id === ev.pointerId) {
        finishOneFinger(ev);
        oneFinger = null;
      }
    };
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
  }

  prevBtn.addEventListener("click", () => go("prev"));
  nextBtn.addEventListener("click", () => go("next"));
  closeBtn.addEventListener("click", () => close());
  root.addEventListener("click", (ev) => { if (ev.target === root) close(); });

  function open(startIndex) {
    if (typeof startIndex === "number") index = Math.max(0, Math.min(startIndex, items.length - 1));
    lastFocus = doc.activeElement;
    (doc.body || doc.documentElement).appendChild(root);
    doc.addEventListener("keydown", onKey);
    render();
    root.focus();
  }
  function close() {
    doc.removeEventListener("keydown", onKey);
    if (root.parentNode) root.parentNode.removeChild(root);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    if (typeof o.onClose === "function") o.onClose();
  }
  function setItems(nextItems, nextIndex) {
    items = Array.isArray(nextItems) ? nextItems.slice() : [];
    if (typeof nextIndex === "number") index = Math.max(0, Math.min(nextIndex, items.length - 1));
    render();
  }
  function destroy() {
    close();
    doc.removeEventListener("mousemove", () => {});
  }

  return { open, close, go, setItems, applyZoom, destroy, root, get index() { return index; } };
}

/**
 * ADMIN VIEWER — the presentation core PLUS the panel registry, wired to an adapter.
 * This is the console-Explorer / plugin-Explorer / native-modal viewer. The panels
 * are rendered into an aside; the presentation core stays pristine (Agent B never
 * constructs this). Panels honor per-panel gating: a locked panel renders disabled
 * with the gate reason rather than vanishing.
 *
 * @param {Object} opts
 * @param {Object} opts.adapter   { getAsset, updateMeta, edit, protect, folderOp, ... }
 * @param {number} opts.assetId
 * @param {Object} [opts.features]  { media_folders, image_optimization, ... }
 * @param {(cap:string)=>boolean} [opts.can]  Capability probe (WP side); RBAC on console.
 * @param {Document} [opts.document]
 */
export function createAdminViewer(opts) {
  const o = opts || {};
  const doc = o.document || document;
  const adapter = o.adapter || {};
  let asset = null;

  // Styling lives in the injected .iwsl-mv-aside-body rule so a media query can turn
  // the desktop 360px slab into a mobile bottom sheet (inline width would out-specify it).
  const asideBody = el("div", { class: "iwsl-mv-aside-body" });
  // Bottom-sheet affordance: hidden on desktop (CSS), a drag-handle/"Info" toggle on
  // narrow screens that raises/lowers the sheet so every panel stays reachable.
  const sheetHandle = el("button", {
    class: "iwsl-mv-handle", type: "button", "aria-expanded": "false", "aria-label": "Toggle details", text: "Info",
    onclick: () => {
      const asideEl = sheetHandle.parentNode;
      if (!asideEl || !asideEl.classList) return;
      const open = asideEl.classList.toggle("iwsl-mv-sheet-open");
      sheetHandle.setAttribute("aria-expanded", open ? "true" : "false");
    },
  });
  const core = createPresentationCore({
    items: [],
    document: doc,
    onClose: o.onClose,
    onIndexChange: o.onIndexChange,
    onEdgeNav: o.onEdgeNav,
    renderAside: () => el("aside", { class: "iwsl-mv-aside", role: "region", "aria-label": "Attachment details" }, [sheetHandle, asideBody]),
  });

  async function load(assetId) {
    const reply = typeof adapter.getAsset === "function" ? await adapter.getAsset(assetId) : null;
    asset = reply && reply.asset ? reply.asset : reply;
    if (reply && reply.locked) {
      renderLocked(reply.gate);
      return;
    }
    core.setItems([{ src: asset.url, thumb: asset.thumb, alt: asset.alt, caption: asset.title }], 0);
    renderPanels();
  }

  function renderLocked(gate) {
    asideBody.textContent = "";
    asideBody.appendChild(el("p", { text: "This feature is locked for this site." }));
    if (gate && Array.isArray(gate.reasons)) {
      const ul = el("ul", {});
      gate.reasons.forEach((r) => ul.appendChild(el("li", { text: String(r) })));
      asideBody.appendChild(ul);
    }
  }

  function renderPanels() {
    asideBody.textContent = "";
    const features = o.features || (asset && asset._features) || {};
    for (const panel of panelsFor(features, o.can)) {
      asideBody.appendChild(renderPanel(panel, features));
    }
  }

  function renderPanel(panel, features) {
    const locked = panel.gate && !features[panel.gate];
    const wrap = el("section", { class: "iwsl-mv-panel", "data-panel": panel.id, style: "margin-bottom:14px;" });
    wrap.appendChild(el("h4", { text: panel.label, style: "margin:0 0 6px;font:600 13px system-ui;" }));
    if (locked) {
      wrap.appendChild(el("p", { text: `Requires ${panel.gate}.`, style: "color:#a1a1aa;font-size:12px;" }));
      return wrap;
    }
    wrap.appendChild(renderPanelBody(panel));
    return wrap;
  }

  function renderPanelBody(panel) {
    if (!asset) return el("div", {});
    if (panel.id === "details") return renderDetails();
    if (panel.kind === "field") return renderField(panel);
    if (panel.id === "fileurl") return renderFileUrl();
    if (panel.id === "protect") return renderProtect();
    if (panel.id === "actions") return renderActions();
    return el("div", { class: `iwsl-mv-panel-${panel.id}`, "data-verb": panel.verb || "" });
  }

  function renderDetails() {
    const rows = [
      ["Uploaded on", asset.date],
      ["Uploaded by", asset.uploader && asset.uploader.name],
      ["File name", asset.filename],
      ["File type", asset.mime],
      ["File size", formatBytes(asset.filesize)],
      ["Dimensions", asset.width && asset.height ? `${asset.width} × ${asset.height}` : ""],
    ];
    const dl = el("dl", { style: "margin:0;font-size:12px;" });
    rows.forEach(([k, v]) => {
      dl.appendChild(el("dt", { text: k, style: "color:#71717a;" }));
      dl.appendChild(el("dd", { text: v || "—", style: "margin:0 0 6px;" }));
    });
    return dl;
  }

  function renderField(panel) {
    const value = fieldValue(panel.id);
    const input = panel.multiline
      ? el("textarea", { rows: "2", style: "width:100%;" })
      : el("input", { type: "text", style: "width:100%;" });
    input.value = value || "";
    const save = el("button", { type: "button", text: "Save", style: "margin-top:4px;" });
    save.addEventListener("click", () => commitField(panel, input.value));
    const nodes = [input, save];
    if (panel.help) nodes.push(el("p", { text: panel.help, style: "color:#71717a;font-size:11px;margin:4px 0 0;" }));
    return el("div", {}, nodes);
  }

  async function commitField(panel, value) {
    if (panel.verb === "updateMeta" && typeof adapter.updateMeta === "function") {
      await adapter.updateMeta(asset.id, { [panel.id]: value }, asset.modified);
    } else if (panel.verb === "folderOp" && typeof adapter.folderOp === "function") {
      await adapter.folderOp(asset.id, panel.id, value);
    }
    await load(asset.id);
  }

  function renderFileUrl() {
    const url = asset.url || "";
    const copy = el("button", { type: "button", text: "Copy URL to clipboard" });
    copy.addEventListener("click", () => copyText(doc, url));
    const nodes = [el("code", { text: url, style: "display:block;word-break:break-all;font-size:11px;" }), copy];
    if (asset.offload && asset.offload.url) {
      const copyCdn = el("button", { type: "button", text: "Copy CDN URL" });
      copyCdn.addEventListener("click", () => copyText(doc, asset.offload.url));
      nodes.push(copyCdn);
    }
    return el("div", {}, nodes);
  }

  function renderProtect() {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!asset.protected;
    cb.addEventListener("change", async () => {
      if (typeof adapter.protect === "function") await adapter.protect([asset.id], cb.checked);
      await load(asset.id);
    });
    return el("label", { style: "font-size:12px;" }, [cb, " InfraWeaver protection — protect this image"]);
  }

  function renderActions() {
    const del = el("button", { type: "button", text: "Delete permanently", style: "color:#b91c1c;" });
    del.addEventListener("click", () => confirmDelete());
    return el("div", {}, [
      el("a", { href: asset.url, target: "_blank", rel: "noopener", text: "View media file" }),
      " · ",
      el("a", { href: asset.url, download: asset.filename || "", text: "Download file" }),
      el("div", { style: "margin-top:8px;" }, [del]),
    ]);
  }

  async function confirmDelete() {
    const ok = typeof doc.defaultView !== "undefined" && doc.defaultView.confirm
      ? doc.defaultView.confirm(`Delete “${asset.filename || asset.id}” permanently? This deletes the file and its thumbnails — it is NOT the folder delete, which never touches files.`)
      : true;
    if (!ok) return;
    if (typeof adapter.del === "function") await adapter.del(asset.id);
    core.close();
  }

  function fieldValue(id) {
    if (id === "tags") return (asset.tags || []).map((t) => t.name).join(", ");
    if (id === "folder") return asset.folder ? String(asset.folder.id) : "";
    return asset[id] || "";
  }

  function open(assetId) {
    core.open(0);
    load(assetId || o.assetId);
  }

  return { open, close: core.close, reload: () => load(asset && asset.id), core, root: core.root };
}

// ── shared formatting helpers ──────────────────────────────────────────────────
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function copyText(doc, text) {
  const nav = doc.defaultView && doc.defaultView.navigator;
  if (nav && nav.clipboard && nav.clipboard.writeText) {
    nav.clipboard.writeText(text);
    return;
  }
  const ta = doc.createElement("textarea");
  ta.value = text;
  (doc.body || doc.documentElement).appendChild(ta);
  ta.select();
  try { doc.execCommand("copy"); } catch (e) { /* best effort */ }
  ta.remove();
}
