import { EventEmitter } from "node:events";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { validateK8sName } from "@/lib/api-security";

const viewersByServer = new Map<string, Set<string>>();
const presenceEmitter = new EventEmitter();
presenceEmitter.setMaxListeners(0);

type PresencePayload = {
  viewers: Array<{ name: string; initial: string }>;
};

function parseViewer(sessionId: string) {
  const [encodedName = "viewer"] = sessionId.split("::");
  const name = decodeURIComponent(encodedName || "viewer").trim() || "viewer";
  return {
    name,
    initial: (name[0] ?? "?").toUpperCase(),
  };
}

function buildPayload(serverName: string): PresencePayload {
  return {
    viewers: Array.from(viewersByServer.get(serverName) ?? []).map(parseViewer),
  };
}

function broadcast(serverName: string) {
  presenceEmitter.emit(serverName, buildPayload(serverName));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const fallbackName = session.user?.name ?? session.user?.email ?? "viewer";
  const sessionId =
    req.nextUrl.searchParams.get("sessionId")?.trim() ||
    `${encodeURIComponent(fallbackName)}::${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

  const set = viewersByServer.get(name) ?? new Set<string>();
  set.add(sessionId);
  viewersByServer.set(name, set);

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const emit = (payload: PresencePayload) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        const onBroadcast = (payload: PresencePayload) => {
          try {
            emit(payload);
          } catch {
            cleanup();
          }
        };

        const heartbeat = globalThis.setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
        }, 25_000);

        function cleanup() {
          if (closed) return;
          closed = true;
          globalThis.clearInterval(heartbeat);
          presenceEmitter.off(name, onBroadcast);
          req.signal.removeEventListener("abort", cleanup);

          const current = viewersByServer.get(name);
          if (current) {
            current.delete(sessionId);
            if (current.size === 0) viewersByServer.delete(name);
          }
          broadcast(name);

          try {
            controller.close();
          } catch {
            // ignore close race
          }
        }

        presenceEmitter.on(name, onBroadcast);
        req.signal.addEventListener("abort", cleanup, { once: true });
        emit(buildPayload(name));
        broadcast(name);
      },
      cancel() {
        const current = viewersByServer.get(name);
        if (!current) return;
        current.delete(sessionId);
        if (current.size === 0) viewersByServer.delete(name);
        broadcast(name);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
