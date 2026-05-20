import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEnabledAddons } from "@/lib/addons-server";
import { safeError } from "@/lib/utils";

function getErrorMessage(error: unknown) {
  return safeError(error);
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
