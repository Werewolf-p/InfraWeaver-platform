import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { canAccessLogsTarget, clampIntParam, getGameHubAccessContext } from "@/lib/logs-access";
import { isValidNamespace } from "@/lib/validate";
import { lokiQueryRange, lokiLabelValues, type LokiEntry } from "@/lib/loki";

// Loki-backed historical / aggregated log search. Complements /api/logs (single
// live pod via K8s API): this reads promtail-shipped history from Loki, so it
// covers rotated and crashed pods and searches across a whole namespace.
//
// Access model mirrors the live-logs gate (lib/logs-access): admin / cluster:read
// / infra:read see any namespace; game-hub:read (at /game-hub/) sees the game-hub
// namespace. Per-server-scoped game users are intentionally denied a
// namespace-wide search (it would leak other servers' logs) — they keep the
// per-pod live viewer. Never interpolates user text into the LogQL selector.

const HOURS_DEFAULT = 1;
const HOURS_MIN = 1;
const HOURS_MAX = 168; // 7 days
const LIMIT_DEFAULT = 500;
const LIMIT_MIN = 1;
const LIMIT_MAX = 2000;
const NAMESPACE_LABEL_WINDOW_HOURS = 24;

/** Go-quote-escape a user string so it is inert inside a LogQL `|=` filter. */
function escapeLogQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}

export const GET = withAuth(
  { permission: "apps:read", rateLimit: { name: "logs-search", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
    const { groups, username, roleAssignments } = await getGameHubAccessContext(session, 60);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const namespace = req.nextUrl.searchParams.get("namespace")?.trim() ?? "";

    // No namespace → return the namespaces this caller may search (picker source).
    if (!namespace) {
      try {
        const all = await lokiLabelValues("namespace", nowSeconds - NAMESPACE_LABEL_WINDOW_HOURS * 3600, nowSeconds);
        const allowed = all
          .filter((ns) => isValidNamespace(ns))
          .filter((ns) => canAccessLogsTarget(groups, username, roleAssignments, ns, ""));
        return NextResponse.json({ available: true, namespaces: allowed.sort() });
      } catch {
        return NextResponse.json({ available: false, namespaces: [] }, { status: 503 });
      }
    }

    if (!isValidNamespace(namespace)) {
      return NextResponse.json({ error: "Invalid namespace" }, { status: 400 });
    }
    if (!canAccessLogsTarget(groups, username, roleAssignments, namespace, "")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const hours = clampIntParam(req.nextUrl.searchParams.get("hours"), HOURS_DEFAULT, HOURS_MIN, HOURS_MAX);
    const limit = clampIntParam(req.nextUrl.searchParams.get("limit"), LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX);
    const query = (req.nextUrl.searchParams.get("q") ?? "").trim();

    // Selector uses only the validated namespace label; free text goes through an
    // escaped line filter, never the stream selector.
    let logql = `{namespace="${namespace}"}`;
    if (query) logql += ` |= "${escapeLogQLString(query)}"`;

    try {
      const streams = await lokiQueryRange(logql, {
        start: nowSeconds - hours * 3600,
        end: nowSeconds,
        limit,
        timeoutMs: 8000,
      });

      // Flatten to a single newest-first list, tagging each line with its pod.
      const rows = streams
        .flatMap((stream) =>
          stream.entries.map((entry: LokiEntry) => ({
            ts: entry.ts,
            line: entry.line,
            pod: stream.labels.pod ?? "",
            container: stream.labels.container ?? "",
          })),
        )
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
        .slice(0, limit);

      return NextResponse.json({
        available: true,
        namespace,
        hours,
        query,
        count: rows.length,
        truncated: rows.length >= limit,
        rows,
      });
    } catch {
      return NextResponse.json({ available: false, error: "Loki is unreachable" }, { status: 503 });
    }
  },
);
