import path from "node:path";

/**
 * Validate a Kubernetes resource name (DNS subdomain: a-z0-9-.)
 */
export function isValidK8sName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-.]*[a-z0-9]$/.test(name) && name.length <= 253;
}

export function isValidNamespace(ns: string): boolean {
  return isValidK8sName(ns) && ns.length <= 63;
}

export function isValidContainerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(name) && name.length <= 63;
}

export function sanitizeK8sLabel(value: string): string {
  return value.replace(/[^a-z0-9\-_.]/g, "").slice(0, 63);
}

function normalizeContainerPath(value: string): string | null {
  if (!value || !value.startsWith("/") || value.includes("\0")) return null;
  const rawSegments = value.split("/").filter(Boolean);
  if (rawSegments.some((segment) => segment === "." || segment === "..")) return null;
  const normalized = path.posix.normalize(value);
  return normalized.startsWith("/") ? normalized : null;
}

/**
 * Validates a file path used for kubectl exec operations inside a game container.
 * Rejects traversal segments and null bytes before shell execution.
 */
export function validateContainerPath(path: string): boolean {
  return normalizeContainerPath(path) !== null;
}

export function validateContainerPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizeContainerPath(targetPath);
  const normalizedRoot = normalizeContainerPath(rootPath);
  if (!normalizedTarget || !normalizedRoot) return false;
  if (normalizedRoot === "/") return true;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
