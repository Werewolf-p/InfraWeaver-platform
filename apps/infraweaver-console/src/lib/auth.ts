import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import { auditLog } from "@/lib/audit-log";

interface AuthentikProfile {
  email?: string | null;
  groups?: string[];
}

const SESSION_MAX_AGE = 60 * 60 * 8;
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
          scope: "openid profile email",
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
  // public origin (https://infraweaver.int.rlservers.com) for the callback URL.
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
        token.groupsRefreshedAt = Date.now();
        if (authentikProfile.email) token.email = authentikProfile.email;
      } else if (token.accessToken && typeof token.groupsRefreshedAt === "number") {
        // Refresh groups every 15 minutes using the stored access token.
        // Access tokens from Authentik have a short TTL; once expired the refresh
        // is skipped silently and groups remain as-is until the next sign-in.
        const staleMs = Date.now() - token.groupsRefreshedAt;
        if (staleMs > 15 * 60 * 1000) {
          const userInfoUrl = process.env.AUTHENTIK_USERINFO_URL
            ?? `${process.env.AUTHENTIK_ISSUER}/application/o/userinfo/`;
          try {
            const res = await fetch(userInfoUrl, {
              headers: { Authorization: `Bearer ${token.accessToken as string}` },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const userinfo = await res.json() as AuthentikProfile;
              if (Array.isArray(userinfo.groups)) token.groups = userinfo.groups;
              token.groupsRefreshedAt = Date.now();
            } else if (res.status === 401) {
              // Access token expired — stop attempting refreshes until next sign-in
              delete token.accessToken;
            }
          } catch {
            // Network error — keep existing groups, retry on next JWT evaluation
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      const user = session.user as typeof session.user & { groups?: string[] };
      user.groups = Array.isArray(token.groups)
        ? token.groups.filter((group): group is string => typeof group === "string")
        : [];
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
