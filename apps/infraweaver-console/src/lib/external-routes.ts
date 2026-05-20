import type { AccessTier } from "@/lib/access-tier";

export type ExternalRouteTargetType = "k8s" | "baremetal";

export interface ExternalRouteItem {
  id: string;
  name: string;
  namespace: string;
  hosts: string[];
  middlewares: string[];
  accessTier: AccessTier;
  services: string[];
  tlsSecretName: string | null;
  certResolver: string | null;
  hasTls: boolean;
  entryPoints: string[];
  enableAuth: boolean;
  file: string;
  targetType: ExternalRouteTargetType;
  targetService: string;
  targetNamespace: string;
  targetPort: number;
  targetIP: string | null;
  scheme: "http" | "https";
  skipTlsVerify: boolean;
  backendServiceName: string;
  hasNetbirdFallback: boolean;
}

export interface ExternalRoutesResponse {
  routes: ExternalRouteItem[];
  files: string[];
}

export interface ExternalRouteMutationInput {
  name: string;
  host: string;
  accessTier: AccessTier;
  targetType: ExternalRouteTargetType;
  targetService?: string;
  targetNamespace?: string;
  targetPort: number;
  targetIP?: string;
  enableAuth?: boolean;
  tlsSecret?: string | null;
  scheme?: "http" | "https";
  skipTlsVerify?: boolean;
}
