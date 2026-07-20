/**
 * Pure, immutable selection helpers for the WordPress fleet overview's bulk
 * actions. All operations return a NEW Set — the caller's selection is never
 * mutated in place, so React state updates stay predictable.
 *
 * The "universe" (`all`) is the list of sites currently visible in the fleet.
 * Selection is stored as a plain Set of site names; because the fleet list
 * refetches on an interval, `pruneSelection` drops any names that have since
 * disappeared so a stale tick can never target a deleted site.
 */

export type SiteSelection = ReadonlySet<string>;

/** Add a site if absent, remove it if present. */
export function toggleSite(selection: SiteSelection, site: string): Set<string> {
  const next = new Set(selection);
  if (next.has(site)) {
    next.delete(site);
  } else {
    next.add(site);
  }
  return next;
}

/** Everything in the current universe. */
export function selectAll(all: readonly string[]): Set<string> {
  return new Set(all);
}

/** Nothing selected. */
export function selectNone(): Set<string> {
  return new Set();
}

/**
 * Flip selection within the universe: sites that were selected become
 * unselected and vice-versa. Names outside the universe are dropped, so an
 * invert always yields a subset of `all`.
 */
export function invertSelection(all: readonly string[], selection: SiteSelection): Set<string> {
  const next = new Set<string>();
  for (const site of all) {
    if (!selection.has(site)) next.add(site);
  }
  return next;
}

/**
 * Intersect the selection with the current universe, dropping stale names. Use
 * this whenever the fleet list changes so selection can never reference a site
 * that no longer exists.
 */
export function pruneSelection(all: readonly string[], selection: SiteSelection): Set<string> {
  const universe = new Set(all);
  const next = new Set<string>();
  for (const site of selection) {
    if (universe.has(site)) next.add(site);
  }
  return next;
}

/** Selected sites in the universe's display order (stable, prunes stragglers). */
export function orderedSelection(all: readonly string[], selection: SiteSelection): string[] {
  return all.filter((site) => selection.has(site));
}

/** True when every site in a non-empty universe is selected. */
export function isAllSelected(all: readonly string[], selection: SiteSelection): boolean {
  if (all.length === 0) return false;
  return all.every((site) => selection.has(site));
}

/** True when at least one — but not every — site is selected. Drives the tri-state header checkbox. */
export function isIndeterminate(all: readonly string[], selection: SiteSelection): boolean {
  const count = countSelected(all, selection);
  return count > 0 && count < all.length;
}

/** How many of the currently visible sites are selected. */
export function countSelected(all: readonly string[], selection: SiteSelection): number {
  let count = 0;
  for (const site of all) {
    if (selection.has(site)) count += 1;
  }
  return count;
}
