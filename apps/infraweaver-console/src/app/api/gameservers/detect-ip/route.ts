import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const { ip } = await res.json() as { ip: string };
    return NextResponse.json({ ip });
  } catch {
    return NextResponse.json({ error: "Failed to detect IP" }, { status: 500 });
  }
}
