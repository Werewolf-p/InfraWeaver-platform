import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ notifications: [] });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as { title?: string; body?: string; level?: string };
  const { title, body: notifBody, level = "info" } = body;

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    notification: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body: notifBody,
      level,
      timestamp: Date.now(),
      read: false,
    },
  });
}
