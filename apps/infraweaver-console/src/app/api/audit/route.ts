import { NextResponse } from "next/server";
import { queryAudit } from "@/lib/audit/store";
import type { AuditQuery, AuditRecord } from "@/lib/audit/types";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const CATEGORY = z.enum(["user", "rbac", "secret", "cluster", "gitops", "auth", "app", "other"]);
const SEVERITY = z.enum(["info", "notice", "warning", "critical"]);
const RESULT = z.enum(["success", "failure"]);

const QuerySchema = z.object({
  user: z.string().trim().max(256).optional(),
  action: z.string().trim().max(128).optional(),
  category: CATEGORY.optional(),
  severity: SEVERITY.optional(),
  result: RESULT.optional(),
  resource: z.string().trim().max(256).optional(),
  target: z.string().trim().max(256).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  q: z.string().trim().max(256).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

const CSV_MAX_ROWS = 500;

function csvCell(value: string | number | undefined): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function toCsv(entries: AuditRecord[]): string {
  const header = ["Seq", "Timestamp", "Severity", "Category", "User", "Action", "Result", "Resource", "Target", "Detail", "IP"];
  const rows = entries.map((entry) =>
    [
      entry.seq,
      entry.timestamp,
      entry.severity,
      entry.category,
      entry.user,
      entry.action,
      entry.result,
      entry.resource,
      entry.target,
      entry.detail,
      entry.ip,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export const GET = withRoute("security:read", async (req) => {
  if (!checkRateLimit(rateLimitKey("audit-query", req), 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const { format, ...rest } = parsed.data;
  const query: AuditQuery = rest;

  try {
    if (format === "csv") {
      const page = await queryAudit({ ...query, cursor: undefined, limit: CSV_MAX_ROWS });
      return new NextResponse(toCsv(page.entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const page = await queryAudit(query);
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
