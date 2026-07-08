import { redirect } from "next/navigation";

// DNS management was consolidated into the unified "Routing & DNS" page — records
// now live under its DNS tab. This route deep-links there so old URLs, bookmarks,
// and the topbar/FAB shortcuts keep working.
export default function DnsRedirect() {
  redirect("/routes?tab=dns");
}
