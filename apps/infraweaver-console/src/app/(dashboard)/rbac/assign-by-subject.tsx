"use client";

import { useMemo, useState } from "react";
import { Search, User, Users, Plus, Trash2, Undo2, Shield, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_COLOR_CLASSES, resolveRoleDefinition, scopeLabel } from "@/lib/rbac";
import type { PlatformSubject } from "@/lib/rbac-viz-types";
import type { RbacCart } from "./use-rbac-cart";
import type { AssignmentRow, GrantSubjectRef } from "./resources";

interface AssignBySubjectProps {
  users: PlatformSubject[];
  groups: PlatformSubject[];
  assignments: AssignmentRow[];
  cart: RbacCart;
  onGrant: (subject: GrantSubjectRef) => void;
  selected: GrantSubjectRef | null;
  onSelect: (subject: GrantSubjectRef) => void;
}

/** Subject-first flow: pick a user/group, see current grants, add or revoke. */
export function AssignBySubject({ users, groups, assignments, cart, onGrant, selected, onSelect }: AssignBySubjectProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const matchedUsers = users.filter((u) => !query || u.name.toLowerCase().includes(query) || (u.secondary ?? "").toLowerCase().includes(query));
  const matchedGroups = groups.filter((g) => !query || g.name.toLowerCase().includes(query));

  const current = useMemo(
    () => (selected ? assignments.filter((a) => a.principalType === selected.principalType && a.username === selected.principal) : []),
    [assignments, selected],
  );
  const staged = selected ? cart.pendingGrants.filter((g) => g.principalType === selected.principalType && g.principal === selected.principal) : [];

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
      {/* Subject list */}
      <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/60">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subjects"
            className="h-8 w-full rounded-lg border border-gray-200 bg-white pl-8 pr-2.5 text-xs text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          />
        </div>
        <div className="max-h-[26rem] space-y-3 overflow-y-auto">
          <SubjectGroup label="Users" icon={User} items={matchedUsers} kind="user" selected={selected} onSelect={onSelect} />
          <SubjectGroup label="Groups" icon={Users} items={matchedGroups} kind="group" selected={selected} onSelect={onSelect} />
          {matchedUsers.length === 0 && matchedGroups.length === 0 && <p className="px-1 text-xs text-slate-400">No subjects match.</p>}
        </div>
      </div>

      {/* Detail */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900/60">
        {!selected ? (
          <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-2 text-center">
            <Shield className="h-8 w-8 text-slate-300 dark:text-[#333]" />
            <p className="text-sm font-medium text-gray-900 dark:text-white">Pick a subject</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">Select a user or group to review and change what they can access.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
                  {selected.principalType === "group" ? <Users className="h-3 w-3" /> : <User className="h-3 w-3" />} {selected.principalType}
                </span>
                <h3 className="mt-1 break-all text-base font-bold text-gray-900 dark:text-white">{selected.principal}</h3>
              </div>
              <button
                onClick={() => onGrant(selected)}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-[#0078D4] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#006cbd]"
              >
                <Plus className="h-3.5 w-3.5" /> Grant to {selected.principalType === "group" ? "group" : "user"}
              </button>
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Current grants ({current.length})</p>
              {current.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:bg-white/5">No direct assignments. Group membership may still confer access.</p>
              ) : (
                <div className="space-y-1.5">
                  {current.map((assignment) => {
                    const role = resolveRoleDefinition(assignment.roleId);
                    const colors = role ? ROLE_COLOR_CLASSES[role.color ?? "gray"] : ROLE_COLOR_CLASSES.gray;
                    const revoked = cart.isRevoked(assignment.id);
                    return (
                      <div key={assignment.id} className={cn("flex items-center gap-2 rounded-lg border px-3 py-2", revoked ? "border-red-500/30 bg-red-500/5" : "border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/5")}>
                        <span className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold", colors.badge, revoked && "line-through opacity-60")}>{role?.name ?? assignment.roleId}</span>
                        <span className={cn("text-[11px] text-slate-500 dark:text-slate-400", revoked && "line-through opacity-60")}>{scopeLabel(assignment.scope)}</span>
                        {assignment.expiresAt && <span className="inline-flex items-center gap-1 text-[10px] text-amber-500"><Clock className="h-3 w-3" />{new Date(assignment.expiresAt).toLocaleDateString()}</span>}
                        <button
                          onClick={() => cart.toggleRevoke({ id: assignment.id, principalType: assignment.principalType, principal: assignment.username })}
                          className={cn("ml-auto p-1 transition-colors", revoked ? "text-indigo-400 hover:text-indigo-300" : "text-gray-400 hover:text-red-400 dark:text-[#8a8a8a]")}
                          title={revoked ? "Keep this assignment" : "Stage removal"}
                        >
                          {revoked ? <Undo2 className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {staged.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-500">Staged for this subject ({staged.length})</p>
                <div className="space-y-1.5">
                  {staged.map((grant) => {
                    const role = resolveRoleDefinition(grant.roleId);
                    return (
                      <div key={grant.key} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                        <Plus className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">{role?.name ?? grant.roleId}</span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">{scopeLabel(grant.scope)}</span>
                        <button onClick={() => cart.unstageGrant(grant.key)} className="ml-auto p-1 text-gray-400 hover:text-red-400 dark:text-[#8a8a8a]" title="Discard staged grant"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface SubjectGroupProps {
  label: string;
  icon: typeof User;
  items: PlatformSubject[];
  kind: "user" | "group";
  selected: GrantSubjectRef | null;
  onSelect: (subject: GrantSubjectRef) => void;
}

function SubjectGroup({ label, icon: Icon, items, kind, selected, onSelect }: SubjectGroupProps) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Icon className="h-3 w-3" /> {label} ({items.length})
      </p>
      <div className="space-y-1">
        {items.map((subject) => {
          const active = selected?.principalType === kind && selected.principal === subject.name;
          return (
            <button
              key={subject.id}
              type="button"
              onClick={() => onSelect({ principalType: kind, principal: subject.name, principalLabel: kind === "user" ? (subject.secondary || subject.name) : subject.name })}
              className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                active ? "border border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-200" : "border border-transparent text-slate-600 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-white/5")}
            >
              <span className="min-w-0 flex-1 truncate">{subject.name}</span>
              {subject.bindings.length > 0 && <span className="flex-shrink-0 rounded-full bg-slate-200/70 px-1.5 text-[10px] text-slate-600 dark:bg-white/10 dark:text-slate-300">{subject.bindings.length}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
