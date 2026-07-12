import { makeIwProxyRoute } from "@/lib/iw-api";

/** GET /api/longhorn/backups — list Longhorn backup volumes via infraweaver-api */
export const { GET } = makeIwProxyRoute({
  basePath: "/longhorn/backups",
  get: { permission: "cluster:read" },
});
