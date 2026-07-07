// NAS folder-level ACL — decides whether a given InfraWeaver session (username
// + groups + permission set) is allowed to bind a specific NAS
// provider/share/subfolder at a given access mode.
//
// Why this exists
// ---------------
// `nas:write` gates *who can drive the NAS pipeline at all*; this module gates
// *which folders* a caller may touch and at which access mode. Without it, any
// user with `nas:write` could assign the CFO's finance share to their own
// deployment. With it, folder access follows the same InfraWeaver group model
// as every other resource.
//
// Extensibility
// -------------
// ACL rules are declared via the `NAS_FOLDER_ACL_JSON` env var (Zod-validated
// at load time). An empty/absent value means "no folder restrictions" — the
// caller only needs `nas:write` (backwards-compatible default).
//
// Rule shape:
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
// - Callers holding the `*` (owner) permission bypass ACL entirely.
// - All matching rules are OR'd — one hit is enough to permit.
// - If ANY rules are declared for (provider, share) and none match the caller
//   at the requested access, the request is denied. "Default deny once
//   restricted." Undeclared shares stay open (opt-in tightening).
// - Group names are matched case-sensitively; special group `"@user:<username>"`
//   lets you grant a specific user without creating a group.

import { z } from "zod";
import type { Permission } from "@/lib/rbac";

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
  provider: string;
  share: string;
  subfolder: string;
  access: NasAccess;
}

export function evaluateFolderAcl(
  input: FolderAclInput,
  env: NodeJS.ProcessEnv = process.env,
): FolderAclDecision {
  // Owner (`*`) always bypasses folder ACL — matches the ceiling model in
  // rbac.ts where `*` outranks everything.
  if (input.permissions.includes("*")) {
    return { allowed: true, reason: "owner-bypass" };
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
