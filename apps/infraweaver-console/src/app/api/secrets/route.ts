import { z } from "zod";
import { makeIwProxyRoute } from "@/lib/iw-api";

const namespaceSchema = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const resourceNameSchema = z.string().min(1).max(253).regex(/^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/);
const secretDeleteSchema = z.object({
  namespace: namespaceSchema,
  name: resourceNameSchema,
}).strict();

export const { GET, DELETE } = makeIwProxyRoute({
  basePath: "/secrets",
  get: { permission: "security:read", queryParams: ["namespace"] },
  delete: {
    permission: "security:write",
    schema: secretDeleteSchema,
    toPath: (b) => `/secrets/${encodeURIComponent(b.namespace)}/${encodeURIComponent(b.name)}`,
  },
});
