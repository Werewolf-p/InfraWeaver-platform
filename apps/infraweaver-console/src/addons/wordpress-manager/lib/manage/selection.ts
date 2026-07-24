/**
 * Generic string-id selection helpers for IN-PANEL bulk select — the shared core
 * behind `SelectableDataTable` + `BulkActionBar`.
 *
 * The fleet overview's `lib/selection.ts` is already string-generic (its params
 * are named `site`/`all` but operate on plain string ids), so this module reuses
 * those tested primitives under domain-neutral names rather than duplicating
 * them, and adds the shift-click RANGE helpers the fleet toolbar never needed.
 *
 * Every function is PURE and returns a NEW set/array — the caller's selection is
 * never mutated, matching the immutability rule the fleet helpers already follow.
 */

import {
  countSelected,
  invertSelection,
  isAllSelected,
  isIndeterminate,
  orderedSelection,
  pruneSelection,
  selectAll,
  selectNone,
  toggleSite,
} from "../selection";

/** An immutable selection of arbitrary string ids. */
export type IdSelection = ReadonlySet<string>;

// The generic primitives, re-exported under id-centric names so a panel imports
// selection from ONE place. Signatures are unchanged (they were already generic).
export const toggleId = toggleSite;
export const selectAllIds = selectAll;
export const clearSelection = selectNone;
export {
  countSelected,
  invertSelection,
  isAllSelected,
  isIndeterminate,
  orderedSelection,
  pruneSelection,
};

/**
 * The INCLUSIVE slice of `ordered` between two ids, in either click order. Returns
 * `[]` when either id is absent from `ordered`. Powers shift-click range select:
 * the anchor is the last-clicked row, the target the shift-clicked row.
 */
export function rangeBetween(ordered: readonly string[], anchorId: string, targetId: string): string[] {
  const a = ordered.indexOf(anchorId);
  const b = ordered.indexOf(targetId);
  if (a === -1 || b === -1) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ordered.slice(lo, hi + 1);
}

/** Add (`select`) or remove (`!select`) a batch of ids, returning a NEW set. */
export function applyRange(selection: IdSelection, ids: readonly string[], select: boolean): Set<string> {
  const next = new Set(selection);
  for (const id of ids) {
    if (select) next.add(id);
    else next.delete(id);
  }
  return next;
}
