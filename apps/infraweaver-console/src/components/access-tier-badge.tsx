"use client";

import { Globe, Server, Shield } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { accessTierDescription, ACCESS_TIER_LABELS, type AccessTier } from "@/lib/access-tier";
import { cn } from "@/lib/utils";

const ACCESS_TIER_STYLES: Record<AccessTier, { icon: typeof Shield; className: string }> = {
  vpn: {
    icon: Shield,
    className: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  },
  internal: {
    icon: Server,
    className: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  },
  public: {
    icon: Globe,
    className: "bg-green-500/20 text-green-400 border-green-500/30",
  },
};

interface AccessTierBadgeProps {
  tier: AccessTier;
  compact?: boolean;
  className?: string;
  tooltip?: string;
  warning?: string | null;
}

export function AccessTierBadge({ tier, compact = false, className, tooltip, warning }: AccessTierBadgeProps) {
  const config = ACCESS_TIER_STYLES[tier];
  const Icon = config.icon;
  const label = ACCESS_TIER_LABELS[tier];
  const content = warning ?? tooltip ?? `${label} — ${accessTierDescription(tier)}`;

  return (
    <Tooltip content={<span className="max-w-[240px] whitespace-normal text-xs leading-relaxed">{content}</span>} position="top">
      <span
        className={cn(
          "inline-flex items-center rounded-full border font-medium",
          compact ? "h-7 min-w-7 justify-center px-2" : "gap-1.5 px-2.5 py-1 text-xs",
          config.className,
          className,
        )}
      >
        <Icon className={cn(compact ? "h-3.5 w-3.5" : "h-3.5 w-3.5")} />
        {compact ? null : <span>{label}</span>}
      </span>
    </Tooltip>
  );
}
