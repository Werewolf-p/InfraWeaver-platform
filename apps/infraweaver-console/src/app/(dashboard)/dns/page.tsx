import { redirect } from "next/navigation";

// DNS management was consolidated into the Workloads hub "routing" tab (Routing &
// DNS), which carries the DNS sub-tab. This route deep-links there so old URLs,
// bookmarks, and the topbar/FAB shortcuts keep working.
export default function DnsRedirect() {
  redirect("/workloads?tab=routing");
}
