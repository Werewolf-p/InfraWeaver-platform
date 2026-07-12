import { makeIwProxyRoute } from "@/lib/iw-api";

export const { GET } = makeIwProxyRoute({
  basePath: "/cluster/quotas",
  get: { permission: "cluster:read" },
});
