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
export async function GET(req: NextRequest) {
  const callbackUrl = req.nextUrl.searchParams.get("callbackUrl") ?? "/";
  const safe = callbackUrl.startsWith("/") ? callbackUrl : "/";

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
