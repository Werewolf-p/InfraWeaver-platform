"use client";

import { Cog, FileText, AlertTriangle } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { ConfigEditorView } from "./view";
import { ConfigMapsView } from "../config-maps/view";
import { ConfigDriftView } from "../config-drift/view";

export default function ConfigPage() {
  return (
    <TabHub
      basePath="/config"
      tabs={[
        { value: "editor", label: "Editor", icon: Cog, Component: ConfigEditorView },
        { value: "configmaps", label: "ConfigMaps", icon: FileText, Component: ConfigMapsView },
        { value: "drift", label: "Drift", icon: AlertTriangle, Component: ConfigDriftView },
      ]}
    />
  );
}
