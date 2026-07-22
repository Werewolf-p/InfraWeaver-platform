import { redirect } from "next/navigation";

// Consolidated into the Automations hub — CronJobs is now a tab there. Old URLs
// and bookmarks keep working via this redirect. The page UI lives in ./view.tsx
// and is mounted by /automations.
export default function CronJobsRedirect() {
  redirect("/automations?tab=cronjobs");
}
