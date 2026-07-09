import { redirect } from "next/navigation";

// Uptime History was consolidated into the unified Monitoring hub — it now lives
// under the Uptime tab. This route deep-links there so old URLs, bookmarks, and
// shortcuts keep working. The page UI lives in ./view.tsx.
export default function UptimeRedirect() {
  redirect("/monitoring?tab=uptime");
}
