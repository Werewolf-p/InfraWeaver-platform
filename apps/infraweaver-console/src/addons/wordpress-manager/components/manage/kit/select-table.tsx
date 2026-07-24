"use client";

/**
 * `SelectableDataTable` — the shared kit `DataTable` plus row selection. Adds a
 * leading checkbox column with a tri-state header (all / some / none), per-row
 * toggles, and shift-click RANGE select. Selection is fully CONTROLLED (a
 * `ReadonlySet<string>` in + `onSelectionChange` out) so the parent owns the
 * source of truth and the same set feeds `BulkActionBar`.
 *
 * Layout, responsiveness and accessibility come for free from the underlying
 * `DataTable`; this only prepends the select column, so fixing the table once
 * fixes selection everywhere.
 */

import { useCallback, useEffect, useRef, type JSX, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DataTable, type Column } from "../../demo/manage/kit/data-table";
import {
  applyRange,
  clearSelection,
  isAllSelected,
  isIndeterminate,
  rangeBetween,
  selectAllIds,
  toggleId,
  type IdSelection,
} from "../../../lib/manage/selection";

const CHECKBOX =
  "h-4 w-4 cursor-pointer rounded border-zinc-300 text-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-600 dark:bg-zinc-900";

export interface SelectableDataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly caption: string;
  /** Stable id per row — the value tracked in the selection set. */
  readonly getRowId: (row: T) => string;
  readonly selection: IdSelection;
  readonly onSelectionChange: (next: Set<string>) => void;
  readonly empty?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  /** Accessible label for a single row's checkbox (defaults to the row id). */
  readonly rowLabel?: (row: T) => string;
}

/** Header checkbox that reflects a tri-state (checked / indeterminate / empty). */
function HeaderCheckbox({
  checked,
  indeterminate,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  onToggle: () => void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      aria-label="Select all rows"
      className={CHECKBOX}
    />
  );
}

export function SelectableDataTable<T>({
  columns,
  rows,
  caption,
  getRowId,
  selection,
  onSelectionChange,
  empty,
  footer,
  className,
  rowLabel,
}: SelectableDataTableProps<T>): JSX.Element {
  const ids = rows.map(getRowId);
  const anchorRef = useRef<string | null>(null);

  const allSelected = isAllSelected(ids, selection);
  const someSelected = isIndeterminate(ids, selection);

  const toggleAll = useCallback(() => {
    onSelectionChange(allSelected ? clearSelection() : selectAllIds(ids));
  }, [allSelected, ids, onSelectionChange]);

  const onRowToggle = useCallback(
    (id: string, shiftKey: boolean) => {
      if (shiftKey && anchorRef.current && anchorRef.current !== id) {
        const range = rangeBetween(ids, anchorRef.current, id);
        onSelectionChange(applyRange(selection, range, !selection.has(id)));
      } else {
        onSelectionChange(toggleId(selection, id));
      }
      anchorRef.current = id;
    },
    [ids, selection, onSelectionChange],
  );

  // The checkbox column is DESKTOP-only: on phones the table already stacks into
  // cards and a per-card checkbox as the card title would be wrong. Ensure a real
  // column is the card's primary/title so the (mobileHidden) select column never
  // becomes it.
  const bodyColumns: readonly Column<T>[] = columns.some((c) => c.primary)
    ? columns
    : columns.map((c, i) => (i === 0 ? { ...c, primary: true } : c));

  const selectColumn: Column<T> = {
    key: "__select__",
    header: <HeaderCheckbox checked={allSelected} indeterminate={someSelected && !allSelected} onToggle={toggleAll} />,
    headClassName: "w-10",
    className: "w-10",
    mobileHidden: true,
    render: (row: T) => {
      const id = getRowId(row);
      return (
        <input
          type="checkbox"
          checked={selection.has(id)}
          aria-label={rowLabel ? rowLabel(row) : `Select ${id}`}
          // Controlled: the visual state comes from `checked`. onChange satisfies
          // React's controlled-input contract; the real toggle runs on click so we
          // can read `shiftKey` for range select.
          onChange={() => undefined}
          onClick={(event) => onRowToggle(id, event.shiftKey)}
          className={cn(CHECKBOX)}
        />
      );
    },
  };

  return (
    <DataTable
      columns={[selectColumn, ...bodyColumns]}
      rows={rows}
      caption={caption}
      getRowKey={(row) => getRowId(row)}
      empty={empty}
      footer={footer}
      className={className}
    />
  );
}
