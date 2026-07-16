import "server-only";
import { randomUUID } from "node:crypto";
import { createConfigMapJsonStore } from "@/lib/configmap-store";
import {
  isPendingStatus,
  type SelfServiceRequest,
  type SelfServiceRequestType,
  type SelfServiceState,
  type SelfServiceStatus,
  type SelfServicePayload,
} from "./types";

/**
 * ConfigMap-backed queue for self-service requests — SERVER ONLY.
 *
 * Requests are operational/transient state (a lifecycle of pending → decided),
 * NOT GitOps desired-state, so a ConfigMap is the correct home — approved grants
 * still land durably in users.yaml via applyRoleAssignments. Mirrors the
 * access-store persistence pattern (404 → empty, create-or-replace, one conflict
 * retry) and the pruneActivations history bound.
 */

const CONFIGMAP_NAME = process.env.SELF_SERVICE_CONFIGMAP_NAME ?? "infraweaver-self-service-requests";

/** Retain every pending request + the most recent decided entries, bounded. */
const DECIDED_HISTORY_LIMIT = 200;
/** Pending requests older than this auto-expire on the next prune (7 days). */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const store = createConfigMapJsonStore<SelfServiceState>({
  name: CONFIGMAP_NAME,
  keys: ["requests"],
  labels: { "infraweaver.io/component": "self-service" },
});

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function toState(current: Partial<SelfServiceState> | null): SelfServiceState {
  return { requests: asArray(current?.requests) };
}

/** Case-insensitive identity comparison (emails/usernames are compared loosely). */
function sameIdentity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Auto-expire stale pending requests and cap decided history — keeps the
 * ConfigMap small. Pending entries past their TTL become `cancelled` (a decided
 * state) so the queue never accretes abandoned requests. Mirrors pruneActivations.
 */
export function pruneRequestList(requests: SelfServiceRequest[], now: number = Date.now()): SelfServiceRequest[] {
  const expired = requests.map((request) => {
    if (isPendingStatus(request.status) && now - Date.parse(request.createdAt) > PENDING_TTL_MS) {
      return { ...request, status: "cancelled" as SelfServiceStatus, decisionNote: "Auto-expired (TTL)", decidedAt: new Date(now).toISOString() };
    }
    return request;
  });

  const pending = expired.filter((request) => isPendingStatus(request.status));
  const decided = expired
    .filter((request) => !isPendingStatus(request.status))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, DECIDED_HISTORY_LIMIT);
  return [...pending, ...decided].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function mutate<T>(mutator: (state: SelfServiceState) => T): Promise<{ state: SelfServiceState; result: T }> {
  let result!: T;
  const state = await store.mutate((current) => {
    const next = toState(current);
    result = mutator(next);
    next.requests = pruneRequestList(next.requests);
    return next;
  });
  return { state, result };
}

export async function listRequests(): Promise<SelfServiceRequest[]> {
  const state = toState(await store.load());
  return pruneRequestList(state.requests);
}

/** Every request submitted by a given identity (owner view). */
export async function listRequestsFor(identity: string): Promise<SelfServiceRequest[]> {
  return (await listRequests()).filter((request) => sameIdentity(request.requestedBy, identity));
}

/** Every still-pending request (admin approval queue). */
export async function listPendingRequests(): Promise<SelfServiceRequest[]> {
  return (await listRequests()).filter((request) => isPendingStatus(request.status));
}

export async function getRequest(id: string): Promise<SelfServiceRequest | null> {
  return (await listRequests()).find((request) => request.id === id) ?? null;
}

export interface CreateRequestInput {
  type: SelfServiceRequestType;
  status: SelfServiceStatus;
  requestedBy: string;
  requestedByGroups: string[];
  reason?: string;
  payload: SelfServicePayload;
  appliedSummary?: string;
}

export async function createRequest(input: CreateRequestInput): Promise<SelfServiceRequest> {
  const request: SelfServiceRequest = {
    id: randomUUID(),
    type: input.type,
    status: input.status,
    requestedBy: input.requestedBy,
    requestedByGroups: input.requestedByGroups,
    ...(input.reason ? { reason: input.reason } : {}),
    payload: input.payload,
    createdAt: new Date().toISOString(),
    ...(input.appliedSummary ? { appliedSummary: input.appliedSummary } : {}),
  };
  const { result } = await mutate((state) => {
    state.requests.unshift(request);
    return request;
  });
  return result;
}

/** Fields an update may set on an existing request. */
export type RequestStatusPatch = Partial<
  Pick<SelfServiceRequest, "status" | "decidedBy" | "decidedAt" | "decisionNote" | "appliedSummary">
>;

/**
 * Read-modify-write a request's decision fields. Returns the updated request, or
 * null when the id is unknown. Immutable: a NEW request object replaces the old.
 */
export async function updateRequestStatus(id: string, patch: RequestStatusPatch): Promise<SelfServiceRequest | null> {
  const { result } = await mutate((state) => {
    const index = state.requests.findIndex((request) => request.id === id);
    if (index === -1) return null;
    const updated: SelfServiceRequest = { ...state.requests[index], ...patch };
    state.requests = state.requests.map((request, i) => (i === index ? updated : request));
    return updated;
  });
  return result;
}

/**
 * A still-pending request from the same requester with the same type + target,
 * used to reject duplicate submissions. Matching is by the fields that identify
 * the same intent per type (role+scope, or namespace+pvc, or field).
 */
export async function findPendingDuplicate(
  candidate: Pick<SelfServiceRequest, "type" | "requestedBy" | "payload">,
): Promise<SelfServiceRequest | null> {
  const pending = await listPendingRequests();
  return (
    pending.find(
      (request) =>
        request.type === candidate.type &&
        sameIdentity(request.requestedBy, candidate.requestedBy) &&
        samePayloadTarget(request.type, request.payload, candidate.payload),
    ) ?? null
  );
}

function samePayloadTarget(type: SelfServiceRequestType, a: SelfServicePayload, b: SelfServicePayload): boolean {
  if (type === "app-access") {
    const x = a as { roleId?: string; scope?: string };
    const y = b as { roleId?: string; scope?: string };
    return x.roleId === y.roleId && x.scope === y.scope;
  }
  if (type === "storage-quota") {
    const x = a as { namespace?: string; pvcName?: string };
    const y = b as { namespace?: string; pvcName?: string };
    return x.namespace === y.namespace && x.pvcName === y.pvcName;
  }
  if (type === "profile-update") {
    const x = a as { field?: string };
    const y = b as { field?: string };
    return x.field === y.field;
  }
  // password-reset has no target beyond the requester.
  return true;
}

/** Count of a requester's still-open requests, for the per-user submission cap. */
export async function countOpenRequestsFor(identity: string): Promise<number> {
  return (await listRequestsFor(identity)).filter((request) => isPendingStatus(request.status)).length;
}
