import { z } from "zod";

/**
 * Self-service request domain — shared types + submission schema.
 *
 * This module is import-safe on both the client (forms) and the server (routes,
 * store, executors): it holds NO server-only code (in particular it does NOT
 * import the `server-only` expand-pvc primitive). The RBAC-ceiling guard lives
 * in ./evaluate.ts, persistence in ./store.ts, executors in ./apply.ts.
 */

/** Kubernetes storage quantity (Ki…Pi). Mirrors expand-pvc's PVC_SIZE_RE, kept
 *  local so this client-safe module never imports the server-only primitive. */
const PVC_SIZE_RE = /^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi)$/;

export const SELF_SERVICE_REQUEST_TYPES = [
  "app-access",
  "storage-quota",
  "password-reset",
  "profile-update",
] as const;
export type SelfServiceRequestType = (typeof SELF_SERVICE_REQUEST_TYPES)[number];

export const SELF_SERVICE_STATUSES = [
  "pending",
  "auto-applied",
  "approved",
  "denied",
  "failed",
  "cancelled",
] as const;
export type SelfServiceStatus = (typeof SELF_SERVICE_STATUSES)[number];

/** A pending request is still awaiting an admin decision. */
export function isPendingStatus(status: SelfServiceStatus): boolean {
  return status === "pending";
}

/** A request that reached a final state (decided or self-applied). */
export function isDecidedStatus(status: SelfServiceStatus): boolean {
  return !isPendingStatus(status);
}

// ── Discriminated payloads ────────────────────────────────────────────────────

export interface AppAccessPayload {
  roleId: string;
  scope: string;
  expiresAt?: string;
}

export interface StorageQuotaPayload {
  namespace: string;
  pvcName: string;
  /** The `/nas/…` scope the PVC's share maps to — used for the submission ceiling. */
  scope: string;
  currentSize?: string;
  requestedSize: string;
}

export type PasswordResetPayload = Record<string, never>;

export interface ProfileUpdatePayload {
  field: "name" | "email";
  value: string;
}

export type SelfServicePayload =
  | AppAccessPayload
  | StorageQuotaPayload
  | PasswordResetPayload
  | ProfileUpdatePayload;

/** Narrow a request's payload to the shape implied by its `type`. */
export interface SelfServiceRequest {
  id: string;
  type: SelfServiceRequestType;
  status: SelfServiceStatus;
  /** Email/username of the session actor who submitted the request. */
  requestedBy: string;
  /** Snapshot of the requester's Authentik groups at submit time (for audit). */
  requestedByGroups: string[];
  /** Free-text user justification. */
  reason?: string;
  payload: SelfServicePayload;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** Human-readable outcome. NEVER a secret or recovery link. */
  appliedSummary?: string;
}

export interface SelfServiceState {
  requests: SelfServiceRequest[];
}

// ── Submission schema (validated at the API boundary) ─────────────────────────

const scopeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/(?:[a-z0-9/_-]*)$/, "Invalid scope");

const reasonSchema = z.string().trim().max(500).optional();

export const appAccessSubmitSchema = z.object({
  type: z.literal("app-access"),
  reason: reasonSchema,
  payload: z.object({
    roleId: z.string().min(1).max(120),
    scope: scopeSchema,
    expiresAt: z.string().datetime().optional(),
  }),
});

export const storageQuotaSubmitSchema = z.object({
  type: z.literal("storage-quota"),
  reason: reasonSchema,
  payload: z.object({
    namespace: z.string().min(1).max(253),
    pvcName: z.string().min(1).max(253),
    scope: scopeSchema,
    currentSize: z.string().max(32).regex(PVC_SIZE_RE).optional(),
    requestedSize: z.string().min(2).max(32).regex(PVC_SIZE_RE),
  }),
});

export const passwordResetSubmitSchema = z.object({
  type: z.literal("password-reset"),
  reason: reasonSchema,
  payload: z.object({}).strict().optional().default({}),
});

export const profileUpdateSubmitSchema = z.object({
  type: z.literal("profile-update"),
  reason: reasonSchema,
  payload: z.object({
    field: z.enum(["name", "email"]),
    value: z.string().trim().min(1).max(254),
  }),
});

/** Discriminated union every self-service submission is parsed against. */
export const selfServiceSubmitSchema = z.discriminatedUnion("type", [
  appAccessSubmitSchema,
  storageQuotaSubmitSchema,
  passwordResetSubmitSchema,
  profileUpdateSubmitSchema,
]);

export type SelfServiceSubmit = z.infer<typeof selfServiceSubmitSchema>;
