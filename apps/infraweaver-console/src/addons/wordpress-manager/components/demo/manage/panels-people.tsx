"use client";
// People (Users) panel — WordPress accounts, their roles and a per-role headcount,
// read live from the site. One allow-listed action: "Reconcile accounts" reruns
// the secure account-sync (sync-users) and reloads the panel.

import type { ReactNode } from "react";
import { RefreshCw, UserCog, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { PeopleData, WpUserRow } from "../../../lib/manage/probes/people";
import { SectionCard } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";

type RoleTone = "violet" | "info" | "good" | "warn" | "neutral";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const ROLE_PILL: Readonly<Record<RoleTone, string>> = {
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const ROLE_TONE: Readonly<Record<string, RoleTone>> = {
  administrator: "violet",
  editor: "info",
  author: "good",
  contributor: "warn",
  subscriber: "neutral",
};
function roleTone(role: string): RoleTone {
  return ROLE_TONE[role] ?? "neutral";
}

function RolePill({ role }: { role: string }): ReactNode {
  return (
    <span className={cn(PILL_BASE, ROLE_PILL[roleTone(role)])}>
      <span className="capitalize">{role}</span>
    </span>
  );
}

/** Show the date portion of a `YYYY-MM-DD HH:MM:SS` wp-cli timestamp. */
function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.split(" ")[0] || value;
}

function UserRow({ user }: { user: WpUserRow }) {
  return (
    <tr>
      <td className="py-2 pr-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{user.displayName}</p>
          <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">@{user.login}</p>
        </div>
      </td>
      <td className="py-2 pr-3">
        <span className="block max-w-[200px] truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
          {user.email ?? "—"}
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0 ? <RolePill role="none" /> : user.roles.map((role) => <RolePill key={role} role={role} />)}
        </div>
      </td>
      <td className="py-2 text-zinc-500 dark:text-zinc-400">{shortDate(user.registered)}</td>
    </tr>
  );
}

export function PeoplePanel({ site }: { site: string }) {
  const state = useManagePanel<PeopleData>(site, "people");
  const { run, pending } = useManageAction(site);

  async function reconcile() {
    const result = await run({ type: "sync-users" });
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <PanelState state={state} isEmpty={(d) => d.users.length === 0} emptyMessage="No WordPress accounts on this site.">
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard
            title="Users"
            description={`${data.total} account${data.total === 1 ? "" : "s"} with dashboard access.`}
            icon={Users}
            action={
              <button type="button" className={BTN} disabled={pending} onClick={reconcile}>
                {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Reconcile accounts
              </button>
            }
            className="lg:col-span-2"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Email</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 font-medium">Registered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {data.users.map((user) => (
                    <UserRow key={user.login} user={user} />
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="Role distribution"
            description="How dashboard access is spread across roles."
            icon={UserCog}
            className="lg:col-span-2"
          >
            {data.roleCounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                No roles assigned.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.roleCounts.map((entry) => (
                  <div key={entry.role} className={cn("flex items-center justify-between gap-3", TILE)}>
                    <RolePill role={entry.role} />
                    <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{entry.count}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </PanelState>
  );
}
