// GET /api/nextcloud/credential[?username=] — reveal a stored Nextcloud LOCAL password.
//
// The delivery problem, solved without email (mirrors /api/jellyfin/credential)
// ------------------------------------------------------------------------------
// Nextcloud sign-in is SSO, but native/WebDAV clients (mobile sync, davfs, backup
// tooling) need a local username+password. This platform has no user-facing mail
// transport, and mailing a generated password would leave it in an inbox forever.
//
// Instead: the person granted the account is already signed in to this console
// through SSO. They can reveal their OWN Nextcloud local password here, once, whenever
// they set up a new client. No mail, no shared secret in transit, and the reveal is
// authenticated by the same identity that earned the grant.
//
// An admin (`users:write`/`rbac:admin`) may reveal someone else's, for an out-of-band
// hand-off. Every reveal is audited, including whose it was.
//
// POST /api/nextcloud/credential — reset a Nextcloud user's local password. Admin-only
// recovery: it mints a new password, sets it on the server over OCS, persists it for
// reveal, and returns it once for hand-off. Never self-service — resetting is
// privileged and disrupts existing native-client logins.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { readAppAccountCredential } from "@/lib/app-accounts/store";
import { NEXTCLOUD_APP_ID, nextcloudLaunchUrl } from "@/lib/nextcloud/config";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import {
  ProtectedNextcloudAccountError,
  resetNextcloudCredential,
  UnmanagedNextcloudAccountError,
} from "@/lib/nextcloud/access";
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
  if (!checkRateLimit(rateLimitKey("nextcloud-credential", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const requested = req.nextUrl.searchParams.get("username") ?? rbac.username;
  if (!requested || !USERNAME_RE.test(requested)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  const isSelf = requested === rbac.username;
  if (!isSelf && !hasAnySessionPermission(rbac, ["users:write", "rbac:admin"])) {
    await auditLog("nextcloud:credential:denied", actor, `Denied reveal of Nextcloud credential for '${requested}'`, { result: "failure" });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const credential = await readAppAccountCredential(NEXTCLOUD_APP_ID, requested);
    if (!credential) {
      return NextResponse.json(
        { error: `No Nextcloud local password has been stored for '${requested}' yet. Reset it first to mint and store one.` },
        { status: 404 },
      );
    }
    await auditLog(
      "nextcloud:credential:reveal",
      actor,
      isSelf ? "Revealed own Nextcloud credential" : `Revealed Nextcloud credential for '${requested}'`,
    );
    return NextResponse.json({
      username: credential.username,
      password: credential.password,
      launchUrl: nextcloudLaunchUrl(),
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
    await auditLog("nextcloud:credential:reset:denied", actor, "Denied Nextcloud credential reset", { result: "failure" });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // A reset both writes to the vault and hits Nextcloud, so keep it tighter than reveal.
  if (!checkRateLimit(rateLimitKey("nextcloud-credential-reset", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ResetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  try {
    const credential = await resetNextcloudCredential(parsed.data.username);
    await auditLog("nextcloud:credential:reset", actor, `Reset Nextcloud credential for '${credential.username}'`);
    return NextResponse.json(credential);
  } catch (error) {
    // Expected refusals (no such user, or the protected admin) are 4xx, not masked 500s.
    if (error instanceof UnmanagedNextcloudAccountError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ProtectedNextcloudAccountError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
