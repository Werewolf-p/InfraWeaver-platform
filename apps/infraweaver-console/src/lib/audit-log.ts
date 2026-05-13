export interface AuditLogEntry {
  timestamp: string;
  action: string;
  user: string;
  detail: string;
  result: "success" | "failure";
  resource?: string;
  ip?: string;
}

function requestIp(req?: Pick<Request, "headers">) {
  if (!req) return undefined;
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

async function writeAuditEntry(entry: AuditLogEntry): Promise<void> {
  console.log(JSON.stringify({ type: "audit", ...entry }));
}

export async function auditLog(
  action: string,
  user: string,
  detail: string,
  options: Omit<Partial<AuditLogEntry>, "timestamp" | "action" | "user" | "detail"> = {},
): Promise<void> {
  await writeAuditEntry({
    timestamp: new Date().toISOString(),
    action,
    user,
    detail,
    result: options.result ?? "success",
    resource: options.resource,
    ip: options.ip,
  });
}

export async function auditAuthFailure(detail: string, req?: Pick<Request, "headers">, user = "unknown") {
  await auditLog("auth:failed", user, detail, { result: "failure", resource: "auth", ip: requestIp(req) });
}

export async function auditUnauthorizedAccess(
  action: string,
  req?: Pick<Request, "headers">,
  user = "unknown",
  detail = "Unauthorized access attempt",
) {
  await auditLog(action, user, detail, { result: "failure", resource: "security", ip: requestIp(req) });
}
