import { NextResponse } from "next/server";
import { listMinecraftReleaseVersions } from "@/addons/gamehub/lib/minecraft-java-compat";
import { withAuth } from "@/lib/with-auth";

// GET /api/game-hub/minecraft-versions
// Returns the list of Minecraft *release* versions (newest first) plus the
// current latest release, so the create wizard can make the user pick a concrete
// version up front and constrain the runtime image to a compatible Java.
export const GET = withAuth({ permission: "game-hub:read", scope: "/game-hub/" }, async () => {
  const { versions, latestRelease } = await listMinecraftReleaseVersions();
  return NextResponse.json({ versions, latestRelease });
});
