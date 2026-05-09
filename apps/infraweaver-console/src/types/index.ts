import type { ComponentType } from "react";

export interface ArgoApp {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: {
    destination: { namespace: string; server: string };
    project: string;
    source?: { repoURL?: string; path?: string; targetRevision?: string };
  };
  status: {
    health: { status: "Healthy" | "Progressing" | "Degraded" | "Suspended" | "Missing" | "Unknown" };
    sync: { status: "Synced" | "OutOfSync" | "Unknown"; revision?: string };
    conditions?: { type: string; message: string; lastTransitionTime: string }[];
    operationState?: {
      phase: string;
      startedAt: string;
      finishedAt?: string;
      message?: string;
      syncResult?: { revision?: string };
    };
    summary?: { images?: string[]; externalURLs?: string[] };
    reconciledAt?: string;
  };
}

export interface PlatformUser {
  username: string;
  name: string;
  email: string;
  access_level: string;
  wiki_role?: string;
  authentik_groups?: string[];
  argocd_role?: string;
}

export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  pushedAt: string | null;
}

export interface RegistryRepo {
  name: string;
  tags?: RegistryTag[];
  tagCount?: number;
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  nodeName?: string;
  createdAt: string;
}

export interface ClusterHealth {
  healthy: number;
  degraded: number;
  progressing: number;
  outOfSync: number;
  total: number;
  status: "healthy" | "degraded" | "progressing" | "unknown";
}

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}
