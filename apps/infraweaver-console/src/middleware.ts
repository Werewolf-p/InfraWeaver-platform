import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; connect-src 'self' wss: https:; frame-ancestors 'none'; font-src 'self' data:; worker-src 'self' blob:;",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "Cross-Origin-Embedder-Policy": "unsafe-none",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

// auth() handles the session check and redirects unauthenticated users to sign-in.
// The callback runs for authenticated requests and injects the security headers.
export default auth((req) => {
  void req;
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
});

export const config = {
  // Exclude: NextAuth callbacks, public health/ping endpoints, static assets, sign-in page
  matcher: [
    "/((?!api/auth|api/ping|api/health$|api/homepage-ping|_next/static|_next/image|favicon.ico|auth/signin|login).*)",
  ],
};
