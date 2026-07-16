import { redirect } from "next/navigation";

// Consolidated into the Identity hub — Users is the bare first tab. Old URLs and
// bookmarks keep working via this redirect. The page UI lives in ./view.tsx and
// is mounted by /identity.
export default function UsersRedirect() {
  redirect("/identity");
}
