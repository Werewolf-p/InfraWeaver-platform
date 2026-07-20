import { redirect } from "next/navigation";

/**
 * Legacy deep link. The per-pod detail route (/pods/<ns>/<name>) was removed in
 * the IA restructure — every /pods/* path now redirects to the generic Apps
 * list, which is not the site you clicked. The site's own management view lives
 * at /wordpress/<site> (SiteDetailView, the same content the WordPress pod tab
 * rendered), so send any stale /pod link straight there.
 */
export default async function WordpressSitePodRedirect({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  redirect(`/wordpress/${encodeURIComponent(site)}`);
}
