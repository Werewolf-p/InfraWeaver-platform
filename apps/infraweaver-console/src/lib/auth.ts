import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import { auditLog } from "@/lib/audit-log";
import { normalizeGroups } from "@/lib/rbac";

interface AuthentikProfile {
  email?: string | null;
  groups?: string[];
}

const SESSION_MAX_AGE = 60 * 60 * 8;
// Re-fetch Authentik groups this often so group revocation propagates
// mid-session.
const GROUP_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Fail-closed ceiling: if groups cannot be refreshed for this long (expired
// access token with no working refresh token, persistent errors), the session
// is invalidated so revoked Authentik group membership — and every RBAC
// permission derived from it — cannot keep working for the rest of
// SESSION_MAX_AGE (up to 8h before this guard existed).
const GROUP_STALENESS_MAX_MS = 60 * 60 * 1000;
const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
const useSecureCookies = process.env.NODE_ENV === "production" || authUrl?.startsWith("https://");
const secureCookieName = (name: string, hostOnly = false) => {
  if (!useSecureCookies) return name;
  return `${hostOnly ? "__Host-" : "__Secure-"}${name}`;
};
const secureCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: useSecureCookies,
};
// Session cookie uses sameSite "lax" (not "strict"): the browser returns from
// the Authentik OIDC callback via a top-level cross-site navigation, and a
// "strict" cookie would not be sent on that first request — causing the app to
// treat the user as unauthenticated and bounce back into the OIDC flow.
const sessionCookieOptions = {
  ...secureCookieOptions,
  sameSite: "lax" as const,
};

interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
}

// Renew the Authentik access token via the OIDC refresh_token grant so group
// refreshes keep working past the (short) access-token TTL instead of
// silently freezing group membership until the next sign-in. Returns null on
// any failure — callers fall back to the GROUP_STALENESS_MAX_MS ceiling.
async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens | null> {
  const issuer = process.env.AUTHENTIK_ISSUER;
  const clientId = process.env.AUTHENTIK_CLIENT_ID;
  const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return null;
  // Like userinfo, Authentik's token endpoint lives at the auth-server ROOT
  // (…/application/o/token/), not under the per-application issuer path.
  const tokenUrl = process.env.AUTHENTIK_TOKEN_URL
    ?? `${new URL(issuer).origin}/application/o/token/`;
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: unknown; refresh_token?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : undefined,
    };
  } catch {
    return null;
  }
}

export const authConfig: NextAuthConfig = {
  providers: [
    {
      id: "authentik",
      name: "Authentik",
      type: "oidc",
      issuer: process.env.AUTHENTIK_ISSUER,
      clientId: process.env.AUTHENTIK_CLIENT_ID,
      clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
      // Pin the authorization request params so every sign-in produces a stable,
      // self-consistent request. PKCE + state + nonce are correlated via the
      // checks cookies set below; keeping these explicit avoids ambiguity that
      // can leave the Authentik flow executor unable to resolve the request.
      authorization: {
        params: {
          // offline_access requests a refresh_token so RBAC group membership
          // can keep being re-validated after the access token expires. If
          // the Authentik provider does not have the scope mapping configured
          // it is simply not granted, and sessions fall back to the
          // GROUP_STALENESS_MAX_MS forced re-auth in the jwt callback.
          scope: "openid profile email offline_access",
        },
      },
      checks: ["pkce", "state", "nonce"],
    },
  ],
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE,
    updateAge: 15 * 60,
  },
  jwt: {
    maxAge: SESSION_MAX_AGE,
  },
  // Trust the X-Forwarded-* headers from Traefik so NextAuth derives the correct
  // public origin (https://infraweaver.int.<base-domain>) for the callback URL.
  // Without this, the OIDC redirect_uri/callback can be computed wrong behind the
  // reverse proxy, breaking the first-attempt flow correlation.
  trustHost: true,
  useSecureCookies,
  cookies: {
    sessionToken: {
      name: secureCookieName("authjs.session-token", true),
      options: sessionCookieOptions,
    },
    state: {
      name: secureCookieName("authjs.state"),
      options: secureCookieOptions,
    },
    nonce: {
      name: secureCookieName("authjs.nonce"),
      options: secureCookieOptions,
    },
    pkceCodeVerifier: {
      name: secureCookieName("authjs.pkce.code_verifier"),
      options: secureCookieOptions,
    },
  },
  callbacks: {
    async signIn() {
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const authentikProfile = profile as AuthentikProfile;
        token.groups = authentikProfile.groups ?? [];
        token.accessToken = account.access_token;
        // Present when Authentik grants offline_access; lets group refreshes
        // outlive the short access-token TTL.
        if (account.refresh_token) token.refreshToken = account.refresh_token;
        token.groupsRefreshedAt = Date.now();
        if (authentikProfile.email) token.email = authentikProfile.email;
        return token;
      }

      // Sessions issued before groupsRefreshedAt existed start their
      // staleness clock now instead of being invalidated immediately.
      if (typeof token.groupsRefreshedAt !== "number") {
        token.groupsRefreshedAt = Date.now();
        return token;
      }

      const staleMs = Date.now() - token.groupsRefreshedAt;
      if (staleMs <= GROUP_REFRESH_INTERVAL_MS) return token;

      // AUTHENTIK_ISSUER already includes the per-application path
      // (…/application/o/<slug>/), but Authentik's userinfo endpoint lives
      // at the auth-server ROOT (…/application/o/userinfo/). Concatenating
      // the two produced …/<slug>/application/o/userinfo/ → 404. Resolve
      // userinfo from the issuer's origin instead.
      const issuer = process.env.AUTHENTIK_ISSUER;
      const userInfoUrl = process.env.AUTHENTIK_USERINFO_URL
        ?? (issuer ? `${new URL(issuer).origin}/application/o/userinfo/` : undefined);

      if (userInfoUrl && typeof token.accessToken === "string") {
        try {
          const fetchUserinfo = (accessToken: string) => fetch(userInfoUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(5000),
          });
          let res = await fetchUserinfo(token.accessToken);
          if (res.status === 401 && typeof token.refreshToken === "string") {
            // Access token expired — renew it via the refresh_token grant and
            // retry, instead of freezing group membership until next sign-in.
            const refreshed = await refreshAccessToken(token.refreshToken);
            if (refreshed) {
              token.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) token.refreshToken = refreshed.refreshToken;
              res = await fetchUserinfo(refreshed.accessToken);
            }
          }
          if (res.ok) {
            const userinfo = await res.json() as AuthentikProfile;
            if (Array.isArray(userinfo.groups)) token.groups = userinfo.groups;
            token.groupsRefreshedAt = Date.now();
            return token;
          }
        } catch {
          // Network error — fall through to the staleness ceiling below.
        }
      }

      // Fail closed: groups could not be refreshed (expired access token with
      // no working refresh token, persistent errors, or missing issuer
      // config). Tolerate transient failures up to the grace window, then
      // invalidate the session so the user is forced to re-authenticate
      // (seamless via the live Authentik SSO session) and revoked group
      // membership cannot keep granting RBAC permissions.
      if (staleMs > GROUP_STALENESS_MAX_MS) return null;
      return token;
    },
    async session({ session, token }) {
      const user = session.user as typeof session.user & { groups?: string[] };
      // Canonicalize once at the session boundary so every downstream consumer
      // (including the raw `session.user.groups` reads that don't call
      // normalizeGroups themselves) sees trimmed names. Some SSO providers and
      // undici header round-trips deliver group names with surrounding
      // whitespace; left untrimmed, exact-string matches (getRole,
      // groups.includes) silently resolve a padded admin group to zero perms.
      user.groups = normalizeGroups(
        Array.isArray(token.groups)
          ? token.groups.filter((group): group is string => typeof group === "string")
          : [],
      );
      session.user = user;
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      await auditLog("auth:signin", user.email ?? user.name ?? "unknown", `Authenticated via ${account?.provider ?? "unknown"}`);
    },
    async signOut(message) {
      const user = "token" in message
        ? message.token?.email
        : (message.session as { user?: { email?: string } } | null | undefined)?.user?.email;
      await auditLog("auth:signout", user ?? "unknown", "Signed out");
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
