import { z } from "zod";
import { makeIwProxyRoute } from "@/lib/iw-api";

const namespaceSchema = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const resourceNameSchema = z.string().min(1).max(253).regex(/^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/);
const configMapPatchSchema = z.object({
  namespace: namespaceSchema,
  name: resourceNameSchema,
  data: z.record(z.string(), z.string()),
}).strict();
const configMapDeleteSchema = z.object({
  namespace: namespaceSchema,
  name: resourceNameSchema,
}).strict();

export const { GET, PATCH, DELETE } = makeIwProxyRoute({
  basePath: "/config-maps",
  get: { permission: "config:read", queryParams: ["namespace"] },
  patch: {
    permission: "config:write",
    schema: configMapPatchSchema,
    toPath: (b) => `/config-maps/${encodeURIComponent(b.namespace)}/${encodeURIComponent(b.name)}`,
    toBody: (b) => ({ data: b.data }),
  },
  delete: {
    permission: "config:write",
    schema: configMapDeleteSchema,
    toPath: (b) => `/config-maps/${encodeURIComponent(b.namespace)}/${encodeURIComponent(b.name)}`,
  },
});
