import type { ElementType } from "react";
import { Anchor, FlaskConical, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { CHANNELS, type ReleaseChannel } from "../lib/channels";

/**
 * Presentation table for a release channel, the visual sibling of `TierBadge`.
 * ORTHOGONAL to the tier: a tier says *what a site is entitled to*, a channel
 * says *which Connector release train it rides*. Kept calm and distinct so the
 * two pills read as different axes side by side — prod is a quiet neutral (the
 * stable default, like the Free tier), beta warms to amber (soaking ahead of
 * prod), alpha runs hot violet (the bleeding edge).
 *
 * Exported (icon + pill classes) so the release board can reuse the exact same
 * language for its per-channel rows without redefining the palette.
 */
export interface ChannelBadgeStyle {
  readonly icon: ElementType;
  /** Border + background + text classes for the pill / accent surface. */
  readonly pill: string;
}

export const CHANNEL_BADGE_STYLE: Readonly<Record<ReleaseChannel, ChannelBadgeStyle>> = {
  prod: {
    icon: Anchor,
    pill: "border-zinc-700 bg-zinc-950/50 text-zinc-300",
  },
  beta: {
    icon: FlaskConical,
    pill: "border-amber-400/30 bg-amber-400/15 text-amber-200",
  },
  alpha: {
    icon: Rocket,
    pill: "border-violet-400/30 bg-violet-400/15 text-violet-200",
  },
};

interface ChannelBadgeProps {
  readonly channel: ReleaseChannel;
  readonly className?: string;
  /** Hide the leading channel icon (e.g. in a very dense row). */
  readonly hideIcon?: boolean;
}

/** The site's current release channel as a small pill. */
export function ChannelBadge({ channel, className, hideIcon = false }: ChannelBadgeProps) {
  const style = CHANNEL_BADGE_STYLE[channel];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.pill,
        className,
      )}
    >
      {!hideIcon && <Icon className="h-3 w-3" aria-hidden />}
      {CHANNELS[channel].label}
    </span>
  );
}
