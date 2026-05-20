"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type Row,
  type RowSelectionState,
  type SortingState,
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
  pageSizeOptions = [10, 25, 50, 100],
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

  const filterableColumnId = filterColumn ?? table.getAllLeafColumns().find((column) => column.id !== "select")?.id;
  const filterableColumn = filterableColumnId ? table.getColumn(filterableColumnId) : undefined;
  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original);

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

  const renderedBulkActions =
    typeof bulkActions === "function"
      ? bulkActions({
          selectedRows,
          clearSelection: () => table.resetRowSelection(),
        })
      : bulkActions;

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
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]" />
              <input
                value={(filterableColumn.getFilterValue() as string) ?? ""}
                onChange={(event) => filterableColumn.setFilterValue(event.target.value)}
                placeholder={filterPlaceholder}
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
                onClick={() => table.resetRowSelection()}
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
          <div className="relative" ref={columnMenuRef}>
            <button
              type="button"
              onClick={() => setColumnMenuOpen((open) => !open)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-3 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
            >
              <Eye className="h-4 w-4" />
              Columns
              <ChevronDown className={cn("h-4 w-4 transition-transform", columnMenuOpen && "rotate-180")} />
            </button>
            {columnMenuOpen ? (
              <div className="absolute right-0 z-20 mt-2 min-w-[12rem] rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-2 shadow-xl">
                {table
                  .getAllLeafColumns()
                  .filter((column) => column.id !== "select" && column.getCanHide())
                  .map((column) => (
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
                        className="border-b border-[rgb(var(--color-border))] px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]"
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
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    "transition-colors hover:bg-[rgb(var(--color-surface-raised))]",
                    onRowClick && "cursor-pointer",
                    row.getIsSelected() && "bg-[rgb(var(--color-brand-500))]/5",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="border-b border-[rgb(var(--color-border))] px-4 py-3 align-middle text-[rgb(var(--color-text-primary))] last:w-full"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-3 border-t border-[rgb(var(--color-border))] px-4 py-3 text-sm text-[rgb(var(--color-text-secondary))] sm:flex-row sm:items-center sm:justify-between">
          <div>
            Showing {table.getFilteredRowModel().rows.length === 0 ? 0 : table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}
            -{Math.min(
              (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
              table.getFilteredRowModel().rows.length,
            )} of {table.getFilteredRowModel().rows.length}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span>Rows</span>
              <select
                value={table.getState().pagination.pageSize}
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] transition-colors hover:border-[rgb(var(--color-border-strong))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-20 text-center text-[rgb(var(--color-text-primary))]">
                Page {table.getState().pagination.pageIndex + 1} / {Math.max(table.getPageCount(), 1)}
              </span>
              <button
                type="button"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] transition-colors hover:border-[rgb(var(--color-border-strong))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
