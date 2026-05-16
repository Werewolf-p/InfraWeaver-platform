import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      message?: string;
      stack?: string;
      url?: string;
      userId?: string;
      requestId?: string;
    };
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "client_error",
        message: body.message ?? "Unknown error",
        stack: body.stack ?? null,
        url: body.url ?? null,
        userId: body.userId ?? null,
        requestId: body.requestId ?? null,
      }) + "\n",
    );
  } catch {
    // Swallow parse errors — we must always return 200 to the client
  }
  return NextResponse.json({ ok: true });
}
