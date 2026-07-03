"use client";

import { AppFirewallPanel } from "./app-firewall-panel";

interface PodFirewallPanelProps {
  namespace: string;
  name: string;
}

/**
 * Per-pod slice of the Pod Security firewall surface — the single-pod case of
 * AppFirewallPanel, kept as its own component so pod-scoped embeds keep a
 * stable contract.
 */
export function PodFirewallPanel({ namespace, name }: PodFirewallPanelProps) {
  return <AppFirewallPanel namespace={namespace} podNames={[name]} />;
}
