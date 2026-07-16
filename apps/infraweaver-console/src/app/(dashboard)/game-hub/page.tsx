import { redirect } from "next/navigation";

// Consolidated into the Workloads hub — Game Servers is now the addon-gated
// "game" tab. Old URLs and bookmarks keep working. UI lives in ./view.tsx.
// Detail routes (/game-hub/[name], /game-hub/new, /create, /setup) are unchanged.
export default function GameHubRedirect() {
  redirect("/workloads?tab=game");
}
