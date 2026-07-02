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
