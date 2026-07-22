import { redirect } from "next/navigation";

// Consolidated into a single wizard — /game-hub/new is canonical. Old
// /game-hub/create URLs and bookmarks keep working via this redirect.
export default function GameHubCreateRedirect() {
  redirect("/game-hub/new");
}
