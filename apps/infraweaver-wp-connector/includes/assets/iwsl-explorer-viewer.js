/**
 * iwsl-explorer-viewer — the tiny ES-module BRIDGE that lets the full-page Media
 * Explorer open the shared media viewer ("open an image and see everything").
 *
 * It imports the framework-free `createAdminViewer` from the shared viewer module
 * (owned elsewhere — never edited here) and composes it with a WP adapter whose
 * getAsset / updateMeta / del POST to the three manage_options-guarded admin-ajax
 * actions the folders engine registers (iwsl_mf_detail_get / _save / _delete). The
 * action names + nonce + ajaxurl arrive on `window.IWSL_EXPLORER_VIEWER`, printed
 * inline by IWSL_Media_Folders_UI::enqueue_viewer_assets().
 *
 * The bridge exposes ONE entry point the inline explorer driver calls:
 *     window.IWSL_EXPLORER_OPEN = (id) => viewer.open(id)
 *
 * FAIL-SOFT. Every seam is wrapped so a missing config, a viewer error, or a failed
 * request degrades to "the viewer just doesn't open" — the Explorer page keeps
 * working (drag-drop filing, the Move picker, everything else). No throw escapes.
 */

import { createAdminViewer } from "./iwsl-media-viewer.js";

/** Read the localized config the PHP side printed (window.IWSL_EXPLORER_VIEWER). */
export function readConfig(win) {
  const w = win || (typeof window !== "undefined" ? window : {});
  const c = w.IWSL_EXPLORER_VIEWER || {};
  return {
    ajaxUrl: c.ajaxUrl || "",
    nonce: c.nonce || "",
    actions: c.actions || { get: "", save: "", del: "" },
    features: c.features || {},
    can: c.can || {},
  };
}

/**
 * POST one urlencoded, same-origin, nonce-carrying request to admin-ajax and resolve
 * to the success `data` envelope (or null on any failure). Object-valued fields are
 * serialized as `key[sub]=value` so `{ fields: { alt: "x" } }` reaches PHP as the
 * `fields` array the detail-save handler expects. Never rejects.
 */
export function postAjax(config, action, fields, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch || !config.ajaxUrl || !action) {
    return Promise.resolve(null);
  }
  const body = new URLSearchParams();
  body.set("action", action);
  body.set("nonce", config.nonce);
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k];
    if (v === undefined || v === null) {
      return;
    }
    if (typeof v === "object") {
      Object.keys(v).forEach((sub) => body.set(k + "[" + sub + "]", String(v[sub])));
    } else {
      body.set(k, String(v));
    }
  });
  return doFetch(config.ajaxUrl, { method: "POST", credentials: "same-origin", body })
    .then((r) => r.json())
    .then((j) => (j && j.success ? j.data : null))
    .catch(() => null);
}

/**
 * The WP adapter the shared viewer speaks through on the Explorer page. Mutations
 * are bound here (unlike the read-tier modal adapter) because the Explorer is a
 * manage_options surface; the server re-checks the cap + nonce + gate on every call.
 * Signatures match createAdminViewer's calls exactly:
 *   getAsset(id) · updateMeta(id, fields, expectModified) · del(id)
 */
export function makeExplorerAdapter(config, fetchImpl) {
  return {
    getAsset: (id) => postAjax(config, config.actions.get, { id: id }, fetchImpl),
    updateMeta: (id, fields, expectModified) =>
      postAjax(config, config.actions.save, { id: id, expect_modified: expectModified || "", fields: fields || {} }, fetchImpl),
    del: (id) => postAjax(config, config.actions.del, { id: id, confirm: "1" }, fetchImpl),
  };
}

/** Compose the shared admin viewer with the Explorer adapter + this page's context. */
export function createExplorerViewer(win) {
  const w = win || (typeof window !== "undefined" ? window : {});
  const config = readConfig(w);
  return createAdminViewer({
    adapter: makeExplorerAdapter(config),
    features: config.features,
    can: (cap) => !!(config.can && config.can[cap]),
    document: w.document || (typeof document !== "undefined" ? document : undefined),
  });
}

// ── bootstrap: publish the one entry point the inline driver calls ────────────────

if (typeof window !== "undefined") {
  try {
    const viewer = createExplorerViewer(window);
    window.IWSL_EXPLORER_OPEN = function (id) {
      try {
        viewer.open(id);
      } catch (e) {
        /* fail-soft: a viewer error must never break the Explorer page. */
      }
    };
  } catch (e) {
    /* fail-soft: no viewer → the Explorer still files, moves, tags, colours. */
  }
}
