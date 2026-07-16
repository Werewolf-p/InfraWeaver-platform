// ─────────────────────────────────────────────────────────────────────────────
// security/types.ts — shared security-domain types, consolidating the per-file
// redeclarations in:
//   KyvernoViolation — app/api/security/kyverno/route.ts + app/(dashboard)/security/page.tsx
//   AuditEntry       — app/api/security/audit-log/route.ts + hooks/use-audit-log.ts
//   PodSpec          — app/api/security/enhanced/route.ts
// Pure types only — safe to import from both server routes and client code.
// ─────────────────────────────────────────────────────────────────────────────

export interface KyvernoViolation {
  policy: string;
  namespace: string;
  resource: string;
  kind: string;
  severity: string;
  message: string;
  category: string;
  /** Failing rule name when the PolicyReport provides it (used by /api/security/enhanced). */
  rule?: string;
}

export interface AuditEntry {
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  details: string;
  result: "success" | "failure";
  ip?: string;
  userAgent?: string;
  // Optional enrichment from the durable audit store (Subject 3). All optional
  // so existing readers/writers stay source- and wire-compatible.
  category?: string;
  severity?: string;
  target?: string;
  seq?: number;
}

/** Minimal pod shape the security analyses read (structural subset of V1Pod). */
export interface PodSpec {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    containers?: Array<{
      name?: string;
      image?: string;
      resources?: { limits?: Record<string, string> };
      securityContext?: {
        privileged?: boolean;
        runAsNonRoot?: boolean;
        runAsUser?: number;
        allowPrivilegeEscalation?: boolean;
        readOnlyRootFilesystem?: boolean;
        seccompProfile?: { type?: string };
      };
      volumeMounts?: Array<{ name?: string }>;
    }>;
    initContainers?: Array<{ name?: string; securityContext?: { privileged?: boolean } }>;
    securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; seccompProfile?: { type?: string } };
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostIPC?: boolean;
    volumes?: Array<{ name?: string; hostPath?: { path?: string } }>;
    serviceAccountName?: string;
    nodeName?: string;
  };
  status?: { phase?: string };
}
