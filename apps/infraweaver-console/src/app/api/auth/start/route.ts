import { type NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

// GET /api/auth/start?callbackUrl=/
//
// Initiates the Authentik OIDC flow without any client-side JS or CSRF dance.
// signIn() with redirect:false generates PKCE/state/nonce, sets the auth cookies
// in the response, and returns the Authentik authorization URL.
// We return a 302 to that URL, carrying the auth cookies.
//
// The signin page links here directly — no form submission, no server action,
// no async user-gesture breakage.
// Resolve the caller-supplied callbackUrl to a safe same-site relative path.
// Enumerating dangerous characters (\\, //) missed control-character variants
// like "/\t/evil.com" and "/%0a/evil.com" which the WHATWG URL parser strips
// to a host-changing "//evil.com". Instead, resolve against a sentinel origin
// and accept only results that stay on that origin — anything that escapes to
// another host (absolute, protocol-relative, or control-char smuggled) fails.
// See SECURITY-AUDIT L1.
const SAFE_REDIRECT_BASE = "https://redirect.invalid";

function safeCallbackPath(raw: string): string {
  try {
    const resolved = new URL(raw, SAFE_REDIRECT_BASE);
    if (resolved.origin !== SAFE_REDIRECT_BASE) return "/";
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (!path.startsWith("/") || path.startsWith("//")) return "/";
    if (path.startsWith("/api/auth")) return "/"; // avoid redirect loops
    return path;
  } catch {
    return "/";
  }
}

export async function GET(req: NextRequest) {
  const callbackUrl = req.nextUrl.searchParams.get("callbackUrl") ?? "/";
  const safe = safeCallbackPath(callbackUrl);

  let url: string;
  try {
    url = (await signIn("authentik", { redirect: false, redirectTo: safe })) as string;
  } catch {
    return NextResponse.redirect(new URL("/auth/signin?error=OAuthStart", req.url));
  }

  if (!url) {
    return NextResponse.redirect(new URL("/auth/signin?error=OAuthStart", req.url));
  }

  return NextResponse.redirect(url);
}
