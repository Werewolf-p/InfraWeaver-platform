"use client";

import { useState } from "react";
import { User, MapPin, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScopeAccessPanel } from "@/components/rbac/scope-access-panel";
import type { PlatformSubject } from "@/lib/rbac-viz-types";
import type { RbacCart } from "./use-rbac-cart";
import type { AssignmentRow, GrantIntent, GrantSubjectRef } from "./resources";
import { AssignBySubject } from "./assign-by-subject";
import { AssignCart } from "./assign-cart";

type AssignTab = "subject" | "resource";

const TABS: { id: AssignTab; label: string; icon: React.ElementType }[] = [
  { id: "subject", label: "By subject", icon: User },
  { id: "resource", label: "By resource", icon: MapPin },
];

interface AssignSurfaceProps {
  users: PlatformSubject[];
  groups: PlatformSubject[];
  assignments: AssignmentRow[];
  assignmentsLoading: boolean;
  cart: RbacCart;
  onOpenGrant: (intent?: GrantIntent) => void;
  selectedSubject: GrantSubjectRef | null;
  onSelectSubject: (subject: GrantSubjectRef) => void;
}

/**
 * Interactive assign surface: grant/revoke rights to any subject on any resource.
 * Subject-first and resource-first flows feed a shared staging cart that applies
 * one canonical PUT per principal.
 */
export function AssignSurface({
  users, groups, assignments, assignmentsLoading, cart, onOpenGrant, selectedSubject, onSelectSubject,
}: AssignSurfaceProps) {
  const [tab, setTab] = useState<AssignTab>("subject");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 dark:border-white/10 dark:bg-white/5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === id
                  ? "bg-white text-[#0078D4] shadow-sm dark:bg-[#111] dark:text-[#4fc3f7]"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => onOpenGrant()}
          className="flex items-center gap-1.5 rounded-lg bg-[#0078D4] px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#006cbd]"
        >
          <Plus className="h-3.5 w-3.5" /> Grant access
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          {assignmentsLoading ? (
            <div className="flex h-64 items-center justify-center rounded-xl border border-gray-200 dark:border-white/10">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            </div>
          ) : tab === "subject" ? (
            <AssignBySubject
              users={users}
              groups={groups}
              assignments={assignments}
              cart={cart}
              onGrant={(subject) => onOpenGrant({ subject })}
              selected={selectedSubject}
              onSelect={onSelectSubject}
            />
          ) : (
            <ScopeAccessPanel onGrantHere={(scope) => onOpenGrant({ scope })} />
          )}
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <AssignCart cart={cart} assignments={assignments} />
        </div>
      </div>
    </div>
  );
}
