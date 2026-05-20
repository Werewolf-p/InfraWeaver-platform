"use client";

import { Server } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { ClusterSettingsPanel } from "@/components/settings/cluster-settings-panel";

export default function InfrastructureSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="Infrastructure"
        subtitle="Read-only cluster configuration and platform infrastructure status"
        breadcrumb={[{ label: "Home", href: "/" }, { label: "Settings", href: "/settings" }, { label: "Infrastructure" }]}
      />
      <ClusterSettingsPanel />
    </div>
  );
}
