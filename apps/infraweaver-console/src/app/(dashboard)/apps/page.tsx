import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — Apps is the bare first tab. Old URLs and
// bookmarks keep working via this redirect. The page UI lives in ./view.tsx and
// is mounted by /workloads. Detail routes (/apps/[name]) are unchanged.
export default function AppsRedirect() {
  redirect("/workloads");
}
