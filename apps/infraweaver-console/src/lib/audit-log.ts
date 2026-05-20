export interface AuditLogEntry {
  timestamp: string;
  action: string;
  user: string;
  detail: string;
  result: "success" | "failure";
  resource?: string;
  ip?: string;
  userAgent?: string;
}

interface AuditLogOptions extends Omit<Partial<AuditLogEntry>, "timestamp" | "action" | "user" | "detail"> {
  req?: Pick<Request, "headers">;
}

const SENSITIVE_AUDIT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization\s*:\s*bearer)\s+[^\s]+/gi, "$1 [redacted]"],
  [/\b((?:api[-_ ]?key|token|password|secret|client[-_ ]?secret|refresh[-_ ]?token|access[-_ ]?token|unseal[-_ ]?key)\b\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]"],
  [/("(?:apiKey|api_key|token|password|secret|clientSecret|refreshToken|accessToken|key)"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, "[redacted-jwt]"],
];

function sanitizeAuditText(value: string | undefined, maxLength: number) {
  if (!value) return undefined;

  let sanitized = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  for (const [pattern, replacement] of SENSITIVE_AUDIT_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  if (!sanitized) return undefined;
  return sanitized.slice(0, maxLength);
}

export function redactAuditDetail(detail: string) {
  return sanitizeAuditText(detail, 4096) ?? "";
}

function requestIp(req?: Pick<Request, "headers">) {
  if (!req) return undefined;
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

function requestUserAgent(req?: Pick<Request, "headers">) {
  return sanitizeAuditText(req?.headers.get("user-agent") ?? undefined, 512);
}

async function writeAuditEntry(entry: AuditLogEntry): Promise<void> {
  console.log(JSON.stringify({ type: "audit", ...entry }));
}

export async function auditLog(
  action: string,
  user: string,
  detail: string,
  options: AuditLogOptions = {},
): Promise<void> {
  await writeAuditEntry({
    timestamp: new Date().toISOString(),
    action: sanitizeAuditText(action, 128) ?? "unknown",
    user: sanitizeAuditText(user, 256) ?? "unknown",
    detail: redactAuditDetail(detail),
    result: options.result ?? "success",
    resource: sanitizeAuditText(options.resource, 256),
    ip: sanitizeAuditText(options.ip ?? requestIp(options.req), 128),
    userAgent: sanitizeAuditText(options.userAgent ?? requestUserAgent(options.req), 512),
  });
}

export async function auditAuthFailure(detail: string, req?: Pick<Request, "headers">, user = "unknown") {
  await auditLog("auth:failed", user, detail, { result: "failure", resource: "auth", req });
}

export async function auditUnauthorizedAccess(
  action: string,
  req?: Pick<Request, "headers">,
  user = "unknown",
  detail = "Unauthorized access attempt",
) {
  await auditLog(action, user, detail, { result: "failure", resource: "security", req });
}
