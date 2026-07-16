import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — Routing & DNS (incl. port routing) is now
// the "routing" tab. Old URLs and bookmarks keep working. UI lives in ./view.tsx.
export default function RoutesRedirect() {
  redirect("/workloads?tab=routing");
}
