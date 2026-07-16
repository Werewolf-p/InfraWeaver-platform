import { NextResponse } from "next/server";
import { withRoute } from "@/lib/route-utils";
import { getOwnedPvcsForSession } from "@/lib/self-service/owned-pvcs";

/**
 * GET — the caller's OWN expandable PVCs (from their users.yaml nas_shares).
 * Auth-only: the list is derived from the session's own identity, so it can only
 * ever reveal the caller's volumes. Feeds the storage-quota request form's target
 * dropdown so the client offers exactly what the server will accept.
 */
export const GET = withRoute(null, async (_req, session) => {
  return NextResponse.json({ pvcs: await getOwnedPvcsForSession(session) });
});
