import { redirect } from "next/navigation";

// Consolidated into the Secrets hub as the "Health" tab. Old URLs and bookmarks
// keep working via this redirect. The page UI lives in ./view.tsx and is mounted
// by /secrets.
export default function SecretHealthRedirect() {
  redirect("/secrets?tab=health");
}
