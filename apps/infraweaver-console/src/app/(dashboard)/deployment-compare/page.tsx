import { redirect } from "next/navigation";

// Deployment Compare was consolidated into the unified Compare hub — it now lives
// under the Deploy Compare tab of /gitops-diff. This route deep-links there so old
// URLs, bookmarks, and nav shortcuts keep working. The page UI lives in ./view.tsx
// and is mounted by /gitops-diff.
export default function DeploymentCompareRedirect() {
  redirect("/gitops-diff?tab=deploy");
}
