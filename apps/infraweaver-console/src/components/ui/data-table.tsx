"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Download,
  Eye,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonTable } from "@/components/ui/skeleton-table";

// ---------------------------------------------------------------------------
// Sub-components extracted so React.memo can prevent their re-renders when
// their own props have not changed.
// ---------------------------------------------------------------------------

interface TableRowProps<TData> {
  row: Row<TData>;
  onRowClick?: (row: TData) => void;
}

// Generic React.memo requires a cast because memo() doesn't forward generics.
const TableRow = React.memo(function TableRow<TData>({
  row,
  onRowClick,
}: TableRowProps<TData>) {
  const handleClick = React.useCallback(() => {
    onRowClick?.(row.original);
  }, [onRowClick, row.original]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onRowClick?.(row.original);
      }
    },
    [onRowClick, row.original],
  );

  const interactiveProps = onRowClick
    ? { role: "button" as const, tabIndex: 0, onKeyDown: handleKeyDown }
    : {};

  return (
    <tr
      onClick={onRowClick ? handleClick : undefined}
      {...interactiveProps}
      className={cn(
        "transition-colors hover:bg-[rgb(var(--color-surface-raised))]",
        onRowClick && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-brand-500))]",
        row.getIsSelected() && "bg-[rgb(var(--color-brand-500))]/5",
      )}
    >
      {row.getVisibleCells().map((cell) => (
        <td
          key={cell.id}
          className="border-b border-[rgb(var(--color-border))] px-[var(--tbl-px)] py-[var(--tbl-py)] align-middle text-[rgb(var(--color-text-primary))] last:w-full"
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}) as <TData>(props: TableRowProps<TData>) => React.ReactElement;

// Pagination footer reads mutable pagination state through the stable `table`
// instance, so it must NOT be memoised on props: React.memo would bail out on
// page changes (props stay referentially equal) and freeze the footer.
interface PaginationFooterProps<TData> {
  table: Table<TData>;
  pageSizeOptions: number[];
  filteredRowCount: number;
}

function PaginationFooter<TData>({
  table,
  pageSizeOptions,
  filteredRowCount,
}: PaginationFooterProps<TData>) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const firstRow = filteredRowCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRow = Math.min((pageIndex + 1) * pageSize, filteredRowCount);

  return (
    <div className="flex flex-col gap-3 border-t border-[rgb(var(--color-border))] px-4 py-3 text-sm text-[rgb(var(--color-text-secondary))] sm:flex-row sm:items-center sm:justify-between">
      <div>
        Showing {firstRow}-{lastRow} of {filteredRowCount}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
            className="h-9 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-2 text-[rgb(var(--color-text-primary))] outline-none"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] transition-colors hover:border-[rgb(var(--color-border-strong))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </button>
          <span aria-live="polite" className="min-w-20 text-center text-[rgb(var(--color-text-primary))]">
            Page {pageIndex + 1} / {Math.max(table.getPageCount(), 1)}
          </span>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] transition-colors hover:border-[rgb(var(--color-border-strong))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Column-visibility toggle menu is pure given its own column list.
interface ColumnMenuProps<TData> {
  table: Table<TData>;
  open: boolean;
  onToggle: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}

const ColumnMenu = React.memo(function ColumnMenu<TData>({
  table,
  open,
  onToggle,
  menuRef,
}: ColumnMenuProps<TData>) {
  const columnVisibility = table.getState().columnVisibility;
  const hidableColumns = React.useMemo(
    () => table.getAllLeafColumns().filter((col) => col.id !== "select" && col.getCanHide()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columnVisibility state drives re-render
    [table, columnVisibility],
  );

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-3 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
      >
        <Eye aria-hidden="true" className="h-4 w-4" />
        Columns
        <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div role="group" aria-label="Toggle columns" className="absolute right-0 z-20 mt-2 min-w-[12rem] rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-2 shadow-xl">
          {hidableColumns.map((column: Column<TData, unknown>) => (
            <label
              key={column.id}
              className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:bg-[rgb(var(--color-surface-raised))]"
            >
              <input
                type="checkbox"
                checked={column.getIsVisible()}
                onChange={column.getToggleVisibilityHandler()}
                className="h-4 w-4 rounded border-[rgb(var(--color-border-strong))]"
              />
              <span>{column.id}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}) as <TData>(props: ColumnMenuProps<TData>) => React.ReactElement;

// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  loading?: boolean;
  className?: string;
  filterColumn?: string;
  filterPlaceholder?: string;
  pageSizeOptions?: number[];
  initialPageSize?: number;
  enableRowSelection?: boolean;
  bulkActions?: React.ReactNode | ((args: { selectedRows: TData[]; clearSelection: () => void }) => React.ReactNode);
  emptyState?: React.ReactNode;
  exportFileName?: string;
  onRowClick?: (row: TData) => void;
  getRowId?: (originalRow: TData, index: number) => string;
}

function IndeterminateCheckbox({
  indeterminate,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = Boolean(indeterminate) && !props.checked;
    }
  }, [indeterminate, props.checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "h-4 w-4 rounded border-[rgb(var(--color-border-strong))] bg-transparent text-[rgb(var(--color-brand-500))] focus:ring-[rgb(var(--color-brand-500))]",
        className,
      )}
      {...props}
    />
  );
}

export function DataTable<TData>({
  columns,
  data,
  loading,
  className,
  filterColumn,
  filterPlaceholder = "Filter rows…",
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  initialPageSize = 10,
  enableRowSelection = true,
  bulkActions,
  emptyState,
  exportFileName = "export",
  onRowClick,
  getRowId,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnMenuOpen, setColumnMenuOpen] = React.useState(false);
  const columnMenuRef = React.useRef<HTMLDivElement | null>(null);
  const toggleColumnMenu = React.useCallback(() => setColumnMenuOpen((open) => !open), []);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!columnMenuRef.current?.contains(event.target as Node)) {
        setColumnMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const selectionColumn = React.useMemo<ColumnDef<TData, unknown>>(
    () => ({
      id: "select",
      enableHiding: false,
      enableSorting: false,
      enableColumnFilter: false,
      header: ({ table }) => (
        <IndeterminateCheckbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onChange={table.getToggleAllPageRowsSelectedHandler()}
          aria-label="Select all rows"
        />
      ),
      cell: ({ row }: { row: Row<TData> }) => (
        <IndeterminateCheckbox
          checked={row.getIsSelected()}
          indeterminate={row.getIsSomeSelected()}
          onChange={row.getToggleSelectedHandler()}
          aria-label="Select row"
          onClick={(event) => event.stopPropagation()}
        />
      ),
      size: 40,
    }),
    [],
  );

  const tableColumns = React.useMemo(
    () => (enableRowSelection ? [selectionColumn, ...columns] : columns),
    [columns, enableRowSelection, selectionColumn],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns non-memoizable functions by design; the React Compiler correctly skips it and this component memoizes its own derived state above
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    enableRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId,
    initialState: {
      pagination: {
        pageSize: initialPageSize,
      },
    },
  });

  // Stable column reference — only recomputed when the column list or the
  // explicit filterColumn prop changes.
  const filterableColumn = React.useMemo<ReturnType<typeof table.getColumn>>(() => {
    const id = filterColumn ?? table.getAllLeafColumns().find((col) => col.id !== "select")?.id;
    return id ? table.getColumn(id) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tableColumns identity tracks the column list changing
  }, [filterColumn, table, tableColumns]);

  // Recompute selected originals only when rowSelection state changes.
  const selectedRows = React.useMemo(
    () => table.getSelectedRowModel().rows.map((row) => row.original),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowSelection is the reactive signal
    [rowSelection, table],
  );

  // Stable clear-selection callback passed into bulkActions render-prop.
  const clearSelection = React.useCallback(() => {
    table.resetRowSelection();
  }, [table]);

  const exportToCsv = React.useCallback(() => {
    const visibleColumns = table.getVisibleLeafColumns().filter((column) => column.id !== "select");
    const rows = table.getFilteredRowModel().rows;
    const header = visibleColumns.map((column) => {
      const headerDef = column.columnDef.header;
      if (typeof headerDef === "string") return headerDef;
      return column.id;
    });
    const csvRows = rows.map((row) =>
      visibleColumns.map((column) => {
        const rawValue = row.getValue(column.id);
        const value = rawValue == null ? "" : String(rawValue);
        return `"${value.replace(/"/g, '""')}"`;
      }).join(","),
    );
    const csvContent = [header.join(","), ...csvRows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportFileName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [exportFileName, table]);

  // Stable filtered row count — recomputed only when filters or data change,
  // not on every pagination state update.
  const filteredRowCount = React.useMemo(
    () => table.getFilteredRowModel().rows.length,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columnFilters is the reactive signal
    [columnFilters, data, table],
  );

  // Memoize the rendered bulk actions so the render-prop is only re-invoked
  // when selectedRows or clearSelection actually changes.
  const renderedBulkActions = React.useMemo(
    () =>
      typeof bulkActions === "function"
        ? bulkActions({ selectedRows, clearSelection })
        : bulkActions,
    [bulkActions, selectedRows, clearSelection],
  );

  if (loading) {
    return <SkeletonTable rows={5} columns={Math.max(columns.length, 4)} className={className} />;
  }

  if (!data.length) {
    return (
      <div className={className}>
        {emptyState ?? (
          <EmptyState
            title="No results"
            description="There is no data available for this view yet."
            className="min-h-[240px]"
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          {filterableColumn ? (
            <div className="relative w-full sm:max-w-sm">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]" />
              <input
                value={(filterableColumn.getFilterValue() as string) ?? ""}
                onChange={(event) => filterableColumn.setFilterValue(event.target.value)}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                className="h-11 w-full rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] pl-10 pr-10 text-sm text-[rgb(var(--color-text-primary))] outline-none transition-colors placeholder:text-[rgb(var(--color-text-tertiary))] focus:border-[rgb(var(--color-border-strong))]"
              />
              {(filterableColumn.getFilterValue() as string) ? (
                <button
                  type="button"
                  onClick={() => filterableColumn.setFilterValue("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))] transition-colors hover:text-[rgb(var(--color-text-primary))]"
                  aria-label="Clear filter"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ) : null}
          {enableRowSelection && selectedRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[rgb(var(--color-brand-500))]/20 bg-[rgb(var(--color-brand-500))]/10 px-3 py-2 text-sm text-[rgb(var(--color-text-primary))]">
              <span>{selectedRows.length} selected</span>
              {renderedBulkActions}
              <button
                type="button"
                onClick={clearSelection}
                className="text-[rgb(var(--color-brand-600))] transition-colors hover:text-[rgb(var(--color-brand-700))] dark:text-[rgb(var(--color-brand-500))]"
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={exportToCsv}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-3 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          <ColumnMenu
            table={table}
            open={columnMenuOpen}
            onToggle={toggleColumnMenu}
            menuRef={columnMenuRef}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] shadow-sm">
        <div className="overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-[rgba(var(--color-surface-raised),0.95)] backdrop-blur">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const canSort = header.column.getCanSort();
                    return (
                      <th
                        key={header.id}
                        className="border-b border-[rgb(var(--color-border))] px-[var(--tbl-px)] py-[var(--tbl-py)] text-left text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]"
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1.5 text-left transition-colors hover:text-[rgb(var(--color-text-primary))]"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : sorted === "desc" ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronsUpDown className="h-4 w-4 opacity-60" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} row={row} onRowClick={onRowClick} />
              ))}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          table={table}
          pageSizeOptions={pageSizeOptions}
          filteredRowCount={filteredRowCount}
        />
      </div>
    </div>
  );
}
