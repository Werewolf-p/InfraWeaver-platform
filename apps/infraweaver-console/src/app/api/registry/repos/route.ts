import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { getRegistryConfig, listRepositories } from "@/lib/registry";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = getRegistryConfig();
  if (!cfg.configured) {
    return NextResponse.json(
      { repositories: [], registryHost: cfg.registryHost, error: "Registry not configured" },
      { status: 200 },
    );
  }

  try {
    const repositories = await listRepositories(cfg);
    return NextResponse.json({ repositories, registryHost: cfg.registryHost, projectPath: cfg.projectPath });
  } catch {
    return NextResponse.json(
      { repositories: [], registryHost: cfg.registryHost, error: "Registry unavailable" },
      { status: 503 },
    );
  }
}
