// GET /api/jellyfin/credential[?username=] — reveal a provisioned Jellyfin password.
//
// The delivery problem, solved without email
// ------------------------------------------
// Jellyfin native/TV clients need a local username+password, and this platform
// has no mail transport (Authentik's SMTP only sends Authentik's own templates).
// Mailing a generated password would also leave it in an inbox forever.
//
// Instead: the person who was granted Jellyfin is already signed in to this
// console through SSO. They can reveal their OWN password here, once, whenever
// they set up a new client. No mail, no shared secret in transit, and the reveal
// is authenticated by the same identity that earned the grant.
//
// An admin (`users:write`/`rbac:admin`) may reveal someone else's, for an
// out-of-band hand-off. Every reveal is audited, including whose it was.
//
// POST /api/jellyfin/credential — reset a managed account's password. This is the
// admin-only escape hatch for an ADOPTED account, whose original password was lost
// in the orphan window and so cannot be revealed, and the general password-reset
// recovery. It mints a new password, sets it on the server, and returns it once for
// hand-off. Never self-service: resetting is privileged and disrupts existing logins.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { readAppAccountCredential } from "@/lib/app-accounts/store";
import { JELLYFIN_APP_ID, jellyfinLaunchUrl } from "@/lib/jellyfin/config";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { resetJellyfinCredential, UnmanagedJellyfinAccountError } from "@/lib/jellyfin/access";
import { safeError } from "@/lib/utils";

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

const ResetSchema = z.object({ username: z.string().regex(USERNAME_RE) }).strict();

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  const actor = session.user?.email ?? rbac.username ?? "unknown";

  // Revealing a password is cheap to automate and expensive to leak; keep the
  // rate limit tight enough that a stolen console session cannot harvest every
  // account's credential in one pass.
  if (!checkRateLimit(rateLimitKey("jellyfin-credential", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const requested = req.nextUrl.searchParams.get("username") ?? rbac.username;
  if (!requested || !USERNAME_RE.test(requested)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  const isSelf = requested === rbac.username;
  if (!isSelf && !hasAnySessionPermission(rbac, ["users:write", "rbac:admin"])) {
    await auditLog("jellyfin:credential:denied", actor, `Denied reveal of Jellyfin credential for '${requested}'`, { result: "failure" });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const credential = await readAppAccountCredential(JELLYFIN_APP_ID, requested);
    if (!credential) {
      return NextResponse.json(
        { error: `No Jellyfin account has been provisioned for '${requested}' yet. Grant them Jellyfin access first.` },
        { status: 404 },
      );
    }
    await auditLog(
      "jellyfin:credential:reveal",
      actor,
      isSelf ? "Revealed own Jellyfin credential" : `Revealed Jellyfin credential for '${requested}'`,
    );
    return NextResponse.json({
      username: credential.username,
      password: credential.password,
      launchUrl: jellyfinLaunchUrl(),
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  const actor = session.user?.email ?? rbac.username ?? "unknown";

  // Resetting someone's password is strictly an admin recovery act — never self-serve.
  if (!hasAnySessionPermission(rbac, ["users:write", "rbac:admin"])) {
    await auditLog("jellyfin:credential:reset:denied", actor, "Denied Jellyfin credential reset", { result: "failure" });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // A reset both writes to the vault and hits Jellyfin, so keep it tighter than reveal.
  if (!checkRateLimit(rateLimitKey("jellyfin-credential-reset", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ResetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  try {
    const credential = await resetJellyfinCredential(parsed.data.username);
    await auditLog("jellyfin:credential:reset", actor, `Reset Jellyfin credential for '${credential.username}'`);
    return NextResponse.json(credential);
  } catch (error) {
    // An expected refusal (no such managed account) is a 404, not a masked 500.
    if (error instanceof UnmanagedJellyfinAccountError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
