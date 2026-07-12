/**
 * @/lib/k8s-quantity — Generic Kubernetes resource quantity parsers.
 *
 * These are storage/CPU/memory quantity helpers with no addon specifics, so
 * they live in core and can be shared by cluster metrics, gamehub, etc.
 */

/**
 * Parse a Kubernetes CPU quantity (e.g. "250m", "1", "1500u", "10n") into a
 * number of CPU cores.
 */
export function parseCpuQuantity(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed.endsWith("n")) return Number.parseFloat(trimmed.slice(0, -1)) / 1_000_000_000;
  if (trimmed.endsWith("u")) return Number.parseFloat(trimmed.slice(0, -1)) / 1_000_000;
  if (trimmed.endsWith("m")) return Number.parseFloat(trimmed.slice(0, -1)) / 1000;
  return Number.parseFloat(trimmed);
}

/**
 * Parse a Kubernetes memory quantity (e.g. "512Mi", "2Gi", "1000M") into a
 * number of bytes.
 */
export function parseMemoryBytes(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const match = trimmed.match(/^([0-9.]+)\s*([KMGTE]i|[kMGTPE])?$/);
  if (!match) return Number.parseFloat(trimmed) || 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  };
  return amount * (multipliers[unit] ?? 1);
}

/**
 * Parse a Kubernetes CPU quantity (e.g. "250m", "1", "123456789n") into
 * millicores. Millicores counterpart of parseCpuQuantity — same math as the
 * cluster-metrics route's parseCpuToMillicores for its "n"/"m"/plain inputs,
 * with garbage coerced to 0.
 */
export function parseCpuMillicores(value: string | null | undefined): number {
  const millicores = parseCpuQuantity(value) * 1000;
  return Number.isFinite(millicores) ? millicores : 0;
}

/**
 * Parse a Kubernetes memory quantity (e.g. "512Mi", "2Gi", "524288Ki") into
 * mebibytes. Mi counterpart of parseMemoryBytes — same Ki/Mi/Gi ladder as the
 * cluster-metrics route's parseMemoryToKi (divided by 1024). May return a
 * fractional value for decimal-unit inputs; callers round as needed.
 */
export function parseMemoryMi(value: string | null | undefined): number {
  const bytes = parseMemoryBytes(value);
  return Number.isFinite(bytes) ? bytes / (1024 * 1024) : 0;
}

export type QuantityKind = "cpu" | "memory";

/**
 * Format a resource amount as a Kubernetes quantity string.
 *
 * - `kind: "cpu"` — `value` is CPU cores. Whole cores stay bare ("2"), clean
 *   tenths mirror the game-hub new page's formatCpu ("1.5"), anything finer is
 *   emitted as millicores ("250m") so precision survives round-trips.
 * - `kind: "memory"` — `value` is Mi. Whole Gi multiples collapse to Gi
 *   (mirrors the game-hub new page's formatMemory), sub-1Mi values are emitted
 *   as Ki, everything else stays Mi.
 */
export function formatQuantity(value: number, kind: QuantityKind): string {
  if (kind === "cpu") {
    if (Number.isInteger(value)) return String(value);
    const millicores = Math.round(value * 1000);
    if (millicores % 100 !== 0) return `${millicores}m`;
    return value.toFixed(1).replace(/\.0$/, "");
  }
  if (value > 0 && value < 1) return `${Math.round(value * 1024)}Ki`;
  return value % 1024 === 0 ? `${value / 1024}Gi` : `${Math.round(value)}Mi`;
}
