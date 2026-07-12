import { z } from "zod";
import { makeSelfProfilePatchRoute } from "@/lib/user-guards";

export const PATCH = makeSelfProfilePatchRoute({
  rateKey: "profile-email",
  schema: z.object({ newEmail: z.string().trim().email().max(254) }),
  field: "email",
  value: (body) => body.newEmail,
  auditAction: "profile:change-email",
  auditDetail: (value) => `Updated profile email to ${value}`,
});
