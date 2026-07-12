import { NextResponse } from "next/server";
import { listLonghornVolumes } from "@/lib/longhorn";
import { unavailableResponse } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const volumes = await listLonghornVolumes();
    return NextResponse.json(
      volumes.map((v) => ({
        name: v.name,
        size: parseInt((v.size as string) ?? "0"),
        actualSize: parseInt((v.actualSize as string) ?? "0"),
        robustness: v.robustness,
        numberOfReplicas: v.numberOfReplicas,
        state: v.state,
        kubernetesStatus: v.kubernetesStatus,
        live: true,
      }))
    );
  } catch (error) {
    // FAIL CLOSED: no mock volumes when the Longhorn API is unreachable.
    return unavailableResponse(error);
  }
});
