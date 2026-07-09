/**
 * Thin TrueNAS REST client — SERVER ONLY.
 *
 * Shared by discovery, folder management and service-account provisioning so
 * three quirks of the appliance's API are handled in exactly one place:
 *
 *   1. The REST base is `/api/v2.0`. `/api/v2` is a 404.
 *   2. Several methods (`filesystem.setacl`, `pool.dataset.*`) are *jobs*: the
 *      HTTP call returns `200` with a bare integer job id, and the work may
 *      still fail afterwards. Treating that 200 as success silently skips the
 *      operation — which is exactly how an ACL grant would appear to work while
 *      granting nothing. `truenasJobResult` polls the job to a terminal state.
 *   3. Errors come back as `{"message": "...", "errno": N}`, and `errno` is the
 *      only reliable way to tell "already exists" from a real failure.
 *
 * Every request goes through `fetchNasService`, so the SSRF allowlist and the
 * operator-confirmed TLS pin apply. Response bodies may contain password
 * hashes (`user.create` returns `unixhash`/`smbhash`) — never log a raw body.
 */

import { fetchNasService, type NasFetchOptions } from "@/lib/nas/pinned-fetch";

/** Connection details for a TrueNAS appliance. */
export interface TruenasConnection {
  host: string;
  port: number;
  apiKey: string;
  tlsFingerprint256?: string;
  /** Set only by the provider wizard, before the host joins the SSRF allowlist. */
  wizardHost?: string;
}

/** POSIX `EEXIST`. `filesystem.mkdir` returns it for an existing directory. */
export const TRUENAS_EEXIST = 17;

const DEFAULT_TIMEOUT_MS = 8_000;
const JOB_POLL_INTERVAL_MS = 400;
const JOB_POLL_ATTEMPTS = 30;

export interface TruenasResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  /** Present on a `{"message", "errno"}` error body. */
  errno?: number;
  /** Present on any error body, for surfacing to the operator. */
  message?: string;
}

export class TruenasApiError extends Error {
  constructor(readonly status: number, message: string, readonly errno?: number) {
    super(message);
    this.name = "TruenasApiError";
  }
}

function truenasOptions(conn: TruenasConnection): NasFetchOptions {
  return { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost };
}

/**
 * Issue one REST call. Never throws on a non-2xx — the caller decides, because
 * "already exists" is success for an idempotent `mkdir` and failure elsewhere.
 */
export async function truenasRequest<T = unknown>(
  conn: TruenasConnection,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<TruenasResponse<T>> {
  const res = await fetchNasService(
    `https://${conn.host}:${conn.port}/api/v2.0${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    truenasOptions(conn),
  );
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  const error = (body ?? {}) as { message?: unknown; errno?: unknown };
  return {
    ok: res.ok,
    status: res.status,
    body: body as T,
    errno: typeof error.errno === "number" ? error.errno : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
  };
}

/** Same as `truenasRequest`, but a non-2xx becomes a `TruenasApiError`. */
export async function truenasRequestOrThrow<T = unknown>(
  conn: TruenasConnection,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const res = await truenasRequest<T>(conn, path, init);
  if (!res.ok) {
    throw new TruenasApiError(res.status, res.message ?? `TrueNAS ${path} failed (HTTP ${res.status})`, res.errno);
  }
  return res.body;
}

interface TruenasJob {
  id: number;
  state: "WAITING" | "RUNNING" | "SUCCESS" | "FAILED" | "ABORTED";
  error: string | null;
}

/**
 * Await a TrueNAS job to a terminal state and throw unless it succeeded.
 *
 * `filesystem.setacl` returns `200` with a job id and then fails asynchronously
 * (e.g. an NFSv4 ACE sent to a POSIX1E dataset). Without this, the console would
 * report "permissions granted" for an ACL that was never applied.
 */
export async function truenasJobResult(conn: TruenasConnection, jobId: number, what: string): Promise<void> {
  for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
    const jobs = await truenasRequestOrThrow<TruenasJob[]>(conn, `/core/get_jobs?id=${jobId}`);
    const job = Array.isArray(jobs) ? jobs[0] : undefined;
    if (job && (job.state === "SUCCESS" || job.state === "FAILED" || job.state === "ABORTED")) {
      if (job.state === "SUCCESS") return;
      throw new TruenasApiError(500, `${what} failed on the NAS: ${job.error ?? job.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
  throw new TruenasApiError(504, `${what} did not complete on the NAS within the timeout`);
}

/**
 * Run a job-returning endpoint and wait for it. The REST layer answers with a
 * bare integer job id; anything else means the method was not a job after all,
 * in which case the call already completed synchronously.
 */
export async function truenasJobCall(
  conn: TruenasConnection,
  path: string,
  body: unknown,
  what: string,
): Promise<void> {
  const result = await truenasRequestOrThrow<number | unknown>(conn, path, { method: "POST", body });
  if (typeof result === "number") {
    await truenasJobResult(conn, result, what);
  }
}
