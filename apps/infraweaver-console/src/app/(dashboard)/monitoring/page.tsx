"use client";

import { Gauge, LayoutDashboard, Activity, HeartPulse, TrendingUp, ScrollText } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { ObservabilityBoardView } from "./board-view";
import { MonitoringView } from "./view";
import { LogsView } from "./logs-view";
import { StatusView } from "../status/view";
import { HealthView } from "../health/view";
import { UptimeView } from "../uptime/view";

export default function MonitoringPage() {
  return (
    <TabHub
      basePath="/monitoring"
      tabs={[
        // Signals is tabs[0] so bare /monitoring lands on the proactive board;
        // the reactive Overview/Status/Health/Uptime surfaces become drill-downs.
        { value: "signals", label: "Signals", icon: Gauge, Component: ObservabilityBoardView },
        { value: "overview", label: "Overview", icon: LayoutDashboard, Component: MonitoringView },
        { value: "status", label: "Status", icon: Activity, Component: StatusView },
        { value: "health", label: "Health", icon: HeartPulse, Component: HealthView },
        { value: "uptime", label: "Uptime", icon: TrendingUp, Component: UptimeView },
        { value: "logs", label: "Logs", icon: ScrollText, Component: LogsView },
      ]}
    />
  );
}
