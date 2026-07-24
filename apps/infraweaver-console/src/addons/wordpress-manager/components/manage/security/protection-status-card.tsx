"use client";

/**
 * Protection status card — the READ-ONLY echo of the connector's copy-protection
 * and SVG-sanitizer state on the Site Security surface. Management of protected
 * media lives in the Media Explorer (where the media lives); this only reports.
 * Honest copy: media protection is a DETERRENT, not a lock; the SVG sanitizer is
 * status-only (no console knob can relax its allow-lists). True referrer-based
 * hotlink protection is deferred (needs edge/offload co-design) — shown so the
 * surface reserves room for it, never faked as available.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ImageOff, FileCode2, Link2Off, ShieldQuestion } from "lucide-react";
import { SectionCard } from "../../demo/widgets";
import { Pill, type PillTone } from "../../demo/manage/kit/pill";
import type { ProtectionStatusResponse } from "../../../lib/manage/security-consent";
import { Spinner } from "../../demo/manage/panel-shell";

export interface ProtectionStatusCardProps {
  readonly site: string;
  readonly status: ProtectionStatusResponse | null;
  readonly loading: boolean;
}

interface RowProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: ReactNode;
  readonly badge: { readonly tone: PillTone; readonly text: string };
  readonly action?: ReactNode;
}

function Row({ icon, label, detail, badge, action }: RowProps): ReactNode {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <span className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
          <Pill tone={badge.tone}>{badge.text}</Pill>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

function featureBadge(entitled: boolean, enabled: boolean): { tone: PillTone; text: string } {
  if (!entitled) return { tone: "neutral", text: "Not on plan" };
  return enabled ? { tone: "good", text: "On" } : { tone: "neutral", text: "Off" };
}

export function ProtectionStatusCard({ site, status, loading }: ProtectionStatusCardProps): ReactNode {
  return (
    <SectionCard
      title="Content protection"
      description="How this site deters media copying and gates SVG uploads. Manage protected media in the Media Explorer."
      icon={ShieldQuestion}
    >
      {loading || !status ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Spinner /> Loading protection status…
        </div>
      ) : (
        <ul className="space-y-2">
          <Row
            icon={<ImageOff className="h-4 w-4" aria-hidden />}
            label="Media copy deterrent"
            badge={featureBadge(status.media_protection.entitled, status.media_protection.enabled)}
            detail={
              status.media_protection.entitled ? (
                <>
                  {status.media_protection.protect_all
                    ? "Protecting all images"
                    : `${status.media_protection.protected_count.toLocaleString()} image(s) marked protected`}
                  {" · a deterrent (disables right-click / drag), not a hard lock."}
                </>
              ) : (
                "Discourages casual image copying. Included in Pro."
              )
            }
            action={
              status.media_protection.entitled ? (
                <Link
                  href={`/wordpress/${encodeURIComponent(site)}?section=media`}
                  className="text-sm font-medium text-sky-600 hover:underline dark:text-sky-400"
                >
                  Manage in Media
                </Link>
              ) : null
            }
          />

          <Row
            icon={<FileCode2 className="h-4 w-4" aria-hidden />}
            label="Sanitized SVG uploads"
            badge={featureBadge(status.svg_upload.entitled, status.svg_upload.enabled)}
            detail={
              status.svg_upload.entitled
                ? "SVGs are sanitized server-side (scripts / external entities stripped) before storage. The sanitizer's allow-lists are fixed — status only."
                : "Allow designers to upload icons safely. Included in Pro."
            }
          />

          <Row
            icon={<Link2Off className="h-4 w-4" aria-hidden />}
            label="Hotlink protection"
            badge={{ tone: "neutral", text: "Not yet available" }}
            detail="Referrer-based hotlink protection needs edge/offload coordination (offloaded media bypasses origin rules). Deferred by design — this is not a client-side deterrent."
          />
        </ul>
      )}
    </SectionCard>
  );
}
