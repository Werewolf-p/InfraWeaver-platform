"use client";

import { Network, Shield, Globe } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { NetworkTopologyView } from "./view";
import { NetworkPoliciesView } from "../network-policies/view";
import { IngressView } from "../ingress/view";

export default function NetworkPage() {
  return (
    <TabHub
      basePath="/network"
      tabs={[
        { value: "topology", label: "Topology", icon: Network, Component: NetworkTopologyView },
        { value: "policies", label: "Net Policies", icon: Shield, Component: NetworkPoliciesView },
        { value: "ingress", label: "Ingress", icon: Globe, Component: IngressView },
      ]}
    />
  );
}
