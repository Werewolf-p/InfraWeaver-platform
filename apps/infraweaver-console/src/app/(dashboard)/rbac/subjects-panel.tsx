"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Search, User, Users, Server } from "lucide-react";
import type { SubjectKind } from "@/lib/rbac-viz-types";

interface VizSubject {
  id: string;
  kind: SubjectKind;
  name: string;
  secondary?: string;
  bindings: { roleName: string }[];
}

type KindFilter = "all" | SubjectKind;

const FILTER_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All subjects" },
  { value: "User", label: "Users" },
  { value: "Group", label: "Groups" },
  { value: "ServiceAccount", label: "Service accounts" },
];

const KIND_META: Record<SubjectKind, { label: string; icon: typeof User }> = {
  User: { label: "Users", icon: User },
  Group: { label: "Groups", icon: Users },
  ServiceAccount: { label: "Service Accounts", icon: Server },
};

const KIND_ORDER: SubjectKind[] = ["User", "Group", "ServiceAccount"];

interface SubjectsPanelProps {
  subjects: VizSubject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: KindFilter;
  onFilterChange: (value: KindFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

export function SubjectsPanel({ subjects, selectedId, onSelect, filter, onFilterChange, search, onSearchChange }: SubjectsPanelProps) {
  const query = search.trim().toLowerCase();
  const visible = subjects.filter((subject) => {
    if (filter !== "all" && subject.kind !== filter) return false;
    if (!query) return true;
    return subject.name.toLowerCase().includes(query) || (subject.secondary?.toLowerCase().includes(query) ?? false);
  });

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Subjects ({visible.length})</h3>
        <Select.Root value={filter} onValueChange={(value) => onFilterChange(value as KindFilter)}>
          <Select.Trigger
            aria-label="Filter subjects by type"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2.5 text-xs text-gray-900 dark:text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
          >
            <Select.Value />
            <Select.Icon><ChevronDown className="h-3.5 w-3.5 text-gray-500 dark:text-[#888]" /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="z-popover overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-900 dark:text-[#f2f2f2] shadow-2xl">
              <Select.Viewport className="p-1">
                {FILTER_OPTIONS.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs text-gray-900 dark:text-[#f2f2f2] outline-none data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-[#1a1a1a]"
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                    <Select.ItemIndicator><Check className="h-3.5 w-3.5 text-emerald-500" /></Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search subjects"
          className="h-8 w-full rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] pl-8 pr-2.5 text-xs text-gray-900 dark:text-[#f2f2f2] placeholder:text-slate-400 focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
        />
      </div>

      <div className="max-h-[28rem] space-y-3 overflow-y-auto">
        {KIND_ORDER.map((kind) => {
          const group = visible.filter((subject) => subject.kind === kind);
          if (group.length === 0) return null;
          const Meta = KIND_META[kind];
          const Icon = Meta.icon;
          return (
            <div key={kind}>
              <p className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <Icon className="h-3 w-3" />{Meta.label} ({group.length})
              </p>
              <div className="space-y-1">
                {group.map((subject) => {
                  const active = subject.id === selectedId;
                  return (
                    <button
                      key={subject.id}
                      type="button"
                      onClick={() => onSelect(subject.id)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "border border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-200"
                          : "border border-transparent text-slate-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{subject.name}</span>
                      {subject.bindings.length > 0 ? (
                        <span className="flex-shrink-0 rounded-full bg-slate-200/70 px-1.5 text-[10px] text-slate-600 dark:bg-white/10 dark:text-slate-300">{subject.bindings.length}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {visible.length === 0 ? <p className="px-1 text-sm text-slate-500 dark:text-slate-400">No subjects match.</p> : null}
      </div>
    </div>
  );
}

export type { KindFilter };
