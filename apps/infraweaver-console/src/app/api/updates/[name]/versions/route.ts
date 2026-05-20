import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { fetchHelmVersions, getArgoApplication, getHelmSource } from "@/lib/update-manager";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("updates-versions", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  const app = await getArgoApplication(name);
  if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  const helmSource = getHelmSource(app);
  if (!helmSource?.chart || !helmSource.repoURL) {
    return NextResponse.json({ error: "App is not backed by a Helm chart source" }, { status: 404 });
  }

  try {
    const versions = await fetchHelmVersions(helmSource.repoURL, helmSource.chart);
    return NextResponse.json({
      versions,
      source: "helm",
      note: `${versions.length} versions found in ${helmSource.repoURL}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ versions: [], source: "unknown", note: msg });
  }
}
