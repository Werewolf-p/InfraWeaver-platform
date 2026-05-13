import { NextRequest, NextResponse } from "next/server";
import { getHomepageServiceHealthMap } from "@/lib/homepage-health";

export async function GET(req: NextRequest) {
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
