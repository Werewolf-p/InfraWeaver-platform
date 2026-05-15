import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { findUserByEmail, authentikFetch } from "@/lib/authentik";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";

const UpdateNameBody = z.object({
  newName: z.string().trim().min(1).max(120),
});

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(rateLimitKey("profile-name", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = UpdateNameBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user?.pk) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ name: parsed.data.newName }),
  });
  if (!r.ok) return NextResponse.json({ error: "Update failed" }, { status: 502 });

  await auditLog("profile:change-name", session.user?.email ?? "unknown", "Updated profile display name", {
    resource: "profile",
    req,
  });

  return NextResponse.json({ ok: true });
}
