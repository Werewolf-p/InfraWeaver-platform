import "server-only";

/**
 * Guard for HIGH-RISK secret remediations (re-mint ESO token, re-seed key).
 *
 * These write to OpenBao / Kubernetes secrets, so they ship DISABLED and must be
 * enabled deliberately per environment. Off (unset / not "true") ⇒ the route
 * returns 501, so the visibility features ship safe. Fail closed: any value
 * other than exactly "true" (case-insensitive, trimmed) keeps them off.
 */

export const REMEDIATION_WRITE_FLAG = "SECRET_REMEDIATION_WRITE_ENABLED";

export function isRemediationWriteEnabled(): boolean {
  return (process.env[REMEDIATION_WRITE_FLAG] ?? "").trim().toLowerCase() === "true";
}
