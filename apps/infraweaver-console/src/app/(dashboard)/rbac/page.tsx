import { redirect } from "next/navigation";

// Consolidated into the Identity hub — RBAC visualize/assign is now the "rbac"
// tab. Old URLs and bookmarks keep working. UI lives in ./view.tsx; the sibling
// panels (assign, visualize, grant-modal, …) are still imported from there.
export default function RbacRedirect() {
  redirect("/identity?tab=rbac");
}
