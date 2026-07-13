/**
 * Nextcloud offboard — SERVER ONLY.
 *
 * Nextcloud has no InfraWeaver-managed local-account provider like Jellyfin does: its
 * users are JIT-provisioned over OIDC on first login, and folder visibility is driven
 * entirely by Authentik group membership (see `lib/nas/access.ts`). So offboard's
 * Authentik steps — disable the account, strip every group — already revoke all
 * Nextcloud ACCESS: a disabled, group-less identity can no longer sign in or see a
 * mount.
 *
 * What those steps leave behind is a residual Nextcloud USER ROW from earlier logins.
 * This deletes it via the OCS Provisioning API using the admin credential the platform
 * already holds in OpenBao (`secret/platform/nextcloud`, projected to env by ESO). It
 * removes only the user record — never a mount or its data. `/Media` is an external
 * TrueNAS mount, not the user's home, and `user:delete` does not touch it.
 */
import "server-only";
import { OCS_TIMEOUT_MS, nextcloudAdmin, nextcloudAuthHeader, nextcloudBaseUrl } from "@/lib/nextcloud/config";

export { isNextcloudConfigured } from "@/lib/nextcloud/config";

export interface NextcloudDeprovisionResult {
  deleted: boolean;
  message: string;
}

/** OCS wraps every response in this envelope; `statuscode` carries the real result. */
interface OcsEnvelope {
  ocs?: { meta?: { status?: string; statuscode?: number; message?: string } };
}

/**
 * Delete a Nextcloud user via `DELETE /ocs/v2.php/cloud/users/{userid}`.
 *
 * Idempotent: OCS `statuscode` 998 ("user does not exist") is treated as a no-op
 * success, so a user who never logged into Nextcloud — or an offboard re-run — reports
 * cleanly rather than as a failure. Throws on a missing admin credential or any other
 * OCS/transport failure so the caller records the step as failed (access is still
 * revoked by the Authentik steps regardless).
 */
export async function deprovisionNextcloudUser(username: string): Promise<NextcloudDeprovisionResult> {
  const admin = nextcloudAdmin();
  if (!admin) {
    throw new Error(
      "Nextcloud admin credential is not configured (NEXTCLOUD_ADMIN_USER/NEXTCLOUD_ADMIN_PASSWORD); access is still revoked via Authentik",
    );
  }

  const url = `${nextcloudBaseUrl()}/ocs/v2.php/cloud/users/${encodeURIComponent(username)}?format=json`;
  const authHeader = nextcloudAuthHeader(admin);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: authHeader,
        // Required by OCS or Nextcloud answers 412 Precondition Failed.
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(OCS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new Error(`Nextcloud OCS request timed out after ${OCS_TIMEOUT_MS}ms`);
    throw new Error("Nextcloud is unreachable");
  }

  // A 401/403 (bad admin creds) never carries a usable OCS body — surface the status.
  if (res.status === 401 || res.status === 403) throw new Error(`Nextcloud OCS auth failed: HTTP ${res.status}`);

  const body = (await res.json().catch(() => ({}))) as OcsEnvelope;
  const statuscode = body.ocs?.meta?.statuscode;

  // OCS v2 uses HTTP-aligned codes: 200 = deleted. 998 = user absent (idempotent OK).
  if (statuscode === 200 || statuscode === 100) {
    return { deleted: true, message: `Deleted Nextcloud user '${username}'` };
  }
  if (statuscode === 998) {
    return { deleted: false, message: `No Nextcloud user '${username}' (nothing to delete)` };
  }
  throw new Error(`Nextcloud OCS delete failed: statuscode ${statuscode ?? "unknown"} (HTTP ${res.status})`);
}
