/**
 * iwsl-media-modal — the gated wp.media takeover (Agent C). It ADDS an "IWSL
 * Library" default state to the core media frames (Select + Post) so the post
 * editor, featured-image box, gallery inserter AND Elementor's picker (which all
 * compose core frames) open on the InfraWeaver Explorer with folders/tags/status
 * and the shared viewer — while the native tabs stay one click away.
 *
 * TWO HARD RULES, both testable:
 *
 *   1. ADDITIVE, NEVER DESTRUCTIVE. We wrap `MediaFrame.Select.prototype` methods
 *      call-through (original first, then add our state); we NEVER assign over
 *      `wp.media.view.MediaFrame.Select` / `.Post` wholesale. Native states remain
 *      registered and reachable.
 *
 *   2. ONE TRY/CATCH SEAM WITH NATIVE RESTORE. All patching happens inside
 *      `installIwslState`, which never throws: on ANY error it RESTORES every
 *      prototype method it saved (so the native frame is byte-identical to before)
 *      and logs a single console warning. A future wp.media / Elementor change can
 *      therefore degrade the picker to stock, but can never brick it.
 *
 * The detail panel reuses Agent A's `createAdminViewer` so the viewer is identical
 * across the console Explorer, the plugin Explorer page, and this modal.
 *
 * No build step: plain ES module, same inline-style discipline as the viewer.
 */

import { createAdminViewer } from "./iwsl-media-viewer.js";

/** The custom controller/content state id — namespaced so it can't collide. */
export const IWSL_STATE_ID = "iwsl-library";

/** Read the localized config the PHP side printed (window.IWSL_MEDIA_NATIVE). */
export function readConfig(win) {
  const w = win || (typeof window !== "undefined" ? window : {});
  const cfg = w.IWSL_MEDIA_NATIVE || {};
  return {
    ajaxUrl: cfg.ajaxUrl || "",
    nonce: cfg.nonce || "",
    actions: cfg.actions || { tree: "", list: "", get: "" },
    features: cfg.features || {},
    can: cfg.can || {},
    explorerUrl: cfg.explorerUrl || "",
    escapeArg: cfg.escapeArg || "iwsl_native",
  };
}

// ── the injection seam — the ONE place that touches wp.media ─────────────────────

/**
 * Install the IWSL state onto the core media frames. NEVER THROWS. Returns a
 * result object; on any failure it restores every prototype method it changed and
 * warns exactly once, leaving the native frame untouched.
 *
 * @param {object} wpMedia  wp.media (injectable for tests).
 * @param {object} config   readConfig() output.
 * @param {object} [deps]   { warn, buildState } — injectable seams for tests.
 * @returns {{installed:boolean, fellBack:boolean, error?:Error}}
 */
export function installIwslState(wpMedia, config, deps) {
  const d = deps || {};
  const warn = typeof d.warn === "function" ? d.warn : warnOnce;

  const saved = []; // [{ proto, key, fn }] — for restore-on-failure.
  const restore = () => {
    for (const s of saved) {
      s.proto[s.key] = s.fn; // put the exact native method back.
    }
  };

  // EVERYTHING — including the structural pre-check — runs inside the ONE try/catch
  // so this function is honestly throw-proof: even evaluating the frame reference
  // (a hostile getter, an exotic builder) can only ever end in native fallback.
  try {
    if (!wpMedia || !wpMedia.view || !wpMedia.view.MediaFrame || !wpMedia.view.MediaFrame.Select) {
      warn("wp.media frame missing — IWSL media modal stays on native.");
      return { installed: false, fellBack: true };
    }

    // Frames to augment. Post extends Select, but wrapping both is explicit and safe.
    const frames = [wpMedia.view.MediaFrame.Select, wpMedia.view.MediaFrame.Post].filter(Boolean);
    const buildState = typeof d.buildState === "function" ? d.buildState : buildIwslState;
    for (const Frame of frames) {
      const proto = Frame.prototype;
      const originalCreateStates = proto.createStates;
      if (typeof originalCreateStates !== "function") continue;

      saved.push({ proto, key: "createStates", fn: originalCreateStates });

      proto.createStates = function iwslCreateStates() {
        // NATIVE FIRST — every core state is registered exactly as before.
        originalCreateStates.apply(this, arguments);
        // Then ADD ours. Per-frame guarded: one bad instance degrades to native
        // for that frame only, never for the page.
        try {
          const state = buildState(wpMedia, config);
          if (state && this.states && typeof this.states.add === "function") {
            this.states.add([state]);
            wireContent(this, wpMedia, config); // render the grid into our content region.
          }
        } catch (perFrame) {
          warn("IWSL media state failed for one frame — using native for it.");
        }
      };
    }

    if (saved.length === 0) {
      // Nothing patchable — treat as a clean fallback, native intact.
      return { installed: false, fellBack: true };
    }
    return { installed: true, fellBack: false };
  } catch (err) {
    restore(); // ── native frame restored, byte-identical ──
    warn("IWSL media modal injection failed — restored native wp.media.");
    return { installed: false, fellBack: true, error: err };
  }
}

/**
 * Build the custom controller State that hosts the Explorer grid + viewer. Kept
 * separate (and injectable) so the seam test never needs the real Backbone stack.
 * Returns null when wp.media.controller.State is unavailable (→ per-frame native).
 */
export function buildIwslState(wpMedia, config) {
  if (!wpMedia.controller || !wpMedia.controller.State) return null;
  const State = wpMedia.controller.State;

  return new State({
    id: IWSL_STATE_ID,
    title: "IWSL Library",
    priority: 1, // sits at the top of the router; native "Media Library" stays listed.
    // A live selection is what core's insert/featured/gallery consumers read, so we
    // reuse the frame's own selection model rather than inventing one.
    content: IWSL_STATE_ID,
    menu: "default",
    router: "browse",
    toolbar: "select",
    _iwslConfig: config,
  });
}

/**
 * Bind the content renderer for our state's mode onto ONE frame instance. Every
 * layer here is guarded: a render failure reverts THIS frame to the native
 * 'library' state (never a blank tab, never a thrown error out of Backbone).
 */
export function wireContent(frame, wpMedia, config) {
  if (!frame || typeof frame.on !== "function" || !wpMedia || !wpMedia.View) return;
  frame.on("content:render:" + IWSL_STATE_ID, function () {
    try {
      const IwslContent = wpMedia.View.extend({
        className: "iwsl-native-modal-content",
        render: function () {
          renderExplorerInto(this.el, config, frame, wpMedia);
          return this;
        },
      });
      frame.content.set(new IwslContent());
    } catch (e) {
      warnOnce("IWSL modal content failed — reverting to native library.");
      try {
        frame.setState("library"); // per-render fallback: the native grid.
      } catch (e2) {
        /* nothing more we can safely do; native tabs remain reachable. */
      }
    }
  });
}

/**
 * Build the minimal Explorer grid into a container: fetch the fused read-model over
 * the read-tier list endpoint, render tiles, open the shared viewer on click, and
 * resolve a chosen tile to a real wp.media Attachment so core's insert/featured/
 * gallery consumers behave identically. Purely additive; never throws upward.
 */
export function renderExplorerInto(container, config, frame, wpMedia) {
  if (!container) return;
  const doc = container.ownerDocument || document;
  container.textContent = "";
  const grid = doc.createElement("div");
  grid.className = "iwsl-native-grid";
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;padding:14px;overflow:auto;";
  container.appendChild(grid);

  browseList(config, { page: 1, per_page: 60 })
    .then((data) => {
      const items = (data && data.items) || [];
      if (items.length === 0) {
        grid.appendChild(doc.createTextNode("No media found."));
        return;
      }
      items.forEach((item) => grid.appendChild(makeTile(item, config, frame, wpMedia, doc)));
    })
    .catch(() => {
      grid.appendChild(doc.createTextNode("Media could not be loaded."));
    });
}

/** One grid tile: thumb + view affordance + pointer-aware open/choose. */
function makeTile(item, config, frame, wpMedia, doc) {
  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
  const tile = doc.createElement("button");
  tile.type = "button";
  tile.className = "iwsl-native-tile";
  tile.style.cssText = "position:relative;border:1px solid #dcdcde;border-radius:6px;padding:0;overflow:hidden;background:#fff;cursor:pointer;aspect-ratio:1;";
  const img = doc.createElement("img");
  img.src = item.thumb || item.url || "";
  img.alt = item.alt || item.title || "";
  img.loading = "lazy";
  img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
  tile.appendChild(img);

  // Explicit "view" affordance — the reliable way to open the viewer on ANY device,
  // so viewing never depends on a fragile double-tap/hover. stopPropagation keeps it
  // from also triggering the tile's choose/open handler.
  const view = doc.createElement("span");
  view.className = "iwsl-native-view";
  view.setAttribute("role", "button");
  view.setAttribute("tabindex", "0");
  view.setAttribute("aria-label", "Open in viewer");
  view.title = "Open in viewer";
  view.textContent = "⤢"; // ⤢ expand glyph
  view.style.cssText = "position:absolute;top:4px;right:4px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;font-size:14px;line-height:1;cursor:pointer;z-index:1;";
  const openFromAffordance = (e) => {
    try {
      if (e) { e.preventDefault(); if (typeof e.stopPropagation === "function") e.stopPropagation(); }
      openViewer(item.id, config, doc);
    } catch (err) {
      warnOnce("IWSL viewer open failed.");
    }
  };
  view.addEventListener("click", openFromAffordance);
  view.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") openFromAffordance(e);
  });
  tile.appendChild(view);

  // Desktop contract preserved: single click = choose-into-selection, double click =
  // open viewer. On coarse/touch a single TAP opens the viewer (double-click is a
  // poor touch gesture), so the coarse dblclick is a no-op to avoid a double open.
  tile.addEventListener("click", () => {
    try {
      if (isCoarsePointer(win)) openViewer(item.id, config, doc);
      else chooseIntoSelection(item.id, frame, wpMedia);
    } catch (err) {
      warnOnce("IWSL tile action failed.");
    }
  });
  tile.addEventListener("dblclick", (e) => {
    try {
      if (isCoarsePointer(win)) return;
      e.preventDefault();
      openViewer(item.id, config, doc);
    } catch (err) {
      warnOnce("IWSL tile action failed.");
    }
  });
  return tile;
}

/**
 * Resolve an id to a real wp.media Attachment model and add it to the frame's
 * live selection, so single/featured/gallery/custom consumers read exactly the
 * payload core expects — the compatibility keystone.
 */
export function chooseIntoSelection(id, frame, wpMedia) {
  try {
    if (!wpMedia || typeof wpMedia.attachment !== "function" || !frame || typeof frame.state !== "function") return;
    const attachment = wpMedia.attachment(id);
    if (attachment && typeof attachment.fetch === "function") attachment.fetch();
    const state = frame.state();
    const selection = state && typeof state.get === "function" ? state.get("selection") : null;
    if (selection && typeof selection.add === "function") {
      if (typeof selection.reset === "function" && !state.get("multiple")) selection.reset([attachment]);
      else selection.add(attachment);
    }
  } catch (e) {
    warnOnce("IWSL selection resolve failed.");
  }
}

// ── the browse grid + viewer (defensive; can never throw out of the frame) ───────

/**
 * Fetch one page of the fused read-model over the read-tier AJAX. Resolves to the
 * list envelope or an empty one on any failure (browse must never explode the modal).
 *
 * @returns {Promise<object>}
 */
export function browseList(config, params, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch || !config.ajaxUrl || !config.actions.list) {
    return Promise.resolve({ items: [], total: 0, pages: 0 });
  }
  const body = new URLSearchParams();
  body.set("action", config.actions.list);
  body.set("nonce", config.nonce);
  Object.keys(params || {}).forEach((k) => body.set(k, String(params[k])));
  return doFetch(config.ajaxUrl, { method: "POST", credentials: "same-origin", body })
    .then((r) => r.json())
    .then((j) => (j && j.success && j.data ? j.data : { items: [], total: 0, pages: 0 }))
    .catch(() => ({ items: [], total: 0, pages: 0 }));
}

/**
 * The WP adapter the shared viewer speaks through. READ verbs bind to this class's
 * upload_files-guarded browse endpoints; MUTATION verbs are intentionally left
 * unbound here (the viewer already guards `typeof adapter.x === 'function'`, so
 * their panels render read-only) until the manage_options AJAX twins land — see
 * the connector plan's Agent-A follow-up. This keeps the takeover from smuggling a
 * mutation path in under the read tier.
 */
export function makeWpReadAdapter(config, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const post = (action, fields) => {
    if (!doFetch || !config.ajaxUrl || !action) return Promise.resolve(null);
    const body = new URLSearchParams();
    body.set("action", action);
    body.set("nonce", config.nonce);
    Object.keys(fields || {}).forEach((k) => body.set(k, String(fields[k])));
    return doFetch(config.ajaxUrl, { method: "POST", credentials: "same-origin", body })
      .then((r) => r.json())
      .then((j) => (j && j.success ? j.data : null))
      .catch(() => null);
  };
  return {
    getAsset: (id) => post(config.actions.get, { id }),
    list: (params) => browseList(config, params, doFetch),
    // Mutations deliberately absent (read tier) — the viewer degrades gracefully.
  };
}

/**
 * Open the shared admin viewer for one asset inside the given document. Thin,
 * defensive wrapper so a viewer error can never bubble into the Backbone frame.
 */
export function openViewer(assetId, config, doc) {
  try {
    const viewer = createAdminViewer({
      adapter: makeWpReadAdapter(config),
      assetId: assetId,
      features: config.features,
      can: (cap) => !!(config.can && config.can[cap]),
      document: doc || document,
    });
    viewer.open(assetId);
    return viewer;
  } catch (e) {
    warnOnce("IWSL viewer failed to open.");
    return null;
  }
}

/**
 * True when the primary pointer is coarse (touch/pen) — the signal for treating a
 * single tap on a tile as "open the viewer" instead of "choose into selection".
 * Defensive: any matchMedia hiccup resolves to false, preserving the desktop contract.
 */
export function isCoarsePointer(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w || typeof w.matchMedia !== "function") return false;
  try {
    return !!w.matchMedia("(pointer:coarse)").matches;
  } catch (e) {
    return false;
  }
}

// ── one-per-page console warning ─────────────────────────────────────────────────

let _warned = false;
/** Log at most one warning per page load (spec: "error logged once"). */
export function warnOnce(message) {
  if (_warned) return;
  _warned = true;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn("[iwsl-media] " + String(message));
  }
}

/** Test-only reset for the one-per-page latch. */
export function _resetWarned() {
  _warned = false;
}

// ── bootstrap (runs in the browser; a no-op under a bare module import) ──────────

/** Wire the takeover once the DOM + wp.media are ready. Safe to call repeatedly. */
export function boot(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w || !w.wp || !w.wp.media) return { installed: false, fellBack: true };
  return installIwslState(w.wp.media, readConfig(w));
}

if (typeof window !== "undefined") {
  // Defer to give wp.media time to define its frames.
  const start = () => boot(window);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
