import type { AccessTier } from "@/lib/access-tier";

/** A Traefik IngressRoute as returned by GET /api/ingress. */
export interface IngressRoute {
  id: string;
  namespace: string;
  name: string;
  entryPoints: string[];
  hosts: string[];
  services: string[];
  middlewares: string[];
  authMiddlewares: string[];
  accessTier: AccessTier;
  tlsSecretName: string | null;
  certResolver: string | null;
  hasTls: boolean;
}

/** Response shape of GET /api/ingress. */
export interface IngressResponse {
  ingressRoutes: IngressRoute[];
  live: boolean;
  summary: { total: number; authProtected: number; tlsEnabled: number; hosts: number };
}
