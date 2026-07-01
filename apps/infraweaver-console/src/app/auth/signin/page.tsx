import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignInCard } from "./SignInCard";

// If the visitor already has a valid session, don't show the "Sign in with
// Authentik" page at all — send them straight to their destination (or home).
// Only render the sign-in card when there is no session to establish.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (session) {
    const raw = (await searchParams).callbackUrl;
    const callbackUrl = Array.isArray(raw) ? raw[0] : raw;
    // Only honour same-origin relative paths to avoid open-redirects.
    const target = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";
    redirect(target);
  }

  return <SignInCard />;
}
