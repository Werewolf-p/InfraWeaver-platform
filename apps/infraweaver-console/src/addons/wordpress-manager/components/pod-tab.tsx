"use client";

import { Globe } from "lucide-react";
import { SiteDetailView } from "./site-detail-view";

interface PodTabProps {
  namespace: string;
  name: string;
  labels: Record<string, string>;
}

/**
 * The WordPress tab shown inside the pod detail page (contributed via the addon
 * manifest's `podTabs`). It only ever renders on WordPress pods — the manifest's
 * matchLabels gate ensures that — so we can read the site straight off the pod's
 * `infraweaver.io/site` label and reuse the full site-management panel.
 */
export default function WordpressPodTab({ labels }: PodTabProps) {
  const site = labels["infraweaver.io/site"];

  if (!site) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <Globe className="h-4 w-4 shrink-0" aria-hidden />
        This pod isn&apos;t linked to a WordPress site (missing the infraweaver.io/site label).
      </div>
    );
  }

  return <SiteDetailView site={site} />;
}
