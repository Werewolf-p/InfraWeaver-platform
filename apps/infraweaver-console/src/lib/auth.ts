import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";

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
  ] as any,
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.groups = (profile as any).groups ?? [];
        token.email = profile.email;
      }
      return token;
    },
    async session({ session, token }) {
      (session.user as any).groups = token.groups ?? [];
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
