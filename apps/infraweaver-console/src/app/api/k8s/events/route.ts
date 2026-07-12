import { makeIwProxyRoute } from "@/lib/iw-api";

export const { GET } = makeIwProxyRoute({
  basePath: "/k8s/events",
  get: { permission: "cluster:read", queryParams: ["namespace", "name", "limit"] },
});
