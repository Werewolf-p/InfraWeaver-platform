import "server-only";
import { randomUUID } from "node:crypto";
import { makeCoreApi } from "@/lib/kube-client";
import {
  type AccessControlState,
  type CustomGroup,
  type PimActivation,
  type PimEligibility,
  type ResourceAssignment,
  EMPTY_ACCESS_STATE,
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
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.ACCESS_CONFIGMAP_NAME ?? "infraweaver-access-control";

interface AccessConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedAccessState extends AccessControlState {
  resourceVersion?: string;
}

function isNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not\s*found/i.test(message);
}

function safeParseArray<T>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function readConfigMap(): Promise<AccessConfigMap | null> {
  const coreApi = makeCoreApi();
  try {
    return (await coreApi.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as AccessConfigMap;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function loadAccessState(): Promise<LoadedAccessState> {
  const configMap = await readConfigMap();
  if (!configMap) return { ...EMPTY_ACCESS_STATE };
  return {
    groups: safeParseArray<CustomGroup>(configMap.data?.groups),
    assignments: safeParseArray<ResourceAssignment>(configMap.data?.assignments),
    eligibility: safeParseArray<PimEligibility>(configMap.data?.eligibility),
    activations: safeParseArray<PimActivation>(configMap.data?.activations),
    resourceVersion: configMap.metadata?.resourceVersion,
  };
}

/** Public read used by RBAC layers — returns plain state without resourceVersion. */
export async function getAccessState(): Promise<AccessControlState> {
  const { groups, assignments, eligibility, activations } = await loadAccessState();
  return { groups, assignments, eligibility, activations };
}

async function writeAccessState(state: LoadedAccessState): Promise<void> {
  const coreApi = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: { "app.kubernetes.io/managed-by": "infraweaver-console", "infraweaver.io/component": "access-control" },
      ...(state.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
    },
    data: {
      groups: JSON.stringify(state.groups),
      assignments: JSON.stringify(state.assignments),
      eligibility: JSON.stringify(state.eligibility),
      activations: JSON.stringify(state.activations),
      updatedAt: new Date().toISOString(),
    },
  };

  if (state.resourceVersion) {
    await coreApi.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await coreApi.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

/**
 * Read-modify-write with a single optimistic-concurrency retry on conflict.
 */
async function mutate<T>(mutator: (state: LoadedAccessState) => T): Promise<{ state: AccessControlState; result: T }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await loadAccessState();
    const result = mutator(state);
    try {
      await writeAccessState(state);
      return { state: { groups: state.groups, assignments: state.assignments, eligibility: state.eligibility, activations: state.activations }, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /409|conflict/i.test(message);
      if (!conflict || attempt === 1) throw error;
    }
  }
  throw new Error("Failed to persist access state");
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
