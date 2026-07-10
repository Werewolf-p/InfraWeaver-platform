/**
 * Jellyfin as the FIRST {@link AppAccountProvider} adapter.
 *
 * Everything Jellyfin-specific about account provisioning lives here; the reconcile
 * engine (`lib/app-accounts/reconcile.ts`) never learns Jellyfin exists. Adding a
 * second app (Immich, Audiobookshelf) is another file exactly like this one — a new
 * adapter, not a change to the engine.
 *
 * Service-account bootstrap
 * -------------------------
 * The console manages Jellyfin with a dedicated admin ("InfraWeaver service
 * account") and a persistent API key, both minted automatically and stored in
 * OpenBao. `ensureServiceAccount` is idempotent and handles the two real states of
 * a fresh cluster:
 *   1. First-run wizard NOT completed → run it to create the service admin, then
 *      mint the API key. Fully hands-off.
 *   2. Wizard already completed by hand → the console cannot self-mint a key, so it
 *      uses a one-time operator-supplied bootstrap token (env) or previously-stored
 *      admin credentials. Absent both, it throws a clear, actionable error rather
 *      than silently doing nothing.
 */
import "server-only";
import { generateAppPassword } from "@/lib/app-accounts/password";
import { readAppSecret, writeAppSecret } from "@/lib/app-accounts/store";
import type { AppAccountProvider, AppUserAccount, AppUserRole } from "@/lib/app-accounts/types";
import { JellyfinClient, JellyfinError, type JellyfinUser } from "@/lib/jellyfin/client";
import {
  JELLYFIN_APP_ID,
  JELLYFIN_APP_LABEL,
  JELLYFIN_SERVICE_SECRET,
  jellyfinBaseUrl,
  jellyfinBootstrapToken,
  jellyfinLaunchUrl,
  jellyfinServiceAccountUsername,
} from "@/lib/jellyfin/config";

const API_KEY_APP_NAME = "InfraWeaver";

function toAccount(user: JellyfinUser): AppUserAccount {
  return {
    id: user.Id,
    username: user.Name,
    role: user.Policy?.IsAdministrator ? "admin" : "user",
    disabled: user.Policy?.IsDisabled === true,
  };
}

export class JellyfinAccountProvider implements AppAccountProvider {
  readonly appId = JELLYFIN_APP_ID;
  readonly appLabel = JELLYFIN_APP_LABEL;
  readonly launchUrl = jellyfinLaunchUrl();
  readonly serviceAccountUsername = jellyfinServiceAccountUsername();

  /** Set by ensureServiceAccount; every user call goes through it. */
  private authed: JellyfinClient | null = null;

  private anon(): JellyfinClient {
    return new JellyfinClient(jellyfinBaseUrl());
  }

  private requireAuthed(): JellyfinClient {
    if (!this.authed) throw new JellyfinError("Jellyfin service account is not initialized; call ensureServiceAccount first");
    return this.authed;
  }

  async ensureServiceAccount(): Promise<void> {
    const stored = (await readAppSecret(this.appId, JELLYFIN_SERVICE_SECRET)) ?? {};

    // Fast path: a stored API key that the server still accepts.
    if (stored.apiKey) {
      const client = this.anon().withToken(stored.apiKey);
      if (await client.tokenIsValid()) {
        this.authed = client;
        return;
      }
    }

    const apiKey = await this.mintApiKey(stored);
    this.authed = this.anon().withToken(apiKey);
  }

  /** Obtain a persistent API key, running the wizard or using a bootstrap token as
   *  needed, and persist it (with the service-admin creds) for next time. */
  private async mintApiKey(stored: Record<string, string>): Promise<string> {
    const anon = this.anon();

    // Case 1 — fresh server: drive the first-run wizard to create the service admin.
    if (!(await anon.isStartupComplete())) {
      const adminPassword = stored.adminPassword || generateAppPassword(24);
      await anon.completeStartup(this.serviceAccountUsername, adminPassword);
      return this.mintFromAdminLogin(this.serviceAccountUsername, adminPassword);
    }

    // Case 2a — wizard already done, but we saved the admin creds earlier: re-login.
    if (stored.adminUsername && stored.adminPassword) {
      return this.mintFromAdminLogin(stored.adminUsername, stored.adminPassword);
    }

    // Case 2b — operator supplied a one-time bootstrap token: use it to mint our key.
    const bootstrap = jellyfinBootstrapToken();
    if (bootstrap) {
      const apiKey = await anon.withToken(bootstrap).ensureApiKey(API_KEY_APP_NAME);
      await writeAppSecret(this.appId, JELLYFIN_SERVICE_SECRET, { ...stored, apiKey });
      return apiKey;
    }

    throw new JellyfinError(
      "Jellyfin is already set up but has no InfraWeaver service credential. Set JELLYFIN_BOOTSTRAP_TOKEN to a Jellyfin admin API key once so the console can mint its own key.",
    );
  }

  private async mintFromAdminLogin(username: string, password: string): Promise<string> {
    const sessionToken = await this.anon().authenticateByName(username, password);
    const apiKey = await this.anon().withToken(sessionToken).ensureApiKey(API_KEY_APP_NAME);
    await writeAppSecret(this.appId, JELLYFIN_SERVICE_SECRET, { apiKey, adminUsername: username, adminPassword: password });
    return apiKey;
  }

  async listUsers(): Promise<AppUserAccount[]> {
    return (await this.requireAuthed().listUsers()).map(toAccount);
  }

  async createUser(username: string, password: string): Promise<AppUserAccount> {
    return toAccount(await this.requireAuthed().createUser(username, password));
  }

  async setUserRole(id: string, role: AppUserRole): Promise<void> {
    await this.requireAuthed().patchUserPolicy(id, { IsAdministrator: role === "admin" });
  }

  async disableUser(id: string): Promise<void> {
    await this.requireAuthed().patchUserPolicy(id, { IsDisabled: true });
  }

  async enableUser(id: string): Promise<void> {
    await this.requireAuthed().patchUserPolicy(id, { IsDisabled: false });
  }

  async resetPassword(id: string, password: string): Promise<void> {
    await this.requireAuthed().setUserPassword(id, password);
  }
}
