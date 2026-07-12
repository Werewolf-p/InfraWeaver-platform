import "server-only";
import { randomUUID } from "node:crypto";
import { createConfigMapJsonStore } from "@/lib/configmap-store";
import {
  type AccessControlState,
  type CustomGroup,
  type PimActivation,
  type PimEligibility,
  type ResourceAssignment,
  PIM_ROLES,
  effectiveMaxDuration,
  eligibleRolesFor,
  isActivationActive,
  isPimRoleId,
  normalizeIdentity,
} from "@/lib/pim";

/**
 * Server-side persistence for Azure-style access management + PIM.
 *
 * State lives in a single ConfigMap (`infraweaver-access-control`) in the console
 * namespace. Each top-level slice of {@link AccessControlState} is serialized as a
 * JSON string under its own key so the data is human-inspectable via kubectl.
 * Persistence (404 → empty, create-or-replace, one conflict retry) is delegated
 * to the shared ConfigMap JSON store.
 */

const CONFIGMAP_NAME = process.env.ACCESS_CONFIGMAP_NAME ?? "infraweaver-access-control";

const store = createConfigMapJsonStore<AccessControlState>({
  name: CONFIGMAP_NAME,
  keys: ["groups", "assignments", "eligibility", "activations"],
  labels: { "infraweaver.io/component": "access-control" },
});

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize a (possibly partial/missing) stored value into a full state object. */
function toState(current: Partial<AccessControlState> | null): AccessControlState {
  return {
    groups: asArray(current?.groups),
    assignments: asArray(current?.assignments),
    eligibility: asArray(current?.eligibility),
    activations: asArray(current?.activations),
  };
}

export async function loadAccessState(): Promise<AccessControlState> {
  return toState(await store.load());
}

/** Public read used by RBAC layers. */
export async function getAccessState(): Promise<AccessControlState> {
  return loadAccessState();
}

/**
 * Read-modify-write with a single optimistic-concurrency retry on conflict.
 */
async function mutate<T>(mutator: (state: AccessControlState) => T): Promise<{ state: AccessControlState; result: T }> {
  let result!: T;
  const state = await store.mutate((current) => {
    const next = toState(current);
    result = mutator(next);
    return next;
  });
  return { state, result };
}

// ── Custom groups ────────────────────────────────────────────────────────────

export interface GroupInput {
  name: string;
  description?: string;
  permissions?: CustomGroup["permissions"];
  members?: string[];
}

export async function createGroup(input: GroupInput, actor: string): Promise<CustomGroup> {
  const { result } = await mutate((state) => {
    const group: CustomGroup = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      permissions: input.permissions ?? [],
      members: dedupeIdentities(input.members ?? []),
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    state.groups.push(group);
    return group;
  });
  return result;
}

export async function updateGroup(id: string, patch: Partial<GroupInput>): Promise<CustomGroup | null> {
  const { result } = await mutate((state) => {
    const group = state.groups.find((g) => g.id === id);
    if (!group) return null;
    if (patch.name !== undefined) group.name = patch.name.trim();
    if (patch.description !== undefined) group.description = patch.description.trim();
    if (patch.permissions !== undefined) group.permissions = patch.permissions;
    if (patch.members !== undefined) group.members = dedupeIdentities(patch.members);
    group.updatedAt = new Date().toISOString();
    return group;
  });
  return result;
}

export async function deleteGroup(id: string): Promise<boolean> {
  const { result } = await mutate((state) => {
    const before = state.groups.length;
    state.groups = state.groups.filter((g) => g.id !== id);
    // Cascade: drop assignments + eligibility that referenced the group.
    state.assignments = state.assignments.filter((a) => !(a.principalType === "group" && a.principalId === id));
    state.eligibility = state.eligibility.filter((e) => !(e.principalType === "group" && e.principalId === id));
    return state.groups.length < before;
  });
  return result;
}

function dedupeIdentities(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = normalizeIdentity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// ── Resource assignments ─────────────────────────────────────────────────────

export type AssignmentInput = Omit<ResourceAssignment, "id" | "grantedAt" | "grantedBy">;

export async function createAssignment(input: AssignmentInput, actor: string): Promise<ResourceAssignment> {
  const { result } = await mutate((state) => {
    const assignment: ResourceAssignment = {
      ...input,
      principalId: input.principalId.trim(),
      resourceId: input.resourceId.trim(),
      id: randomUUID(),
      grantedAt: new Date().toISOString(),
      grantedBy: actor,
    };
    state.assignments.push(assignment);
    return assignment;
  });
  return result;
}

export async function deleteAssignment(id: string): Promise<boolean> {
  const { result } = await mutate((state) => {
    const before = state.assignments.length;
    state.assignments = state.assignments.filter((a) => a.id !== id);
    return state.assignments.length < before;
  });
  return result;
}

// ── PIM eligibility ──────────────────────────────────────────────────────────

export type EligibilityInput = Omit<PimEligibility, "id" | "createdAt" | "createdBy">;

export async function createEligibility(input: EligibilityInput, actor: string): Promise<PimEligibility> {
  const { result } = await mutate((state) => {
    const eligibility: PimEligibility = {
      ...input,
      principalId: input.principalId.trim(),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    state.eligibility.push(eligibility);
    return eligibility;
  });
  return result;
}

export async function deleteEligibility(id: string): Promise<boolean> {
  const { result } = await mutate((state) => {
    const before = state.eligibility.length;
    state.eligibility = state.eligibility.filter((e) => e.id !== id);
    return state.eligibility.length < before;
  });
  return result;
}

// ── PIM activations ──────────────────────────────────────────────────────────

export interface ActivateResult {
  ok: boolean;
  error?: string;
  activation?: PimActivation;
}

export async function activateRole(params: {
  user: string;
  identities: string[];
  authentikGroups: string[];
  role: string;
  durationMinutes: number;
  reason: string;
}): Promise<ActivateResult> {
  if (!isPimRoleId(params.role)) return { ok: false, error: "Unknown PIM role" };
  const role = params.role;

  const { result } = await mutate<ActivateResult>((state) => {
    const eligible = eligibleRolesFor(state, params.identities, params.authentikGroups);
    const match = eligible.find((entry) => entry.role === role);
    if (!match) return { ok: false, error: "You are not eligible to activate this role" };

    const now = Date.now();
    // Prevent duplicate concurrent activations of the same role.
    const existing = state.activations.find(
      (a) => normalizeIdentity(a.user) === normalizeIdentity(params.user) && a.role === role && isActivationActive(a, now),
    );
    if (existing) return { ok: false, error: "Role is already active", activation: existing };

    const cap = effectiveMaxDuration(match);
    const duration = Math.max(1, Math.min(params.durationMinutes, cap));
    const activation: PimActivation = {
      id: randomUUID(),
      user: params.user,
      role,
      reason: params.reason.trim().slice(0, 500),
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + duration * 60_000).toISOString(),
    };
    state.activations.unshift(activation);
    state.activations = pruneActivations(state.activations);
    return { ok: true, activation };
  });
  return result;
}

export async function deactivateActivation(id: string, actor: string, requireSelf?: string): Promise<ActivateResult> {
  const { result } = await mutate<ActivateResult>((state) => {
    const activation = state.activations.find((a) => a.id === id);
    if (!activation) return { ok: false, error: "Activation not found" };
    if (requireSelf && normalizeIdentity(activation.user) !== normalizeIdentity(requireSelf)) {
      return { ok: false, error: "You can only deactivate your own elevations" };
    }
    if (activation.deactivatedAt) return { ok: true, activation };
    activation.deactivatedAt = new Date().toISOString();
    activation.deactivatedBy = actor;
    return { ok: true, activation };
  });
  return result;
}

/** Keep audit history bounded: retain all active + the most recent 200 historical entries. */
function pruneActivations(activations: PimActivation[], limit = 200): PimActivation[] {
  const now = Date.now();
  const active = activations.filter((a) => isActivationActive(a, now));
  const historical = activations
    .filter((a) => !isActivationActive(a, now))
    .sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt))
    .slice(0, limit);
  return [...active, ...historical].sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt));
}

export { PIM_ROLES };
