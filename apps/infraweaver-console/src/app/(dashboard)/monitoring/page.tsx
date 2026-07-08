"use client";

import { LayoutDashboard, Activity, HeartPulse, TrendingUp } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { MonitoringView } from "./view";
import { StatusView } from "../status/view";
import { HealthView } from "../health/view";
import { UptimeView } from "../uptime/view";

export default function MonitoringPage() {
  return (
    <TabHub
      basePath="/monitoring"
      tabs={[
        { value: "overview", label: "Overview", icon: LayoutDashboard, Component: MonitoringView },
        { value: "status", label: "Status", icon: Activity, Component: StatusView },
        { value: "health", label: "Health", icon: HeartPulse, Component: HealthView },
        { value: "uptime", label: "Uptime", icon: TrendingUp, Component: UptimeView },
      ]}
    />
  );
}
