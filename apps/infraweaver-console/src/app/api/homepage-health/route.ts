import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getHomepageServiceHealthMap } from "@/lib/homepage-health";
import { safeError } from "@/lib/utils";

function getErrorMessage(error: unknown) {
  return safeError(error);
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await getHomepageServiceHealthMap());
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 503 });
  }
}
