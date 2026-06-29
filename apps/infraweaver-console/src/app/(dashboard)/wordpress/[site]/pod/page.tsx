import { redirect } from "next/navigation";
import { findWpPodName } from "@/addons/wordpress-manager/lib/provision";
import { WORDPRESS_NAMESPACE } from "@/addons/wordpress-manager/lib/wordpress-rbac";
import { addonPodTabId } from "@/lib/addon-pod-tabs";

export const dynamic = "force-dynamic";

/**
 * "Open the site" → the pod interface. Resolves the site's running WordPress pod
 * and deep-links to its pod detail page with the WordPress addon tab pre-selected.
 * If no pod exists yet (still provisioning) it falls back to the standalone
 * management view so the link is never a dead end.
 */
export default async function WordpressSitePodRedirect({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  const pod = await findWpPodName(site);

  if (!pod) {
    redirect(`/wordpress/${encodeURIComponent(site)}`);
  }

  redirect(
    `/pods/${WORDPRESS_NAMESPACE}/${encodeURIComponent(pod)}?tab=${addonPodTabId("wordpress-manager", "wordpress")}`,
  );
}
