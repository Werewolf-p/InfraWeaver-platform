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
const secureCookieName = (name: string) => (useSecureCookies ? `__Secure-${name}` : name);
const secureCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: useSecureCookies,
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
  useSecureCookies,
  cookies: {
    sessionToken: {
      name: secureCookieName("authjs.session-token"),
      options: secureCookieOptions,
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
        if (authentikProfile.email) token.email = authentikProfile.email;
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
