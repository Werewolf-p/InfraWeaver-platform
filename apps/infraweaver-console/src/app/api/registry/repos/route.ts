import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { getRegistryConfig, listRepositories } from "@/lib/registry";

export const GET = withAuth({ permission: "config:read" }, async () => {
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
});
