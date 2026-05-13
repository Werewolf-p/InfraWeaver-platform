import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEnabledAddons } from "@/lib/addons";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to load addons";
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await getEnabledAddons());
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
