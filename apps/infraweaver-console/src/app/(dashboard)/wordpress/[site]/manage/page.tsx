import { ManagePage } from "@/addons/wordpress-manager/components/manage-page";

export default async function WordpressManagePage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  return <ManagePage site={site} />;
}
