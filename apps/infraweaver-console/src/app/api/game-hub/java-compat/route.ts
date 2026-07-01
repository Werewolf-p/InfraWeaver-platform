import { NextResponse } from "next/server";
import { requiredJavaForMinecraftVersion } from "@/addons/gamehub/lib/minecraft-java-compat";
import { withAuth } from "@/lib/with-auth";

// GET /api/game-hub/java-compat?version=1.21.4
// Returns the minimum Java major version a Minecraft version needs, so the
// create wizard can filter/disable incompatible runtime images. requiredJava is
// null for dynamic ("latest") or unknown versions (no client-side constraint).
export const GET = withAuth({ permission: "game-hub:read", scope: "/game-hub/" }, async ({ req }) => {
  const version = new URL(req.url).searchParams.get("version")?.trim() ?? "";
  if (!version) {
    return NextResponse.json({ error: "version query param required" }, { status: 400 });
  }
  const requiredJava = await requiredJavaForMinecraftVersion(version);
  return NextResponse.json({ version, requiredJava });
});
