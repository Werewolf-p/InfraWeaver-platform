import "server-only";
import type { Session } from "next-auth";
import { findUserByIdentity, loadUsersConfig } from "@/lib/users-config";
import { nasFolderScope, NasScopeError } from "@/lib/nas/scope";
import type { NasShareAssignment } from "@/types";
import type { OwnedPvcRef } from "./evaluate";

/**
 * The expandable PVCs a user owns — SERVER ONLY.
 *
 * Derived from the requester's OWN `nas_shares` in users.yaml. Only shares that
 * carry both a `pvc_namespace` and `pvc_name` (a materialized volume) and whose
 * location maps to an addressable RBAC scope are expandable; the rest are skipped
 * rather than minting an unusable target. This is the allow-list the storage-quota
 * submission is bounded to (see evaluate.validateSubmittable).
 */

/** Also exposed for the storage-quota form so the PVC dropdown matches the server. */
export interface OwnedPvcOption extends OwnedPvcRef {
  provider: string;
  share: string;
  subfolder?: string;
  access: NasShareAssignment["access"];
}

function toOwnedPvc(assignment: NasShareAssignment): OwnedPvcOption | null {
  if (!assignment.pvc_namespace || !assignment.pvc_name) return null;
  try {
    const scope = nasFolderScope(assignment.provider, assignment.share, assignment.subfolder ?? "");
    return {
      namespace: assignment.pvc_namespace,
      name: assignment.pvc_name,
      scope,
      provider: assignment.provider,
      share: assignment.share,
      ...(assignment.subfolder ? { subfolder: assignment.subfolder } : {}),
      access: assignment.access,
    };
  } catch (error) {
    if (error instanceof NasScopeError) return null;
    throw error;
  }
}

export async function getOwnedPvcsForSession(session: Session | null): Promise<OwnedPvcOption[]> {
  if (!session) return [];
  const cfg = await loadUsersConfig(60);
  const match = findUserByIdentity(cfg.users, {
    username: (session.user as { username?: string } | undefined)?.username,
    email: session.user?.email ?? undefined,
  });
  const shares = (match?.user.nas_shares as NasShareAssignment[] | undefined) ?? [];
  return shares.map(toOwnedPvc).filter((pvc): pvc is OwnedPvcOption => pvc !== null);
}
