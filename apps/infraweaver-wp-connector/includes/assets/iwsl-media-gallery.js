/**
 * iwsl-media-gallery — the PUBLIC, front-end lightbox for the tag gallery.
 *
 * THE FENCE (information-disclosure boundary). This module imports ONLY the
 * presentation core (`createPresentationCore`) from the shared viewer — never the
 * admin `createAdminViewer`, never the panel registry, never an adapter. It reads its
 * items PURELY from the gallery markup already on the page (each item's href / alt /
 * caption data-attributes) and performs ZERO network requests and ZERO signed calls.
 * A logged-out visitor therefore reaches no admin data (no folders, no optimization
 * or CDN state, no uploader) and no signed method — the lightbox is a pure viewer of
 * public image URLs.
 *
 * No build step: it is enqueued as a native ES module (the engine's script_loader_tag
 * filter adds type="module"), so the relative import below resolves against the
 * sibling viewer file in this same assets/ directory.
 */

import { createPresentationCore } from "./iwsl-media-viewer.js";

/** Collect the lightbox items for one gallery straight from its DOM markup. */
function itemsFor(gallery) {
  const links = gallery.querySelectorAll(".iwsl-gallery__link");
  const items = [];
  links.forEach((link) => {
    items.push({
      src: link.getAttribute("data-iwsl-full") || link.getAttribute("href") || "",
      alt: link.getAttribute("data-iwsl-alt") || "",
      caption: link.getAttribute("data-iwsl-caption") || "",
    });
  });
  return items;
}

/** Wire one gallery: clicking any item opens the presentation core at that index. */
function wireGallery(gallery) {
  if (gallery.getAttribute("data-iwsl-lightbox") !== "1") return;
  const links = Array.prototype.slice.call(gallery.querySelectorAll(".iwsl-gallery__link"));
  links.forEach((link, index) => {
    link.addEventListener("click", (ev) => {
      // Fall back to normal navigation on modified clicks (new tab / download).
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      const items = itemsFor(gallery);
      if (!items.length) {
        window.location.assign(link.getAttribute("href") || "");
        return;
      }
      const core = createPresentationCore({ items, index });
      core.open(index);
    });
  });
}

function init() {
  const galleries = document.querySelectorAll(".iwsl-gallery[data-iwsl-lightbox='1']");
  galleries.forEach(wireGallery);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
