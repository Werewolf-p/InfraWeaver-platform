"use client";

import { Server } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { ClusterSettingsPanel } from "@/components/settings/cluster-settings-panel";

export default function InfrastructureSettingsPage() {
  return (
    <PageScaffold
      icon={Server}
      title="Infrastructure"
      subtitle="Read-only cluster configuration and platform infrastructure status"
      breadcrumb={[{ label: "Home", href: "/" }, { label: "Settings", href: "/settings" }, { label: "Infrastructure" }]}
    >
      <ClusterSettingsPanel />
    </PageScaffold>
  );
}
