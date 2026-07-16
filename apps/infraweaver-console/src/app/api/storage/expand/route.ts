import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRoutePermissions, requireSingleCluster } from "@/lib/route-utils";
import { expandPvc, PVC_SIZE_RE } from "@/lib/storage/expand-pvc";
import { safeError } from "@/lib/utils";

const expandSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  newSize: z.string().min(2).max(32).regex(PVC_SIZE_RE),
});

export async function PATCH(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const parsed = expandSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name, newSize } = parsed.data;
  const cluster = requireSingleCluster(request);
  if (cluster instanceof NextResponse) return cluster;

  try {
    const pvc = await expandPvc({ clusterId: cluster.clusterId, namespace, name, newSize });
    return NextResponse.json({ ok: true, pvc });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: safeError(error),
      },
      { status: 502 },
    );
  }
}
