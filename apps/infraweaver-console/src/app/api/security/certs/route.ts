import { NextResponse } from "next/server";
import { loadCertificates } from "@/lib/ops-data";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(["security:read", "infra:read"], async () =>
  NextResponse.json(await loadCertificates(), {
    headers: { "Cache-Control": "no-store" },
  }));
