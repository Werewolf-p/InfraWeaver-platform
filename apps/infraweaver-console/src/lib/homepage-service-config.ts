export type HomepageServiceHealthState = "healthy" | "degraded" | "offline";

export interface HomepageServiceHealth {
  name: string;
  status: HomepageServiceHealthState;
  reason?: string;
  appName?: string;
}

export const HOMEPAGE_SERVICE_APP_MAP: Record<string, string> = {
  ArgoCD: "core-argocd",
  Traefik: "core-traefik",
  Longhorn: "core-longhorn",
  OpenBao: "core-openbao",
  Grafana: "platform-grafana",
  Prometheus: "monitoring-kube-prometheus-stack",
  Authentik: "platform-authentik",
  "NetBird VPN": "apps-netbird",
  InfraWeaver: "catalog-infraweaver-console-manifests",
  "Wiki.js": "catalog-wiki-manifests",
  Gatus: "catalog-gatus-manifests",
  OneDev: "catalog-onedev-manifests",
  "Stirling PDF": "catalog-stirling-pdf-manifests",
  "Container Registry": "catalog-registry-manifests",
  "rlservers.com": "external-routes",
  degoudentijd: "external-routes",
  feestinhetdonker: "external-routes",
  "yonavaarwater.nl": "external-routes",
  "zonnevaarwater.nl": "external-routes",
};
