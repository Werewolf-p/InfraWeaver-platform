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

/**
 * Validates a file path used for kubectl exec operations inside a game container.
 * Rejects paths with '..' segments or null bytes — both prevent shell traversal attacks.
 */
export function validateContainerPath(path: string): boolean {
  if (!path || !path.startsWith("/")) return false;
  if (path.includes("..") || path.includes("\0")) return false;
  return true;
}
