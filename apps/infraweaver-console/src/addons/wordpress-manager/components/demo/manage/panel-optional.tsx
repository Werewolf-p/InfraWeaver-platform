"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Lock, Plug, Puzzle } from "lucide-react";
import { toast } from "@/lib/notify";
import { MANAGE_PANELS, type ManagePanelId } from "../../../lib/manage/capabilities";
import type { ManageOverview } from "../../../lib/manage/types";
import { useManageAction } from "./use-manage";
import { Spinner } from "./panel-shell";
import { tabIcon } from "./tab-icons";

const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/**
 * The "Optional (Disabled)" tab. Lists every Manage panel whose backing plugin —
 * or the InfraWeaver Connector — is not active on this site, with a one-line note
 * on what it does and how to turn it on. Plugin-gated panels offer a one-click
 * install (additive; installs + activates the recommended plugin, then reloads so
 * the panel joins the visible tabs). Connector-gated panels link to the Connector
 * page. This is where "hidden because the plugin isn't installed" is made visible.
 */
export function OptionalDisabledPanel({
  site,
  overview,
  onEnabled,
}: {
  site: string;
  overview: ManageOverview;
  onEnabled: () => void;
}) {
  const availableById = new Map(overview.panels.map((p) => [p.id, p.available]));
  const disabled = MANAGE_PANELS.filter(
    (panel) => panel.requires && availableById.get(panel.id) === false,
  );
  const { run, pending } = useManageAction(site);
  const [busy, setBusy] = useState<ManagePanelId | null>(null);

  async function enable(panelId: ManagePanelId, slug: string) {
    setBusy(panelId);
    const result = await run({ type: "install-plugin", slug });
    setBusy(null);
    if (result.ok) {
      toast.success(result.message);
      onEnabled();
    } else {
      toast.error(result.message);
    }
  }

  if (disabled.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 p-8 text-center text-sm text-zinc-600 dark:text-zinc-300">
        <Puzzle className="h-5 w-5 text-emerald-500" aria-hidden />
        Every optional capability is active on this site — nothing is disabled.
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        These panels are hidden because the plugin (or connector) that powers them is not active on{" "}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{site}</span>. Enable one to add it to the tabs
        above.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {disabled.map((panel) => {
          const Icon = tabIcon(panel.icon);
          const req = panel.requires!;
          const isBusy = busy === panel.id && pending;
          return (
            <li
              key={panel.id}
              className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                  <Icon className="h-4.5 w-4.5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{panel.label}</h3>
                    <Lock className="h-3 w-3 text-zinc-400" aria-hidden />
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{panel.summary}</p>
                </div>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-300">{req.hint}</p>
              <div className="mt-auto flex items-center gap-2">
                {req.connector ? (
                  <Link href={`/wordpress/${site}/connector`} className={BTN}>
                    <Plug className="h-4 w-4" aria-hidden /> Set up Connector
                  </Link>
                ) : req.installSlug ? (
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={pending}
                    onClick={() => enable(panel.id, req.installSlug!)}
                  >
                    {isBusy ? <Spinner /> : <ArrowUpRight className="h-4 w-4" aria-hidden />}
                    Enable {req.label}
                  </button>
                ) : (
                  <span className="text-xs text-zinc-400">Manual setup required</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
