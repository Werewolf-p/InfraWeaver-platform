"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "../motion";
import type { ManagePanelDef, ManagePanelId } from "../../../lib/manage/capabilities";
import { segmentPanelsByGroup } from "./tab-groups";
import { tabIcon } from "./tab-icons";

/** Sentinel tab id for the "Optional (not installed)" surface — never a real panel. */
export const OPTIONAL_TAB = "__optional__";
export type ManageTab = ManagePanelId | typeof OPTIONAL_TAB;

/** Stable id of the single tabpanel every tab controls. */
export const MANAGE_TABPANEL_ID = "manage-tabpanel";
/** Stable id of a tab's button — used to wire `aria-labelledby` on the panel. */
export function manageTabButtonId(tab: ManageTab): string {
  return `manage-tab-${tab}`;
}

/** Shared motion identity for the sliding active-pill (mirrors the app sidebar). */
const ACTIVE_PILL = "manage-tab-indicator";
const PILL_TRANSITION = { duration: 0.24, ease: EASE_OUT } as const;

interface ManageTabRailProps {
  /** Visible panels (already filtered by capability), in catalog order. */
  readonly panels: readonly ManagePanelDef[];
  readonly activeTab: ManageTab;
  /** How many panels are gated off — drives the trailing "Optional" chip. */
  readonly disabledCount: number;
  readonly onSelect: (tab: ManageTab) => void;
  /** True while the overview is still resolving (renders a skeleton rail). */
  readonly loading: boolean;
}

/**
 * The per-site Manage tab strip. Only installed / has-info panels appear as
 * primary tabs (the parent computes that); everything gated off collapses into
 * the trailing "Optional" chip. Related panels are clustered and separated by
 * hairline dividers; the active tab is a soft accent pill that slides between
 * tabs. Fully a WAI-ARIA tablist: roving focus, arrow / Home / End keys, and
 * `aria-selected` on each tab.
 */
export function ManageTabRail({ panels, activeTab, disabledCount, onSelect, loading }: ManageTabRailProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<ManageTab, HTMLButtonElement>>(new Map());
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });

  const setTabRef = useCallback((tab: ManageTab, el: HTMLButtonElement | null) => {
    if (el) tabRefs.current.set(tab, el);
    else tabRefs.current.delete(tab);
  }, []);

  const segments = useMemo(() => segmentPanelsByGroup(panels), [panels]);

  /** Focus/selection order: content tabs, then the Optional chip when present. */
  const order = useMemo<ManageTab[]>(() => {
    const ids: ManageTab[] = panels.map((panel) => panel.id);
    return disabledCount > 0 ? [...ids, OPTIONAL_TAB] : ids;
  }, [panels, disabledCount]);

  // Fade the scroller's edges only when there is more to scroll toward, so the
  // fade doubles as an overflow affordance without a raw scrollbar.
  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateEdges();
    el.addEventListener("scroll", updateEdges, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateEdges) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      observer?.disconnect();
    };
  }, [updateEdges, order.length, loading]);

  // Keep the active tab in view as it changes (click or keyboard). Guarded so a
  // headless/SSR environment without scrollIntoView never throws.
  useEffect(() => {
    const el = tabRefs.current.get(activeTab);
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [activeTab]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { key } = event;
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
      if (order.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, order.indexOf(activeTab));
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? order.length - 1
            : key === "ArrowRight"
              ? (current + 1) % order.length
              : (current - 1 + order.length) % order.length;
      const nextTab = order[next];
      if (nextTab === undefined) return;
      onSelect(nextTab);
      tabRefs.current.get(nextTab)?.focus();
    },
    [activeTab, onSelect, order],
  );

  if (loading) {
    return (
      <div className="mt-5 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-1.5 pb-2.5 pt-1" aria-hidden>
          {[76, 104, 88, 120, 82, 96, 110].map((w, i) => (
            <div
              key={i}
              className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60"
              style={{ width: w }}
            />
          ))}
        </div>
      </div>
    );
  }

  const maskImage = `linear-gradient(to right, ${edges.start ? "transparent" : "#000"} 0, #000 22px, #000 calc(100% - 22px), ${edges.end ? "transparent" : "#000"} 100%)`;

  return (
    <div className="relative mt-5 border-b border-zinc-200 dark:border-zinc-800">
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Manage sections"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        style={{ maskImage, WebkitMaskImage: maskImage }}
        className="flex items-center gap-1 overflow-x-auto scrollbar-none scroll-smooth pb-2.5 pt-1 motion-reduce:scroll-auto"
      >
        {segments.map((segment, segmentIndex) => (
          <Fragment key={segment.group.id}>
            {segmentIndex > 0 ? (
              <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            ) : null}
            {segment.panels.map((panel) => {
              const selected = panel.id === activeTab;
              const Icon = tabIcon(panel.icon);
              return (
                <button
                  key={panel.id}
                  ref={(el) => setTabRef(panel.id, el)}
                  type="button"
                  role="tab"
                  id={manageTabButtonId(panel.id)}
                  aria-controls={MANAGE_TABPANEL_ID}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(panel.id)}
                  className={cn(
                    "group relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/50",
                    selected
                      ? "font-medium text-sky-700 dark:text-sky-300"
                      : "font-normal text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100",
                  )}
                >
                  {selected ? (
                    <motion.span
                      layoutId={ACTIVE_PILL}
                      transition={PILL_TRANSITION}
                      className="absolute inset-0 rounded-lg bg-sky-500/10 ring-1 ring-inset ring-sky-500/25 dark:bg-sky-400/10 dark:ring-sky-400/30"
                    />
                  ) : null}
                  <Icon
                    aria-hidden
                    className={cn(
                      "relative z-10 h-4 w-4 shrink-0 transition-colors",
                      selected
                        ? "text-sky-600 dark:text-sky-400"
                        : "text-zinc-400 group-hover:text-current dark:text-zinc-500",
                    )}
                  />
                  <span className="relative z-10">{panel.label}</span>
                </button>
              );
            })}
          </Fragment>
        ))}

        {disabledCount > 0 ? (
          <>
            <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <OptionalTab
              selected={activeTab === OPTIONAL_TAB}
              count={disabledCount}
              onSelect={() => onSelect(OPTIONAL_TAB)}
              setRef={(el) => setTabRef(OPTIONAL_TAB, el)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

interface OptionalTabProps {
  readonly selected: boolean;
  readonly count: number;
  readonly onSelect: () => void;
  readonly setRef: (el: HTMLButtonElement | null) => void;
}

/** Trailing "not installed" affordance — dashed and quiet so it reads apart from
 *  the live panels, with a running count of what could be enabled. */
function OptionalTab({ selected, count, onSelect, setRef }: OptionalTabProps) {
  return (
    <button
      ref={setRef}
      type="button"
      role="tab"
      id={manageTabButtonId(OPTIONAL_TAB)}
      aria-controls={MANAGE_TABPANEL_ID}
      aria-selected={selected}
      aria-label={`Optional — ${count} not installed`}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-dashed px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/50",
        selected
          ? "border-zinc-300 bg-zinc-100 font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200",
      )}
    >
      <Plus aria-hidden className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
      Optional
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] font-medium tabular-nums",
          selected
            ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
            : "bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
        )}
      >
        {count}
      </span>
    </button>
  );
}
