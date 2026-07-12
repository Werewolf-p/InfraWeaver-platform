import { z } from "zod";
import { makeSelfProfilePatchRoute } from "@/lib/user-guards";

export const PATCH = makeSelfProfilePatchRoute({
  rateKey: "profile-name",
  schema: z.object({ newName: z.string().trim().min(1).max(120) }),
  field: "name",
  value: (body) => body.newName,
  auditAction: "profile:change-name",
  auditDetail: () => "Updated profile display name",
});
