/** Parse a Kubernetes CPU quantity string to fractional cores (e.g. "500m" → 0.5). */
export function parseCpuCores(s: string): number {
  if (!s) return 0;
  if (s.endsWith('m')) return Number.parseInt(s, 10) / 1000;
  return Number.parseFloat(s) || 0;
}

/** Parse a Kubernetes memory quantity string to gibibytes (e.g. "512Mi" → 0.5). */
export function parseMemGi(s: string): number {
  if (!s) return 0;
  if (s.endsWith('Ki')) return Number.parseInt(s, 10) / (1024 * 1024);
  if (s.endsWith('Mi')) return Number.parseInt(s, 10) / 1024;
  if (s.endsWith('Gi')) return Number.parseFloat(s);
  return Number.parseFloat(s) / (1024 * 1024 * 1024);
}

/** Parse a Kubernetes memory quantity string to bytes. */
export function parseMemBytes(s: string | null): number {
  if (!s) return 0;
  if (s.endsWith('Ki')) return Number.parseInt(s, 10) * 1024;
  if (s.endsWith('Mi')) return Number.parseInt(s, 10) * 1024 * 1024;
  if (s.endsWith('Gi')) return Number.parseFloat(s) * 1024 * 1024 * 1024;
  if (s.endsWith('Ti')) return Number.parseFloat(s) * 1024 * 1024 * 1024 * 1024;
  return Number.parseInt(s, 10) || 0;
}

/** Convert a Ki-suffixed string to mebibytes (used for node memory reporting). */
export function kiToMi(kiStr: string): number {
  const ki = Number.parseInt(kiStr.replace('Ki', '').replace('m', ''), 10) || 0;
  return Math.round(ki / 1024);
}

/** Parse a Kubernetes CPU quantity string to millicores. */
export function cpuToMillicores(cpuStr: string): number {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith('m')) return Number.parseInt(cpuStr, 10) || 0;
  return Math.round((Number.parseFloat(cpuStr) || 0) * 1000);
}
