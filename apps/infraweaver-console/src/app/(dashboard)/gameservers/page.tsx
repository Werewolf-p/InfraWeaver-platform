import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — port routing lives in the "routing" tab
// (Port routing sub-tab), which reads the same /api/gameservers/ports source.
// Old URLs and bookmarks keep working via this redirect.
export default function GameServersRedirect() {
  redirect("/workloads?tab=routing");
}
