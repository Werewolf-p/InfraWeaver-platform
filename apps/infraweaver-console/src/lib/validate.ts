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
