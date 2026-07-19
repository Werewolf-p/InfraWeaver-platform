import { ConnectorView } from "@/addons/wordpress-manager/components/connector-view";

export default async function WordpressConnectorPage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  return <ConnectorView site={site} />;
}
