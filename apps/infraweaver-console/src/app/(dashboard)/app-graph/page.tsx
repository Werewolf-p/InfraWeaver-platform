import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — the dependency graph is now the "graph"
// tab. Old URLs and bookmarks keep working. UI lives in ./view.tsx.
export default function AppGraphRedirect() {
  redirect("/workloads?tab=graph");
}
