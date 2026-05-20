import type { Session } from "next-auth";
import type { ZodSchema, ZodError } from "zod";

export interface SecurityError {
  error: string;
  code: string;
}

function securityError(error: string, code: string): SecurityError {
  return { error, code };
}

/**
 * Validates input against a Zod schema.
 * Returns { success: true, data } or { success: false, error: SecurityError }
 */
export function validateInput<T>(
  schema: ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: SecurityError; status: 400 } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = (result.error as ZodError).issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return {
    success: false,
    error: securityError(`Validation failed: ${issues}`, "VALIDATION_ERROR"),
    status: 400,
  };
}

/**
 * Throws (returns a structured error object) if session is null/unauthenticated.
 */
export function requireAuth(
  session: Session | null,
): { error: SecurityError; status: 401 } | null {
  if (!session) {
    return { error: securityError("Unauthorized", "UNAUTHENTICATED"), status: 401 };
  }
  return null;
}

/**
 * Checks if session has the required permission, returns error shape if not.
 */
export function requirePermission(
  session: Session | null,
  permission: string,
  checkFn: (session: Session, permission: string) => boolean,
): { error: SecurityError; status: 401 | 403 } | null {
  if (!session) {
    return { error: securityError("Unauthorized", "UNAUTHENTICATED"), status: 401 };
  }
  if (!checkFn(session, permission)) {
    return { error: securityError(`Forbidden: requires ${permission}`, "FORBIDDEN"), status: 403 };
  }
  return null;
}

const DANGEROUS_CHARS_RE = /[<>"'`\x00-\x1F\x7F]/g;
const MAX_SANITIZE_LENGTH = 1024;

/**
 * Strips dangerous characters, trims, and limits length.
 */
export function sanitizeString(input: string, maxLength = MAX_SANITIZE_LENGTH): string {
  return input.replace(DANGEROUS_CHARS_RE, "").trim().slice(0, maxLength);
}

/** Strict regex for Kubernetes resource names (DNS subdomain, 253 chars max) */
export const K8S_NAME_RE = /^[a-z0-9][a-z0-9\-.]{0,251}[a-z0-9]$|^[a-z0-9]$/;

/** Strict regex for Kubernetes namespace names (DNS label, 63 chars max) */
export const K8S_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validates a Kubernetes resource name parameter.
 * Returns null if valid, or an error object if invalid.
 */
export function validateK8sName(
  name: string,
): { error: SecurityError; status: 400 } | null {
  if (!K8S_NAME_RE.test(name)) {
    return {
      error: securityError(
        "Invalid resource name: must match /^[a-z0-9][a-z0-9-.]{0,251}[a-z0-9]$/",
        "INVALID_K8S_NAME",
      ),
      status: 400,
    };
  }
  return null;
}

/**
 * Validates a Kubernetes namespace parameter.
 * Returns null if valid, or an error object if invalid.
 */
export function validateK8sNamespace(
  namespace: string,
): { error: SecurityError; status: 400 } | null {
  if (!K8S_NAMESPACE_RE.test(namespace)) {
    return {
      error: securityError(
        "Invalid namespace: must match /^[a-z0-9][a-z0-9-]{0,62}$/",
        "INVALID_K8S_NAMESPACE",
      ),
      status: 400,
    };
  }
  return null;
}
