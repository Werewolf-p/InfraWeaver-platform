import { redirect } from "next/navigation";

// Consolidated into a tabbed hub — this route now deep-links to its tab so old
// URLs and bookmarks keep working. The page UI lives in ./view.tsx.
export default function SecretExpiryRedirect() {
  redirect("/secrets?tab=expiry");
}
