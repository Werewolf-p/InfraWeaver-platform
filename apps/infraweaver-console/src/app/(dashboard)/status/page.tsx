import { redirect } from "next/navigation";

// Platform Status was consolidated into the unified Monitoring hub — it now lives
// under the Status tab. This route deep-links there so old URLs, bookmarks, and
// the topbar/FAB shortcuts keep working. The page UI lives in ./view.tsx.
export default function StatusRedirect() {
  redirect("/monitoring?tab=status");
}
