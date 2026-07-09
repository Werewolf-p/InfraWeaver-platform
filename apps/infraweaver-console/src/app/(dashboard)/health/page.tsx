import { redirect } from "next/navigation";

// Health was consolidated into the unified Monitoring hub — it now lives under the
// Health tab. This route deep-links there so old URLs, bookmarks, and the
// topbar/FAB shortcuts keep working. The page UI lives in ./view.tsx.
export default function HealthRedirect() {
  redirect("/monitoring?tab=health");
}
