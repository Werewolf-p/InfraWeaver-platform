// Pure derivation of category / severity / target from an audit action string.
// Instrumented once inside writeAuditEntry so all 108 auditLog() sites gain
// severity + category with zero per-site changes. Unit-tested in isolation.

import type { AuditCategory, AuditResult, AuditSeverity } from "./types";

const MAX_TARGET_LENGTH = 256;

// First-segment (or any-segment) keyword → category. Longest/first meaningful
// match wins; unknowns fall through to "other".
const CATEGORY_BY_KEYWORD: Record<string, AuditCategory> = {
  rbac: "rbac",
  user: "user",
  users: "user",
  invite: "user",
  offboard: "user",
  roster: "user",
  secret: "secret",
  secrets: "secret",
  credential: "secret",
  cert: "secret",
  certs: "secret",
  openbao: "secret",
  vault: "secret",
  cluster: "cluster",
  pod: "cluster",
  pods: "cluster",
  node: "cluster",
  nodes: "cluster",
  namespace: "cluster",
  cronjob: "cluster",
  backup: "cluster",
  drain: "cluster",
  scale: "cluster",
  argocd: "gitops",
  gitops: "gitops",
  git: "gitops",
  auth: "auth",
  app: "app",
  apps: "app",
  jellyfin: "app",
  nextcloud: "app",
  wordpress: "app",
  game: "app",
  nas: "app",
};

// Destructive / high-blast-radius verbs — any presence forces "critical".
const CRITICAL_KEYWORDS = [
  "delete",
  "offboard",
  "deprovision",
  "reveal",
  "destroy",
  "drain",
  "revoke",
  "rollback",
  "purge",
  "remove",
  "uninstall",
  "wipe",
  "reset-password",
];

// Warning signals — failed / denied outcomes.
const WARNING_KEYWORDS = ["denied", "failed", "failure", "unauthorized", "forbidden", "reject"];

// Meaningful-but-routine mutations → "notice".
const NOTICE_KEYWORDS = [
  "create",
  "assign",
  "grant",
  "scale",
  "restart",
  "sync",
  "renew",
  "update",
  "invite",
  "enroll",
  "elevate",
  "activate",
  "cordon",
  "reset",
];

function tokenize(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when the normalized action contains any of the keywords as a substring. */
function actionHasKeyword(normalized: string, keywords: string[]): boolean {
  return keywords.some((keyword) => normalized.includes(keyword));
}

// When an action names both an app and a security concern (e.g.
// "jellyfin:credential:reveal"), the more security-relevant category wins.
const CATEGORY_PRIORITY: AuditCategory[] = ["secret", "rbac", "auth", "user", "gitops", "cluster", "app", "other"];

/** Map an action string to its domain category (highest-priority match wins). */
export function deriveCategory(action: string): AuditCategory {
  const present = new Set<AuditCategory>();
  for (const token of tokenize(action)) {
    const match = CATEGORY_BY_KEYWORD[token];
    if (match) present.add(match);
  }
  if (action.toLowerCase().includes("credential")) present.add("secret");
  return CATEGORY_PRIORITY.find((category) => present.has(category)) ?? "other";
}

/**
 * Rank severity from the action verbs and the result. Priority:
 *   critical verb → warning (failed/denied/failure result) → notice → info.
 */
export function deriveSeverity(action: string, result: AuditResult): AuditSeverity {
  const normalized = action.toLowerCase();

  if (actionHasKeyword(normalized, CRITICAL_KEYWORDS)) return "critical";
  if (result === "failure" || actionHasKeyword(normalized, WARNING_KEYWORDS)) return "warning";
  if (actionHasKeyword(normalized, NOTICE_KEYWORDS)) return "notice";
  return "info";
}

const TARGET_DETAIL_RE =
  /\b(?:target|subject|username|user|name|namespace|pod|app|resource|account)\s*[:=]\s*"?([A-Za-z0-9._@/-]+)"?/i;

/**
 * Best-effort resolution of the concrete object an action targeted. Prefers the
 * explicit `resource`; otherwise extracts a `key: value` / `key=value` pair from
 * the detail text.
 */
export function deriveTarget(resource?: string, detail?: string): string | undefined {
  if (resource && resource.trim()) return resource.trim().slice(0, MAX_TARGET_LENGTH);
  if (!detail) return undefined;
  const match = detail.match(TARGET_DETAIL_RE);
  return match ? match[1].slice(0, MAX_TARGET_LENGTH) : undefined;
}
