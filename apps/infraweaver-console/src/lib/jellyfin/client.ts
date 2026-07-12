/**
 * Minimal typed client for the Jellyfin server API, shaped to exactly what the
 * account adapter needs and verified against the official OpenAPI spec
 * (api.jellyfin.org/openapi/jellyfin-openapi-stable.json), not guessed:
 *
 *   POST /Users/New                 create a local user (CreateUserByName)
 *   GET  /Users                     list users (UserDto[])
 *   GET  /Users/{id}                one user (to read+mutate its Policy)
 *   POST /Users/{id}/Policy         set UserPolicy (IsAdministrator / IsDisabled…)
 *   POST /Users/{id}/Password       set/reset password (UpdateUserPassword)
 *   DELETE /Users/{id}              delete a user
 *   POST /Users/AuthenticateByName  admin login → AccessToken (bootstrap only)
 *   POST /Startup/User + /Complete  first-run wizard (bootstrap only)
 *   GET/POST/DELETE /Auth/Keys      manage API keys (bootstrap only)
 *   GET  /System/Info[/Public]      health / wizard state / token validity
 *
 * Auth uses the `Authorization: MediaBrowser …` scheme; the token (API key or a
 * session token) is included as `Token="…"` when present. The token is read by the
 * caller from OpenBao and is never logged.
 */
import "server-only";
import { jsonRequest } from "@/lib/http/json-request";

const REQUEST_TIMEOUT_MS = Number(process.env.JELLYFIN_TIMEOUT_MS) || 10_000;
/** How long to wait for Jellyfin to materialize the wizard's default first user. */
const STARTUP_USER_TIMEOUT_MS = Number(process.env.JELLYFIN_STARTUP_TIMEOUT_MS) || 60_000;
const STARTUP_USER_POLL_MS = 1_000;
const CLIENT_ID = "InfraWeaver Console";
const DEVICE_ID = "infraweaver-console";

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

/** UserDto subset the adapter reads. `Policy` is kept opaque so we can round-trip
 *  it (GET → mutate a flag → POST) without dropping its required fields. */
export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: JellyfinUserPolicy;
}

/** UserPolicy is large; we only NAME the flags we set and preserve the rest. */
export type JellyfinUserPolicy = Record<string, unknown> & {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
};

interface AuthKey {
  AccessToken: string;
  AppName: string;
}

export class JellyfinClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  /** A client bound to a token (API key or session token) for authed calls. */
  withToken(token: string): JellyfinClient {
    return new JellyfinClient(this.baseUrl, token);
  }

  private authHeader(): string {
    const parts = [`Client="${CLIENT_ID}"`, `Device="console"`, `DeviceId="${DEVICE_ID}"`, `Version="1.0"`];
    if (this.token) parts.push(`Token="${this.token}"`);
    return `MediaBrowser ${parts.join(", ")}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await jsonRequest<T>(`${this.baseUrl}${path}`, {
      method,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { Authorization: this.authHeader() },
      onError: (failure) => {
        if (failure.kind === "timeout") return new JellyfinError(`Jellyfin request timed out after ${failure.timeoutMs}ms`);
        if (failure.kind === "unreachable") return new JellyfinError("Jellyfin is unreachable");
        // Only the status is surfaced — a Jellyfin error body can echo back input.
        return new JellyfinError(`Jellyfin ${method} ${path} failed: ${failure.status}`, failure.status);
      },
    });
    return result as T;
  }

  // --- Health / bootstrap state ---------------------------------------------

  /** True once the first-run wizard is done (an admin exists). Unauthenticated. */
  async isStartupComplete(): Promise<boolean> {
    const info = await this.request<{ StartupWizardCompleted?: boolean }>("GET", "/System/Info/Public");
    return info.StartupWizardCompleted === true;
  }

  /** True if the bound token is accepted by the server (used to validate a stored key). */
  async tokenIsValid(): Promise<boolean> {
    try {
      await this.request("GET", "/System/Info");
      return true;
    } catch (err) {
      if (err instanceof JellyfinError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  // --- First-run wizard (service-account bootstrap) -------------------------

  /**
   * The wizard's default first user, once Jellyfin has created it. Returns null
   * while the server is still initializing.
   *
   * `POST /Startup/User` renames that user and sets its password — it does not
   * create one. Jellyfin answers 404 when it does not yet exist (and, confusingly,
   * also 404 for a missing password: the startup controller uses 404 for several
   * distinct errors), so there is no way to tell the two apart from the status.
   */
  private async startupUserName(): Promise<string | null> {
    try {
      const user = await this.request<{ Name?: string }>("GET", "/Startup/User");
      return user?.Name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Block until the wizard's default first user exists.
   *
   * Jellyfin creates it asynchronously a moment after the HTTP listener comes up,
   * so a console reconcile that races a freshly-started server POSTs /Startup/User
   * too early, gets a 404, and aborts the bootstrap. The next attempt then finds
   * the wizard still incomplete and tries again — or, worse, finds it complete with
   * no stored credential and demands a JELLYFIN_BOOTSTRAP_TOKEN. Observed against
   * Jellyfin 10.11.11 on a fresh /config.
   */
  private async awaitStartupUser(): Promise<void> {
    const deadline = Date.now() + STARTUP_USER_TIMEOUT_MS;
    for (;;) {
      if (await this.startupUserName()) return;
      if (Date.now() >= deadline) {
        throw new JellyfinError(
          `Jellyfin did not create its startup user within ${STARTUP_USER_TIMEOUT_MS}ms; the server may still be initializing`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_USER_POLL_MS));
    }
  }

  /** Create the first admin via the startup wizard, then finish it. */
  async completeStartup(name: string, password: string): Promise<void> {
    await this.awaitStartupUser();
    await this.request("POST", "/Startup/User", { Name: name, Password: password });
    await this.request("POST", "/Startup/Complete");
  }

  /** Admin login → a session AccessToken (when we must bootstrap an API key from a password). */
  async authenticateByName(username: string, password: string): Promise<string> {
    const result = await this.request<{ AccessToken?: string }>("POST", "/Users/AuthenticateByName", { Username: username, Pw: password });
    if (!result.AccessToken) throw new JellyfinError("Jellyfin did not return an access token");
    return result.AccessToken;
  }

  /** Mint (if absent) and return a persistent API key named `appName`. */
  async ensureApiKey(appName: string): Promise<string> {
    const existing = (await this.request<{ Items?: AuthKey[] }>("GET", "/Auth/Keys")).Items ?? [];
    const found = existing.find((key) => key.AppName === appName);
    if (found) return found.AccessToken;
    await this.request("POST", `/Auth/Keys?app=${encodeURIComponent(appName)}`);
    const after = (await this.request<{ Items?: AuthKey[] }>("GET", "/Auth/Keys")).Items ?? [];
    const minted = after.find((key) => key.AppName === appName);
    if (!minted) throw new JellyfinError("Jellyfin API key was not created");
    return minted.AccessToken;
  }

  // --- User CRUD -------------------------------------------------------------

  async listUsers(): Promise<JellyfinUser[]> {
    return this.request<JellyfinUser[]>("GET", "/Users");
  }

  async getUser(id: string): Promise<JellyfinUser> {
    return this.request<JellyfinUser>("GET", `/Users/${encodeURIComponent(id)}`);
  }

  async createUser(name: string, password: string): Promise<JellyfinUser> {
    return this.request<JellyfinUser>("POST", "/Users/New", { Name: name, Password: password });
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/Users/${encodeURIComponent(id)}`);
  }

  /**
   * Set one or more policy flags without clobbering the rest. Jellyfin's UserPolicy
   * carries REQUIRED fields (AuthenticationProviderId, PasswordResetProviderId), so
   * we read the current policy and POST it back with only our flags changed.
   */
  async patchUserPolicy(id: string, patch: Partial<JellyfinUserPolicy>): Promise<void> {
    const user = await this.getUser(id);
    const policy: JellyfinUserPolicy = { ...(user.Policy ?? {}), ...patch };
    await this.request("POST", `/Users/${encodeURIComponent(id)}/Policy`, policy);
  }

  /** Reset a user's password to `newPassword` as admin (no current password needed). */
  async setUserPassword(id: string, newPassword: string): Promise<void> {
    await this.request("POST", `/Users/${encodeURIComponent(id)}/Password`, { CurrentPw: "", NewPw: newPassword, ResetPassword: false });
  }
}
