// Mint a next-auth v5 JWE session cookie for headless console API calls.
// Usage: NEXTAUTH_SECRET=... node scripts/mint-jwe.mjs > /tmp/jwe
import { encode } from "@auth/core/jwt";

const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
if (!secret) { console.error("NEXTAUTH_SECRET missing"); process.exit(1); }

const jwe = await encode({
  salt: "__Host-authjs.session-token",
  secret,
  maxAge: 60 * 30,
  token: { sub: "remon", email: "remonhulst@gmail.com", name: "remon", groups: ["platform-admins"] },
});
process.stdout.write(jwe);
