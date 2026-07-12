import { makeIwProxyRoute } from "@/lib/iw-api";

export const { GET } = makeIwProxyRoute({
  basePath: "/k8s/nodes",
  get: { permission: "cluster:read" },
});
