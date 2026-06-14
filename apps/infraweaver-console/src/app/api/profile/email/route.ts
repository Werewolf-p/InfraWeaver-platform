import { NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { findUserByEmail, authentikFetch } from "@/lib/authentik";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import { withRoute } from "@/lib/route-utils";

const UpdateEmailBody = z.object({
  newEmail: z.string().trim().email().max(254),
});

export const PATCH = withRoute(null, async (req: NextRequest, session) => {
  if (!checkRateLimit(rateLimitKey("profile-email", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = UpdateEmailBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user?.pk) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ email: parsed.data.newEmail }),
  });
  if (!r.ok) return NextResponse.json({ error: "Update failed" }, { status: 502 });

  await auditLog("profile:change-email", session.user?.email ?? "unknown", `Updated profile email to ${parsed.data.newEmail}`, {
    resource: "profile",
    req,
  });

  return NextResponse.json({ ok: true });
});
