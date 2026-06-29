"use client";

import { Activity, TestTube2, HeartPulse, Globe } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { TestsView } from "./view";
import { SelfTestView } from "../self-test/view";
import { HealthTesterView } from "../health-tester/view";
import { WebhookTesterView } from "../webhook-tester/view";

export default function TestsPage() {
  return (
    <TabHub
      basePath="/tests"
      tabs={[
        { value: "platform", label: "Platform Tests", icon: Activity, Component: TestsView },
        { value: "self-test", label: "Self Test", icon: TestTube2, Component: SelfTestView },
        { value: "health-tester", label: "Health Tester", icon: HeartPulse, Component: HealthTesterView },
        { value: "webhook-tester", label: "Webhook Tester", icon: Globe, Component: WebhookTesterView },
      ]}
    />
  );
}
