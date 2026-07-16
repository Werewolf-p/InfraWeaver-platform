"use client";

import { HardDrive, TrendingUp, Database, Archive, ShieldCheck } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { StorageVolumesView } from "./view";
import { StorageTimelineView } from "../storage-timeline/view";
import { PvBrowserView } from "../pv-browser/view";
import { BackupsView } from "../backups/view";
import { DrReadinessView } from "../dr-readiness/view";

export default function StoragePage() {
  return (
    <TabHub
      basePath="/storage"
      tabs={[
        { value: "volumes", label: "Volumes", icon: HardDrive, Component: StorageVolumesView },
        { value: "timeline", label: "Timeline", icon: TrendingUp, Component: StorageTimelineView },
        { value: "browse", label: "PV Browser", icon: Database, Component: PvBrowserView },
        { value: "backups", label: "Backups", icon: Archive, Component: BackupsView },
        { value: "dr", label: "DR Readiness", icon: ShieldCheck, Component: DrReadinessView },
      ]}
    />
  );
}
