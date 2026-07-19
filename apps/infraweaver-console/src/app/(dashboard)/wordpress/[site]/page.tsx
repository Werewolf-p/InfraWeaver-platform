import { SiteDetailView } from "@/addons/wordpress-manager/components/site-detail-view";

export default async function WordpressSitePage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  return <SiteDetailView site={site} />;
}
