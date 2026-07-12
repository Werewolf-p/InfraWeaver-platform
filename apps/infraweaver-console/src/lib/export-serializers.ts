import { dump } from "js-yaml";

export type ExportFormat = "csv" | "json" | "yaml";
export type ExportRow = Record<string, unknown>;

/** MIME types matching the ExportButton download map. */
export const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv",
  json: "application/json",
  yaml: "text/yaml",
};

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: readonly ExportRow[]): string {
  if (rows.length === 0) return "";
  // Stable column order: keys in first-seen order across all rows, so sparse
  // rows don't drop columns.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [
    columns.map(toCsvCell).join(","),
    ...rows.map((row) => columns.map((column) => toCsvCell(row[column])).join(",")),
  ];
  return lines.join("\n");
}

/**
 * Serializes tabular rows for export — the shared implementation behind the
 * per-page CSV/JSON/YAML `getData` builders used with ExportButton.
 */
export function serializeRows(rows: readonly ExportRow[], format: ExportFormat): string {
  switch (format) {
    case "csv":
      return toCsv(rows);
    case "json":
      return JSON.stringify(rows, null, 2);
    case "yaml":
      return dump(rows);
  }
}
