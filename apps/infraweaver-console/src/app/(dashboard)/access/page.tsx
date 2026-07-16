import { redirect } from "next/navigation";

// Consolidated into the Identity hub — the PIM / Groups / Assignments surface is
// now the "pim" tab. Old URLs and bookmarks keep working. UI lives in ./view.tsx.
export default function AccessRedirect() {
  redirect("/identity?tab=pim");
}
