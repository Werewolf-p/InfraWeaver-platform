import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — WordPress is now the addon-gated
// "wordpress" tab (renders the WordpressDashboard). Old URLs and bookmarks keep
// working. Detail routes (/wordpress/[site]) are unchanged.
export default function WordpressRedirect() {
  redirect("/workloads?tab=wordpress");
}
