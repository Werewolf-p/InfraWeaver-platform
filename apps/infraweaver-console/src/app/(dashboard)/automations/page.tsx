"use client";

import { Calendar, Clock, Sparkles } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { AutomationsView } from "./view";
import { CronjobsView } from "../cronjobs/view";
import { ScheduledTasksView } from "../scheduled-tasks/view";

export default function AutomationsPage() {
  return (
    <TabHub
      basePath="/automations"
      tabs={[
        { value: "automations", label: "Automation", icon: Sparkles, Component: AutomationsView },
        { value: "cronjobs", label: "CronJobs", icon: Calendar, Component: CronjobsView },
        { value: "scheduled", label: "Scheduled Tasks", icon: Clock, Component: ScheduledTasksView },
      ]}
    />
  );
}
