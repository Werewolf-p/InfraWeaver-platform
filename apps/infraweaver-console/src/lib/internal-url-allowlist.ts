const KNOWN_INTERNAL_HOSTS = new Set([
  "10.25.0.21",
  "10.25.0.135",
  "argocd-server.argocd.svc.cluster.local",
  "argocd.int.rlservers.com",
  "grafana.monitoring.svc.cluster.local",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
  "openbao.openbao.svc.cluster.local",
  "prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local",
  "registry.int.rlservers.com",
]);

export function isAllowedInternalHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".int.rlservers.com") || KNOWN_INTERNAL_HOSTS.has(normalized);
}

export function parseAllowedInternalUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!isAllowedInternalHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}
