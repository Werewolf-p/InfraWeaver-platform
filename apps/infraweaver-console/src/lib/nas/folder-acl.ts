// NAS folder-level ACL — decides whether a given InfraWeaver session (username
// + groups + role assignments + permission set) is allowed to bind a specific
// NAS provider/share/subfolder at a given access mode.
//
// Why this exists
// ---------------
// `nas:write` gates *who can drive the NAS pipeline at all*; this module gates
// *which folders* a caller may touch and at which access mode. Without it, any
// user with `nas:write` could assign the CFO's finance share to their own
// deployment.
//
// Two sources of truth, in priority order
// ---------------------------------------
// 1. SCOPED RBAC GRANTS (preferred). A role assignment on a `/nas/...` scope —
//    see lib/nas/scope.ts — carrying `nas:read` (readonly) or `nas:write`
//    (readwrite). These are what the console's storage-access UI writes. They
//    are audited, expirable, subject to the privilege ceiling, and visible in
//    the RBAC visualizer, because they are ordinary role assignments.
//
// 2. LEGACY ENV RULES (`NAS_FOLDER_ACL_JSON`). A coarse, deploy-time net that
//    matches raw Authentik group names. Retained so existing clusters keep
//    working unchanged; an empty/absent value means "no folder restrictions"
//    and the caller only needs `nas:write` (the original default).
//
// A scoped grant is checked FIRST and, when it matches, wins over a restrictive
// env rule. That is deliberate: the env rule is a blunt deploy-time default,
// whereas a grant is a specific, audited, ceiling-checked act by an operator
// who already holds the permission being conferred. The reverse order would
// make the UI's grants silently ineffective wherever an env rule exists.
//
// Legacy rule shape:
//   {
//     "provider": "synology" | "*",
//     "share":    "media"    | "*",
//     "subfolder_prefix": "movies/" | "" (default: "" = any subfolder),
//     "allow": {
//       "readonly":  ["platform-users", "nc-media-ro"],
//       "readwrite": ["platform-admins", "nc-media-rw"]
//     }
//   }
//
// Evaluation model
// ----------------
// - Callers holding the `*` (owner) permission bypass everything. This is why
//   the platform owner sees and can mount every folder with no grants at all.
// - A scoped RBAC grant covering the folder at the requested access → allow.
// - Otherwise the legacy rules decide. All matching rules are OR'd — one hit is
//   enough to permit. If ANY rules are declared for (provider, share) and none
//   match the caller at the requested access, the request is denied. "Default
//   deny once restricted." Undeclared shares stay open (opt-in tightening).
// - Group names are matched case-sensitively; special group `"@user:<username>"`
//   lets you grant a specific user without creating a group.

import { z } from "zod";
import { hasAssignedPermissionForScope, type Permission, type RoleAssignment } from "@/lib/rbac";
import { nasAuthorizationScope } from "@/lib/nas/scope";

export type NasAccess = "readonly" | "readwrite";

export interface FolderAclRule {
  provider: string;
  share: string;
  subfolder_prefix: string;
  allow: {
    readonly: string[];
    readwrite: string[];
  };
}

const RULE_SCHEMA = z.object({
  provider: z.string().min(1).max(63).regex(/^(?:\*|[a-z0-9][a-z0-9-]*)$/),
  share: z.string().min(1).max(63).regex(/^(?:\*|[a-z0-9][a-z0-9\-_]*)$/i),
  subfolder_prefix: z.string().max(200).regex(/^(?!.*\.\.).*/).optional().default(""),
  allow: z.object({
    readonly: z.array(z.string().min(1).max(80)).default([]),
    readwrite: z.array(z.string().min(1).max(80)).default([]),
  }).default({ readonly: [], readwrite: [] }),
});

const ACL_SCHEMA = z.array(RULE_SCHEMA);

let cached: FolderAclRule[] | null = null;

export function listFolderAclRules(env: NodeJS.ProcessEnv = process.env): FolderAclRule[] {
  if (cached) return cached;
  const raw = env.NAS_FOLDER_ACL_JSON?.trim();
  if (!raw) {
    cached = [];
    return cached;
  }
  try {
    cached = ACL_SCHEMA.parse(JSON.parse(raw));
    return cached;
  } catch (error) {
    // Fail closed on parse errors: if the operator ships a broken ACL we
    // refuse all folder-scoped requests until it's fixed, rather than
    // silently opening everything. This matches the security-first stance
    // of the rest of the NAS pipeline.
    // eslint-disable-next-line no-console
    console.error("NAS_FOLDER_ACL_JSON is invalid, denying all folder access:", error);
    cached = [{
      provider: "*",
      share: "*",
      subfolder_prefix: "",
      allow: { readonly: [], readwrite: [] },
    }];
    return cached;
  }
}

/** Test-only helper: clears the memoised list so a new env can be exercised. */
export function resetFolderAclRegistry() {
  cached = null;
}

function matchesProvider(rule: FolderAclRule, provider: string): boolean {
  return rule.provider === "*" || rule.provider.toLowerCase() === provider.toLowerCase();
}

function matchesShare(rule: FolderAclRule, share: string): boolean {
  return rule.share === "*" || rule.share.toLowerCase() === share.toLowerCase();
}

function matchesSubfolder(rule: FolderAclRule, subfolder: string): boolean {
  if (!rule.subfolder_prefix) return true;
  const normalized = subfolder.replace(/^\/+/, "").toLowerCase();
  const prefix = rule.subfolder_prefix.replace(/^\/+/, "").toLowerCase();
  return normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function identitiesFor(username: string, groups: readonly string[]): Set<string> {
  const set = new Set<string>(groups);
  set.add(`@user:${username}`);
  return set;
}

export interface FolderAclDecision {
  allowed: boolean;
  reason: string;
  matchedRule?: FolderAclRule;
}

export interface FolderAclInput {
  username: string;
  groups: readonly string[];
  /** All permissions granted to the session (used only for `*` owner bypass). */
  permissions: readonly (Permission | string)[];
  /**
   * The caller's own role assignments (their user grants plus the grants of the
   * groups they belong to), as assembled by `getSessionRBACContext`. Principal
   * filtering has already happened by then, so every assignment here applies to
   * the caller. Omitted/empty means "consult the legacy env rules only".
   */
  roleAssignments?: readonly RoleAssignment[];
  provider: string;
  share: string;
  subfolder: string;
  access: NasAccess;
}

/** The permission a given access mode requires at the folder's scope. */
export function nasPermissionFor(access: NasAccess): Permission {
  return access === "readwrite" ? "nas:write" : "nas:read";
}

/**
 * Does a scoped role assignment grant `access` on this folder?
 *
 * Uses {@link nasAuthorizationScope}, which falls back to the deepest
 * scope-addressable ancestor when a folder's own name cannot be a scope segment
 * (`Season.01`, `Movie.2024`). Grants inherit downwards, so checking an ancestor
 * confers nothing the ancestor did not already confer — while checking the
 * strict scope would deny a Contributor on `media` access to `media/Season.01`.
 *
 * Returns false — never throws — if even the provider/share are unaddressable,
 * so such a request falls through to the legacy rules rather than auto-allowing.
 */
function grantedByScopedAssignment(input: FolderAclInput): boolean {
  const assignments = input.roleAssignments;
  if (!assignments || assignments.length === 0) return false;
  let scope: string;
  try {
    scope = nasAuthorizationScope(input.provider, input.share, input.subfolder);
  } catch {
    return false;
  }
  return hasAssignedPermissionForScope([...assignments], nasPermissionFor(input.access), scope);
}

/**
 * Does the caller hold NAS authority *everywhere* (platform-admin's blanket
 * `nas:read`/`nas:write`, or a root-scoped role assignment), as opposed to
 * holding it only on specific `/nas/...` scopes?
 *
 * This distinction is what makes a scoped grant a LIMIT rather than merely a
 * key. `permissions` is the session's effective permission set at the ROOT
 * scope, so a purely scope-granted user has neither verb here.
 */
function holdsBlanketNasPermission(permissions: readonly (Permission | string)[]): boolean {
  return permissions.includes("nas:write") || permissions.includes("nas:read");
}

export function evaluateFolderAcl(
  input: FolderAclInput,
  env: NodeJS.ProcessEnv = process.env,
): FolderAclDecision {
  // Owner (`*`) always bypasses folder ACL — matches the ceiling model in
  // rbac.ts where `*` outranks everything. This is why the platform owner sees
  // and can mount every folder without holding a single storage grant.
  if (input.permissions.includes("*")) {
    return { allowed: true, reason: "owner-bypass" };
  }

  // An explicit, audited, ceiling-checked grant on this folder (or any ancestor
  // scope) is authoritative. `storage-contributor` carries both nas:read and
  // nas:write, so a read-write grant implies read-only for free.
  if (grantedByScopedAssignment(input)) {
    return { allowed: true, reason: "rbac-grant" };
  }

  // The caller's only NAS authority is scoped grants, and none covered this
  // folder at this access mode. Deny — do NOT fall through to the legacy rules,
  // whose default is "open unless a rule says otherwise". Falling through would
  // turn a grant on one share into blanket access to every unrestricted share.
  if (!holdsBlanketNasPermission(input.permissions)) {
    return {
      allowed: false,
      reason: `no storage grant covers ${input.provider}/${input.share}/${input.subfolder || ""} at ${input.access} for user '${input.username}'`,
    };
  }

  const rules = listFolderAclRules(env);
  // No ACL configured → open (backwards-compatible: `nas:write` is enough).
  if (rules.length === 0) {
    return { allowed: true, reason: "no-acl-configured" };
  }

  const applicable = rules.filter((rule) =>
    matchesProvider(rule, input.provider)
    && matchesShare(rule, input.share)
    && matchesSubfolder(rule, input.subfolder),
  );

  // Once ANY rule targets this (provider, share, subfolder) region, we're in
  // default-deny mode. If none of the applicable rules grant the caller at
  // the requested access mode, refuse.
  if (applicable.length === 0) {
    // Are there rules for this (provider, share) at all, targeting a
    // different subfolder? If so, this subfolder is "outside" the covered
    // region and we deny (operator opted into restricting the share).
    const shareIsRestricted = rules.some((rule) =>
      matchesProvider(rule, input.provider) && matchesShare(rule, input.share));
    if (shareIsRestricted) {
      return { allowed: false, reason: `subfolder '${input.subfolder || "/"}' is outside any ACL for ${input.provider}/${input.share}` };
    }
    return { allowed: true, reason: "share-not-restricted" };
  }

  const identities = identitiesFor(input.username, input.groups);
  for (const rule of applicable) {
    const grants = input.access === "readonly" ? rule.allow.readonly : rule.allow.readwrite;
    if (grants.some((entry) => entry === "*" || identities.has(entry))) {
      return { allowed: true, reason: "granted", matchedRule: rule };
    }
    // A common convention: RW grants imply RO. If the caller has RW and only
    // RO was requested, that also passes.
    if (input.access === "readonly" && rule.allow.readwrite.some((entry) => entry === "*" || identities.has(entry))) {
      return { allowed: true, reason: "granted-via-readwrite", matchedRule: rule };
    }
  }

  return { allowed: false, reason: `no rule grants ${input.access} on ${input.provider}/${input.share}/${input.subfolder || "/"} to user '${input.username}' (groups: ${input.groups.join(",") || "-"})` };
}
