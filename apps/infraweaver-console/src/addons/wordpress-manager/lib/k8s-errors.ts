/**
 * Self-contained helpers for interpreting @kubernetes/client-node errors. In
 * v1.x the thrown error is an `ApiException` carrying a numeric `.code` (the HTTP
 * status); we also tolerate the older `.statusCode` / `.body.code` shapes so the
 * addon stays robust across client versions. Kept addon-local so the addon does
 * not reach into another addon's helpers.
 */
export function k8sErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; statusCode?: unknown; body?: { code?: unknown } };
  if (typeof e.code === "number") return e.code;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.body?.code === "number") return e.body.code;
  return null;
}

export function isK8sNotFound(error: unknown): boolean {
  return k8sErrorStatus(error) === 404;
}
