import { redirect } from "next/navigation";

// Consolidated into the Automations hub — Scheduled Tasks is now a tab there. Old
// URLs and bookmarks keep working via this redirect. The page UI lives in
// ./view.tsx and is mounted by /automations.
export default function ScheduledTasksRedirect() {
  redirect("/automations?tab=scheduled");
}
