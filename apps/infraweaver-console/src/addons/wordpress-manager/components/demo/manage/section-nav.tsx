"use client";

/**
 * The Manage console's VERTICAL grouped section rail — replaces the old
 * horizontal `tab-rail.tsx`. Sections are clustered into labeled, collapsible
 * groups (Overview · Content · People · Extensions · Configuration · Operations ·
 * Monitoring · Security); only available panels appear, the rest collapse into the
 * trailing "Optional" affordance. Full desktop width, no horizontal scrolling
 * anywhere. WAI-ARIA navigation: a `nav` landmark, `aria-current="page"` on the
 * active section, roving arrow-key focus, `focus-visible` rings.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { tabIcon } from "./tab-icons";
import {
  OPTIONAL_SECTION,
  flattenSections,
  type ManageRailTarget,
  type ManageSectionId,
  type VisibleGroup,
} from "./section-groups";

export function manageSectionButtonId(prefix: string, target: ManageRailTarget): string {
  return `${prefix}-section-${target}`;
}

export interface SectionNavProps {
  readonly groups: readonly VisibleGroup[];
  readonly active: ManageRailTarget;
  readonly onSelect: (target: ManageRailTarget) => void;
  /** Small count badges keyed by section id (e.g. pending updates). */
  readonly badges?: Readonly<Partial<Record<ManageSectionId, number>>>;
  /** How many panels are gated off — drives the trailing "Optional" entry. */
  readonly optionalCount: number;
  /** Stable id namespace so two rendered instances (desktop + mobile) don't collide. */
  readonly idPrefix: string;
  /** The single content panel each section controls (for `aria-controls`). */
  readonly panelId: string;
}

/** Skeleton rail shown while the overview is still resolving. */
export function SectionNavSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[3, 4, 2].map((rows, g) => (
        <div key={g} className="space-y-1.5">
          <div className="h-3 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SectionNav({
  groups,
  active,
  onSelect,
  badges,
  optionalCount,
  idPrefix,
  panelId,
}: SectionNavProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const btnRefs = useRef<Map<ManageRailTarget, HTMLButtonElement>>(new Map());

  const setBtnRef = useCallback((target: ManageRailTarget, el: HTMLButtonElement | null) => {
    if (el) btnRefs.current.set(target, el);
    else btnRefs.current.delete(target);
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // The active section's group is always shown expanded so the current section is
  // never hidden behind a collapsed header.
  const activeGroupId = useMemo(
    () => groups.find((g) => g.sections.some((s) => s.id === active))?.id,
    [groups, active],
  );

  const isGroupOpen = useCallback(
    (groupId: string) => groupId === activeGroupId || !collapsed.has(groupId),
    [activeGroupId, collapsed],
  );

  // Flat, ordered list of currently-focusable targets (sections in open groups,
  // then the Optional entry) — powers roving arrow-key navigation.
  const focusOrder = useMemo<ManageRailTarget[]>(() => {
    const openGroups = groups.filter((g) => isGroupOpen(g.id));
    const ids: ManageRailTarget[] = flattenSections(openGroups);
    if (optionalCount > 0) ids.push(OPTIONAL_SECTION);
    return ids;
  }, [groups, isGroupOpen, optionalCount]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const { key } = event;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
      if (focusOrder.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, focusOrder.indexOf(active));
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? focusOrder.length - 1
            : key === "ArrowDown"
              ? (current + 1) % focusOrder.length
              : (current - 1 + focusOrder.length) % focusOrder.length;
      const target = focusOrder[next];
      if (target === undefined) return;
      onSelect(target);
      btnRefs.current.get(target)?.focus();
    },
    [active, focusOrder, onSelect],
  );

  return (
    <nav aria-label="Manage sections" onKeyDown={onKeyDown} className="space-y-4">
      {groups.map((group) => {
        const GroupIcon = tabIcon(group.icon);
        const open = isGroupOpen(group.id);
        const contentId = `${idPrefix}-group-${group.id}`;
        return (
          <div key={group.id}>
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={open}
              aria-controls={contentId}
              className="group/head flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold text-zinc-500 transition-colors hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              <GroupIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="flex-1 text-left">{group.label}</span>
              <ChevronDown
                className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open ? "rotate-0" : "-rotate-90")}
                aria-hidden
              />
            </button>
            {open ? (
              <ul id={contentId} className="mt-1 space-y-0.5">
                {group.sections.map((section) => {
                  const Icon = tabIcon(section.icon);
                  const selected = section.id === active;
                  const badge = badges?.[section.id];
                  return (
                    <li key={section.id}>
                      <button
                        ref={(el) => setBtnRef(section.id, el)}
                        type="button"
                        id={manageSectionButtonId(idPrefix, section.id)}
                        aria-controls={panelId}
                        aria-current={selected ? "page" : undefined}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onSelect(section.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50",
                          selected
                            ? "bg-sky-500/10 font-medium text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/30"
                            : "font-normal text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4 shrink-0",
                            selected ? "text-sky-600 dark:text-sky-400" : "text-zinc-400 dark:text-zinc-500",
                          )}
                          aria-hidden
                        />
                        <span className="flex-1 truncate text-left">{section.label}</span>
                        {badge !== undefined && badge > 0 ? (
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                              selected
                                ? "bg-sky-500/20 text-sky-700 dark:text-sky-200"
                                : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                            )}
                            aria-label={`${badge} pending`}
                          >
                            {badge}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}

      {optionalCount > 0 ? (
        <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <button
            ref={(el) => setBtnRef(OPTIONAL_SECTION, el)}
            type="button"
            id={manageSectionButtonId(idPrefix, OPTIONAL_SECTION)}
            aria-controls={panelId}
            aria-current={active === OPTIONAL_SECTION ? "page" : undefined}
            tabIndex={active === OPTIONAL_SECTION ? 0 : -1}
            onClick={() => onSelect(OPTIONAL_SECTION)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50",
              active === OPTIONAL_SECTION
                ? "border-zinc-300 bg-zinc-100 font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200",
            )}
          >
            <Plus className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
            <span className="flex-1 text-left">Optional</span>
            <span className="shrink-0 rounded-full bg-zinc-200/80 px-1.5 text-[10px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {optionalCount}
            </span>
          </button>
        </div>
      ) : null}
    </nav>
  );
}
