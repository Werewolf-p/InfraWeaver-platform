import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { BUILT_IN_EGGS } from "@/lib/game-eggs";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const games = BUILT_IN_EGGS.map((egg) => ({
    id: egg.id,
    gameId: egg.id,
    name: egg.name,
    description: egg.description,
    dockerImage: egg.dockerImage,
    gamePort: egg.gamePort,
    queryPort: egg.queryPort,
    protocol: egg.protocol ?? "TCP",
    supportsModrinth: egg.supportsModrinth ?? false,
  }));

  return NextResponse.json({ games });
}
