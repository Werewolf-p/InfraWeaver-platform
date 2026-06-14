import { NextResponse, NextRequest } from "next/server";
import { findUserByEmail } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(null, async (_req: NextRequest, session) => {
  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);

  return NextResponse.json({
    name: user?.name ?? session.user?.name ?? "",
    email: user?.email ?? email,
    groups: user?.groups_obj?.map((g: { name: string }) => g.name) ?? [],
  });
});
