"use client";

// Users & comment moderation for the per-site "Manage" console (demo).
import type { ReactNode } from "react";
import { Check, MessageSquare, ShieldAlert, Trash2, UserPlus, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData, WpUser } from "../site-manage-data";
import { SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const DEMO_MSG = "Demo — no changes are made to the live site.";

type PillTone = "good" | "info" | "warn" | "critical" | "neutral" | "violet";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

const ROLE_TONE: Readonly<Record<WpUser["role"], PillTone>> = {
  administrator: "violet",
  editor: "info",
  author: "good",
  contributor: "warn",
  subscriber: "neutral",
};

export function PeoplePanel({ data }: { data: SiteManageData; site: string }) {
  const pending = data.comments.filter((c) => c.status === "pending").length;
  const spam = data.comments.filter((c) => c.status === "spam").length;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Users"
        description={`${data.users.length} users with dashboard access.`}
        icon={Users}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={() => toast.info(DEMO_MSG)}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden /> Invite user
            </button>
            <DummyBadge />
          </div>
        }
        className="lg:col-span-2"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Email</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Posts</th>
                <th className="py-2 font-medium">Last seen</th>
                <th className="py-2 font-medium">2FA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.users.map((u) => (
                <tr key={u.login}>
                  <td className="py-2 pr-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{u.displayName}</p>
                      <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">@{u.login}</p>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="block max-w-[180px] truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{u.email}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Pill tone={ROLE_TONE[u.role]}>
                      <span className="capitalize">{u.role}</span>
                    </Pill>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-zinc-700 dark:text-zinc-300">{u.posts}</td>
                  <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">{u.lastSeen}</td>
                  <td className="py-2">{u.twoFactor ? <Pill tone="good">2FA</Pill> : <Pill tone="neutral">—</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Comment moderation"
        description={`${pending} pending · ${spam} spam`}
        icon={MessageSquare}
        action={<DummyBadge />}
        className="lg:col-span-2"
      >
        {data.comments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            The moderation queue is clear.
          </div>
        ) : (
          <ul className="space-y-2">
            {data.comments.map((c) => (
              <li key={c.id} className={TILE}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.author}</span>
                    {c.status === "pending" ? <Pill tone="warn">pending</Pill> : <Pill tone="critical">spam</Pill>}
                  </div>
                  <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">{c.excerpt}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    on <span className="font-mono">{c.onPost}</span> · {c.when}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={cn(BTN, "px-2.5 py-1 text-xs")}
                    onClick={() => toast.success("Approved — demo only, no changes are made to the live site.")}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden /> Approve
                  </button>
                  <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={() => toast.info(DEMO_MSG)}>
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Spam
                  </button>
                  <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={() => toast.info(DEMO_MSG)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Trash
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
