import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignInCard } from "./SignInCard";

// The console's own "Sign in with Authentik" card is a redundant middle step —
// Authentik is the real login page. So:
//   - already authenticated  -> go straight to the destination (or home)
//   - not authenticated      -> go straight to Authentik (/api/auth/start)
// The card is only rendered as a fallback when the OIDC flow could not be
// started (?error=...), which would otherwise loop back through the redirect.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawCallback = params.callbackUrl;
  const callbackUrl = Array.isArray(rawCallback) ? rawCallback[0] : rawCallback;
  // Only honour same-origin relative paths to avoid open-redirects.
  const target = callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
    ? callbackUrl
    : "/";

  const session = await auth();
  if (session) {
    redirect(target);
  }

  const hasError = typeof params.error === "string" && params.error.length > 0;
  if (!hasError) {
    redirect(`/api/auth/start?callbackUrl=${encodeURIComponent(target)}`);
  }

  return <SignInCard />;
}
