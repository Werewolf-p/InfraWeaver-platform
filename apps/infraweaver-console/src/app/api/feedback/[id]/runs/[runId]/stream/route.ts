import { NextRequest } from "next/server";
import { apiError } from "@/lib/route-utils";
import { openFeedbackRunStream } from "@/lib/feedback-dispatch";
import { requireFeedbackManager } from "@/lib/feedback-host";

// The proxied stream stays open for the life of the run — never cache/prerender.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/feedback/:id/runs/:runId/stream — pipe the dispatch SSE (live log +
// phase events) through to the browser. EventSource authenticates via the
// same-origin session cookie; the dispatch service stays runner-internal.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await requireFeedbackManager(request, "Run streams are only available on the canonical console host");
  if (session instanceof Response) return session;

  const { runId } = await params;
  const upstream = await openFeedbackRunStream(runId);
  if (!upstream || !upstream.body) {
    return apiError("Run stream unavailable", { status: 502 });
  }

  // Abort the upstream fetch when the browser disconnects so we don't leak it.
  request.signal.addEventListener("abort", () => {
    upstream.body?.cancel().catch(() => {});
  });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy/Next buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
