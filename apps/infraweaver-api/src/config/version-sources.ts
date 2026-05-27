export type VersionSource =
  | { type: 'helm'; repoUrl: string; chartName: string }
  | { type: 'docker'; image: string }
  | { type: 'ghcr'; owner: string; repo: string; packageName: string };

export type VersionSourceType = VersionSource['type'];

export const VERSION_SOURCES: Record<string, VersionSource> = {
  authentik: { type: 'ghcr', owner: 'goauthentik', repo: 'authentik', packageName: 'server' },
  argocd: { type: 'helm', repoUrl: 'https://argoproj.github.io/argo-helm', chartName: 'argo-cd' },
  longhorn: { type: 'helm', repoUrl: 'https://charts.longhorn.io', chartName: 'longhorn' },
  metallb: { type: 'helm', repoUrl: 'https://metallb.github.io/metallb', chartName: 'metallb' },
  traefik: { type: 'helm', repoUrl: 'https://helm.traefik.io/traefik', chartName: 'traefik' },
  'cert-manager': { type: 'helm', repoUrl: 'https://charts.jetstack.io', chartName: 'cert-manager' },
  kyverno: { type: 'helm', repoUrl: 'https://kyverno.github.io/kyverno/', chartName: 'kyverno' },
  'external-secrets': { type: 'helm', repoUrl: 'https://charts.external-secrets.io', chartName: 'external-secrets' },
  grafana: { type: 'helm', repoUrl: 'https://grafana.github.io/helm-charts', chartName: 'grafana' },
  loki: { type: 'helm', repoUrl: 'https://grafana.github.io/helm-charts', chartName: 'loki-stack' },
  falco: { type: 'helm', repoUrl: 'https://falcosecurity.github.io/charts', chartName: 'falco' },
  'kube-prometheus-stack': { type: 'helm', repoUrl: 'https://prometheus-community.github.io/helm-charts', chartName: 'kube-prometheus-stack' },
  'metrics-server': { type: 'helm', repoUrl: 'https://kubernetes-sigs.github.io/metrics-server/', chartName: 'metrics-server' },
  'csi-driver-smb': { type: 'helm', repoUrl: 'https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts', chartName: 'csi-driver-smb' },
  openbao: { type: 'helm', repoUrl: 'https://openbao.github.io/openbao-helm', chartName: 'openbao' },
  // n8n helm chart versions match n8n app versions; charts.n8n.io is IPv6-only so use Docker Hub
  n8n: { type: 'docker', image: 'n8nio/n8n' },
  netbird: { type: 'ghcr', owner: 'netbirdio', repo: 'netbird', packageName: 'management' },
};
