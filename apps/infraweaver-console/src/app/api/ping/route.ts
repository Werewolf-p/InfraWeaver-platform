import { NextResponse } from "next/server";

// Unauthenticated health check for external monitoring (Gatus, uptime checkers).
// Does NOT require a session — excluded from auth middleware.
export async function GET() {
  return NextResponse.json({ status: "ok", service: "infraweaver-console" });
}
