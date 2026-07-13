/**
 * Minimal client for the Nextcloud OCS Provisioning API, shaped to exactly what the
 * credential reveal/reset flow needs:
 *
 *   GET /ocs/v2.php/cloud/users/{userid}   read one user (existence check)
 *   PUT /ocs/v2.php/cloud/users/{userid}   edit a field (here: key=password)
 *
 * OCS is NOT a JSON-body API — requests carry form-encoded fields and every response
 * is wrapped in an `ocs.meta` envelope whose `statuscode` carries the real result
 * (OCS v2 uses HTTP-aligned codes). It also demands the `OCS-APIRequest: true` header
 * or answers 412. So this uses raw `fetch` (like `deprovision.ts`) rather than the
 * JSON helper. Auth is the platform admin credential from OpenBao; it is never logged,
 * and OCS error bodies (which can echo input) are never surfaced — only the status.
 */
import "server-only";
import {
  OCS_TIMEOUT_MS,
  nextcloudAdmin,
  nextcloudAuthHeader,
  nextcloudBaseUrl,
  type NextcloudAdmin,
} from "@/lib/nextcloud/config";

export class NextcloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NextcloudError";
  }
}

/** OCS wraps every response in this envelope; `statuscode` carries the real result. */
interface OcsEnvelope {
  ocs?: { meta?: { status?: string; statuscode?: number; message?: string } };
}

/** OCS v2 "OK" codes: 100 is the OCSv1 success, 200 the v2 HTTP-aligned success. */
function isOcsOk(statuscode: number | undefined): boolean {
  return statuscode === 100 || statuscode === 200;
}

/** OCS codes meaning "no such user" — 404 (v2) and 998 (the legacy provisioning code). */
function isOcsNotFound(statuscode: number | undefined): boolean {
  return statuscode === 404 || statuscode === 998;
}

function requireAdmin(): NextcloudAdmin {
  const admin = nextcloudAdmin();
  if (!admin) {
    throw new NextcloudError(
      "Nextcloud admin credential is not configured (NEXTCLOUD_ADMIN_USER/NEXTCLOUD_ADMIN_PASSWORD)",
    );
  }
  return admin;
}

async function ocsRequest(
  method: string,
  path: string,
  body?: URLSearchParams,
): Promise<{ status: number; statuscode: number | undefined }> {
  const admin = requireAdmin();
  const url = `${nextcloudBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: nextcloudAuthHeader(admin),
    // Required by OCS or Nextcloud answers 412 Precondition Failed.
    "OCS-APIRequest": "true",
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(OCS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new NextcloudError(`Nextcloud OCS request timed out after ${OCS_TIMEOUT_MS}ms`);
    }
    throw new NextcloudError("Nextcloud is unreachable");
  }

  // A 401/403 (bad admin creds) never carries a usable OCS body — surface the status.
  if (res.status === 401 || res.status === 403) throw new NextcloudError(`Nextcloud OCS auth failed: HTTP ${res.status}`, res.status);

  const envelope = (await res.json().catch(() => ({}))) as OcsEnvelope;
  return { status: res.status, statuscode: envelope.ocs?.meta?.statuscode };
}

/**
 * True if a Nextcloud user with this id exists. False on the OCS "not found" codes.
 * Throws (NextcloudError) on any other OCS/transport failure so a genuine fault
 * (Nextcloud down, bad admin creds) is not silently read as "user absent".
 */
export async function nextcloudUserExists(userid: string): Promise<boolean> {
  const { status, statuscode } = await ocsRequest("GET", `/ocs/v2.php/cloud/users/${encodeURIComponent(userid)}?format=json`);
  if (isOcsOk(statuscode)) return true;
  if (isOcsNotFound(statuscode)) return false;
  throw new NextcloudError(`Nextcloud OCS get user failed: statuscode ${statuscode ?? "unknown"} (HTTP ${status})`);
}

/**
 * Set a Nextcloud user's password via `PUT .../users/{userid}` with `key=password`.
 * Admin-driven, so no current password is needed. Throws on a missing user or any
 * OCS/transport failure — callers verify existence first, so a failure here is a fault.
 */
export async function setNextcloudUserPassword(userid: string, password: string): Promise<void> {
  const body = new URLSearchParams({ key: "password", value: password });
  const { status, statuscode } = await ocsRequest("PUT", `/ocs/v2.php/cloud/users/${encodeURIComponent(userid)}?format=json`, body);
  if (isOcsOk(statuscode)) return;
  throw new NextcloudError(`Nextcloud OCS set password failed: statuscode ${statuscode ?? "unknown"} (HTTP ${status})`);
}
