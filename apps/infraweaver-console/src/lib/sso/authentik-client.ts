/**
 * Minimal typed client for the Authentik v3 REST API, shaped to THIS instance's
 * live API (verified by inspection, not guessed). It does only what the SSO gate
 * needs: resolve flows/cert/scope-mappings/outpost, upsert proxy & OAuth2
 * providers and their application, and manage embedded-outpost membership.
 *
 * The token is read from the environment, asserted present, and never logged. All
 * requests are bounded by an AbortController so an unreachable Authentik cannot
 * hang provisioning; network/5xx failures surface as a retryable SsoUnavailableError.
 */
import { SsoConfigError, SsoUnavailableError } from "./errors";

const REQUEST_TIMEOUT_MS = Number(process.env.AUTHENTIK_TIMEOUT_MS) || 10_000;

export interface RedirectUri {
  matching_mode: "strict";
  url: string;
  redirect_uri_type: "authorization";
}

type ProviderKind = "proxy" | "oauth2";

interface ListResponse<T> {
  results: T[];
}

export class AuthentikClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** Build from env (`AUTHENTIK_URL`, `AUTHENTIK_TOKEN`); both must be present. */
  static fromEnv(): AuthentikClient {
    const baseUrl = (process.env.AUTHENTIK_URL || "").trim().replace(/\/+$/, "");
    const token = (process.env.AUTHENTIK_TOKEN || "").trim();
    if (!baseUrl) throw new SsoConfigError("AUTHENTIK_URL is not configured");
    if (!token) throw new SsoConfigError("AUTHENTIK_TOKEN is not configured");
    return new AuthentikClient(baseUrl, token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SsoUnavailableError(`Authentik request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new SsoUnavailableError("Authentik is unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) throw new SsoUnavailableError(`Authentik returned ${res.status}`);
    // Only the status is surfaced — an Authentik error body can echo back input.
    if (!res.ok) throw new SsoConfigError(`Authentik ${method} ${path} failed: ${res.status}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async results<T>(path: string): Promise<T[]> {
    return (await this.request<ListResponse<T>>("GET", path)).results ?? [];
  }

  /** Resolve a flow pk by slug, throwing if the instance lacks it. */
  async flowPk(slug: string): Promise<string> {
    const found = await this.results<{ pk: string; slug: string }>(`/api/v3/flows/instances/?slug=${encodeURIComponent(slug)}`);
    const flow = found.find((f) => f.slug === slug);
    if (!flow) throw new SsoConfigError(`Authentik flow "${slug}" not found`);
    return flow.pk;
  }

  /** Resolve a usable signing key by name (for RS256 OIDC id-tokens); undefined if absent. */
  async signingKeyPk(name: string): Promise<string | undefined> {
    const keys = await this.results<{ pk: string; name: string }>(`/api/v3/crypto/certificatekeypairs/?has_key=true&name=${encodeURIComponent(name)}`);
    return keys.find((k) => k.name === name)?.pk;
  }

  /** Map requested managed scope names (openid/email/profile/ak_proxy) to mapping pks. */
  async scopeMappingPks(scopeNames: readonly string[]): Promise<string[]> {
    const maps = await this.results<{ pk: string; scope_name: string }>(`/api/v3/propertymappings/provider/scope/?managed__isnull=false`);
    const byName = new Map(maps.map((m) => [m.scope_name, m.pk]));
    return scopeNames.map((n) => byName.get(n)).filter((pk): pk is string => Boolean(pk));
  }

  /** The embedded (managed) proxy outpost and its current provider pk list. */
  async embeddedOutpost(): Promise<{ pk: string; providers: number[] }> {
    const outposts = await this.results<{ pk: string; name: string; type: string; managed: string | null; providers: number[] }>(`/api/v3/outposts/instances/`);
    const embedded = outposts.find((o) => o.managed === "goauthentik.io/outposts/embedded")
      ?? outposts.find((o) => o.type === "proxy" && /embedded/i.test(o.name));
    if (!embedded) throw new SsoConfigError("Authentik embedded outpost not found");
    return { pk: embedded.pk, providers: embedded.providers ?? [] };
  }

  /** Find a provider by exact name (search is fuzzy; we match precisely). */
  async findProvider(kind: ProviderKind, name: string): Promise<{ pk: number } | undefined> {
    const list = await this.results<{ pk: number; name: string }>(`/api/v3/providers/${kind}/?search=${encodeURIComponent(name)}`);
    return list.find((p) => p.name === name);
  }

  /** Upsert a provider: PATCH when it already exists (matched by name), else POST. */
  async upsertProvider(kind: ProviderKind, name: string, attrs: Record<string, unknown>): Promise<number> {
    const existing = await this.findProvider(kind, name);
    if (existing) {
      await this.request("PATCH", `/api/v3/providers/${kind}/${existing.pk}/`, attrs);
      return existing.pk;
    }
    const created = await this.request<{ pk: number }>("POST", `/api/v3/providers/${kind}/`, { name, ...attrs });
    return created.pk;
  }

  async findApplication(slug: string): Promise<{ pk: string; slug: string } | undefined> {
    // This instance doesn't filter the applications list by `?slug=` (it returns
    // nothing), so match via `?search=` and pick the exact slug — same approach as
    // findProvider. Using `?slug=` made upsert always POST (→ 400 on re-run) and
    // delete never find its target (→ stale Authentik apps left behind).
    const list = await this.results<{ pk: string; slug: string }>(`/api/v3/core/applications/?search=${encodeURIComponent(slug)}`);
    return list.find((a) => a.slug === slug);
  }

  /** Upsert the Application bound to the provider(s); matched by stable slug. */
  async upsertApplication(slug: string, attrs: Record<string, unknown>): Promise<void> {
    const existing = await this.findApplication(slug);
    if (existing) {
      await this.request("PATCH", `/api/v3/core/applications/${slug}/`, attrs);
      return;
    }
    await this.request("POST", `/api/v3/core/applications/`, { slug, ...attrs });
  }

  /** Union a provider pk into the embedded outpost (idempotent, no duplicates). */
  async addProviderToOutpost(providerPk: number): Promise<void> {
    const { pk, providers } = await this.embeddedOutpost();
    if (providers.includes(providerPk)) return;
    await this.request("PATCH", `/api/v3/outposts/instances/${pk}/`, { providers: [...providers, providerPk] });
  }

  /** Remove a provider pk from the embedded outpost so stale hosts don't accumulate. */
  async removeProviderFromOutpost(providerPk: number): Promise<void> {
    const { pk, providers } = await this.embeddedOutpost();
    if (!providers.includes(providerPk)) return;
    await this.request("PATCH", `/api/v3/outposts/instances/${pk}/`, { providers: providers.filter((p) => p !== providerPk) });
  }

  async deleteApplication(slug: string): Promise<void> {
    const existing = await this.findApplication(slug);
    if (existing) await this.request("DELETE", `/api/v3/core/applications/${slug}/`);
  }

  async deleteProvider(kind: ProviderKind, pk: number): Promise<void> {
    await this.request("DELETE", `/api/v3/providers/${kind}/${pk}/`);
  }
}
