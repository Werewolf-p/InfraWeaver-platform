import { redirect } from "next/navigation";

// Consolidated into the Storage hub — deep-links to its tab so links/bookmarks
// keep working. The page UI lives in ./view.tsx.
export default function DrReadinessRedirect() {
  redirect("/storage?tab=dr");
}
