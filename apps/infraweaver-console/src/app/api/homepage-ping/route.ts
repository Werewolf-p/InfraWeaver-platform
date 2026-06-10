import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getHomepageServiceHealthMap } from "@/lib/homepage-health";
import { parseAllowedInternalUrl } from "@/lib/internal-url-allowlist";
import { safeError } from "@/lib/utils";
import { INTERNAL_DOMAIN } from "@/lib/domain";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (url) {
    const allowedUrl = parseAllowedInternalUrl(url);
    if (!allowedUrl) {
      return NextResponse.json({ error: `Only *.${INTERNAL_DOMAIN} and approved internal service URLs are allowed` }, { status: 400 });
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(allowedUrl, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      return NextResponse.json({
        url: allowedUrl.toString(),
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 502 });
    }
  }

  const requestedServices = (req.nextUrl.searchParams.get("services") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const healthMap = await getHomepageServiceHealthMap();
  const selectedServices = requestedServices.length > 0
    ? requestedServices.filter((name) => Boolean(healthMap[name]))
    : Object.keys(healthMap);

  return NextResponse.json({
    results: Object.fromEntries(selectedServices.map((name) => [name, healthMap[name]])),
  });
}
