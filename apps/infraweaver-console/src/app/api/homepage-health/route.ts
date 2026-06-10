import { NextResponse } from "next/server";
import { getHomepageServiceHealthMap } from "@/lib/homepage-health";
import { safeError } from "@/lib/utils";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(null, async () => {
  try {
    return NextResponse.json(await getHomepageServiceHealthMap());
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 503 });
  }
});
