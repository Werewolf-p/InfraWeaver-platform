import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createExternalRoute, loadExternalRoutes } from "@/lib/external-routes-server";
import type { ExternalRouteMutationInput } from "@/lib/external-routes";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const routeSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  host: z.string().min(1).max(253),
  accessTier: z.enum(["vpn", "internal", "public"]),
  targetType: z.enum(["k8s", "baremetal"]),
  targetService: z.string().max(128).optional(),
  targetNamespace: z.string().max(128).optional(),
  targetPort: z.coerce.number().int().min(1).max(65535),
  targetIP: z.string().max(128).optional(),
  enableAuth: z.boolean().optional(),
  tlsSecret: z.string().max(128).nullable().optional(),
  scheme: z.enum(["http", "https"]).optional(),
  skipTlsVerify: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.targetType === "k8s") {
    if (!value.targetService?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetService"], message: "Target service is required" });
    }
    if (!value.targetNamespace?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetNamespace"], message: "Target namespace is required" });
    }
  }
  if (value.targetType === "baremetal" && !value.targetIP?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetIP"], message: "Target IP is required for bare-metal routes" });
  }
});

async function requireWriteAccess() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["infra:write"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return session;
}

function normalizePayload(input: z.infer<typeof routeSchema>): ExternalRouteMutationInput {
  return {
    name: input.name.trim().toLowerCase(),
    host: input.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""),
    accessTier: input.accessTier,
    targetType: input.targetType,
    targetService: input.targetService?.trim(),
    targetNamespace: input.targetNamespace?.trim(),
    targetPort: input.targetPort,
    targetIP: input.targetIP?.trim(),
    enableAuth: Boolean(input.enableAuth),
    tlsSecret: input.tlsSecret?.trim() || null,
    scheme: input.scheme ?? "http",
    skipTlsVerify: Boolean(input.skipTlsVerify),
  };
}

export async function GET() {
  const session = await requireWriteAccess();
  if (session instanceof NextResponse) return session;

  try {
    return NextResponse.json(await loadExternalRoutes(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await requireWriteAccess();
  if (session instanceof NextResponse) return session;

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = routeSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }

    const payload = normalizePayload(parsed.data);
    return NextResponse.json(await createExternalRoute(payload));
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
