import { makeIwProxyRoute } from "@/lib/iw-api";

export const { GET } = makeIwProxyRoute({
  basePath: "/cluster/pdbs",
  get: { permission: "cluster:read" },
});
