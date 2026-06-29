import { redirect } from "next/navigation";

// Consolidated into the Networking hub — deep-links to its tab so old URLs work.
export default function IngressRedirect() {
  redirect("/network?tab=ingress");
}
