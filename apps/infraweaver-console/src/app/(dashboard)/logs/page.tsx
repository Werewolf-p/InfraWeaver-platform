"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, FileText, Globe, PanelLeftClose, PanelLeftOpen, Rows3 } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { LogStreamViewer } from "@/components/logs/log-stream-viewer";
import { PodSelectorTree } from "@/components/logs/pod-selector-tree";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { useCluster } from "@/contexts/cluster-context";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePods } from "@/hooks/use-pods";
import { useRBAC } from "@/hooks/use-rbac";
import { useMediaQuery } from "@/hooks/use-media-query";

const STORAGE_KEY = "infraweaver:logs-selection";

interface StoredSelection {
  namespace: string;
  pod: string;
  container: string;
}

function loadStoredSelection(): StoredSelection {
  if (typeof window === "undefined") {
    return { namespace: "", pod: "", container: "" };
  }

  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredSelection | null) ?? {
      namespace: "",
      pod: "",
      container: "",
    };
  } catch {
    return { namespace: "", pod: "", container: "" };
  }
}

function podPriority(status: string) {
  const value = status.toLowerCase();
  if (value.includes("crashloop") || value.includes("backoff") || value.includes("failed") || value.includes("error")) return 0;
  if (value.includes("pending") || value.includes("containercreating")) return 1;
  if (value.includes("running")) return 2;
  return 3;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export default function LogsPage() {
  const { activeId } = useCluster();
  const { canAny } = useRBAC();
  const { data: pods = [], isLoading } = usePods();
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery("(max-width: 1024px)");
  const [search, setSearch] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);

  const querySelection = useMemo(() => ({
    namespace: searchParams.get("namespace") ?? "",
    pod: searchParams.get("pod") ?? "",
    container: searchParams.get("container") ?? "",
  }), [searchParams]);
  const [selection, setSelection] = useState<StoredSelection>(() => (
    querySelection.namespace && querySelection.pod ? querySelection : loadStoredSelection()
  ));

  const selectedPod = useMemo(() => {
    const currentSelection = pods.find((pod) => pod.namespace === selection.namespace && pod.name === selection.pod);
    if (currentSelection) return currentSelection;

    const queryPod = querySelection.namespace && querySelection.pod
      ? pods.find((pod) => pod.namespace === querySelection.namespace && pod.name === querySelection.pod)
      : null;
    if (queryPod) return queryPod;

    return [...pods].sort((left, right) => {
      const priority = podPriority(left.status) - podPriority(right.status);
      if (priority !== 0) return priority;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })[0] ?? null;
  }, [pods, querySelection, selection.namespace, selection.pod]);
  const activeContainer = selectedPod?.containers.includes(selection.container)
    ? selection.container
    : querySelection.container && selectedPod?.containers.includes(querySelection.container)
      ? querySelection.container
      : (selectedPod?.containers[0] ?? "");
  const visiblePods = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...pods]
      .filter((pod) => (
        !query ||
        pod.name.toLowerCase().includes(query) ||
        pod.namespace.toLowerCase().includes(query) ||
        pod.status.toLowerCase().includes(query)
      ))
      .sort((left, right) => {
        const namespaceOrder = left.namespace.localeCompare(right.namespace);
        if (namespaceOrder !== 0) return namespaceOrder;
        return left.name.localeCompare(right.name);
      });
  }, [pods, search]);
  const selectedVisibleIndex = useMemo(
    () => (selectedPod ? visiblePods.findIndex((pod) => pod.namespace === selectedPod.namespace && pod.name === selectedPod.name) : -1),
    [selectedPod, visiblePods],
  );

  useEffect(() => {
    if (!selectedPod) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        namespace: selectedPod.namespace,
        pod: selectedPod.name,
        container: activeContainer,
      })
    );
  }, [activeContainer, selectedPod]);

  const handleSelectPod = useCallback((pod: (typeof pods)[number]) => {
    setSelection({
      namespace: pod.namespace,
      pod: pod.name,
      container: pod.containers[0] ?? "",
    });
    if (isMobile) {
      setSelectorOpen(false);
    }
  }, [isMobile]);

  const moveSelection = useCallback((offset: number) => {
    if (visiblePods.length === 0) return;
    const fallbackIndex = selectedVisibleIndex >= 0 ? selectedVisibleIndex : 0;
    const nextIndex = Math.min(visiblePods.length - 1, Math.max(0, fallbackIndex + offset));
    const nextPod = visiblePods[nextIndex];
    if (nextPod) {
      handleSelectPod(nextPod);
    }
  }, [handleSelectPod, selectedVisibleIndex, visiblePods]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "[") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        moveSelection(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveSelection]);

  if (activeId === "all") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Globe className="mb-4 h-10 w-10 text-gray-700 dark:text-[#333]" />
        <p className="text-sm font-medium text-gray-400 dark:text-[#666]">Select a specific cluster to view this page</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-[#444]">Use the cluster selector in the top bar</p>
      </div>
    );
  }

  if (!canAny(["cluster:read", "infra:read"])) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-center">
        <AlertCircle className="mb-3 h-8 w-8 text-red-400" />
        <h3 className="mb-1 font-semibold text-gray-900 dark:text-white">Access denied</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">You need cluster:read or infra:read permission to view pod logs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        title="Pod Logs"
        subtitle="Split-view pod selector with remembered filters and smart defaults"
        actions={
          <button
            onClick={() => (isMobile ? setSelectorOpen(true) : setLeftCollapsed((current) => !current))}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white"
          >
            {isMobile ? <Rows3 className="h-4 w-4" /> : leftCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {isMobile ? "Select pod" : leftCollapsed ? "Show selector" : "Hide selector"}
          </button>
        }
      />

      <div className="flex items-center justify-between rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Current target</p>
          <p className="mt-1 text-sm text-gray-900 dark:text-white">
            {selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : "No pod selected"}
          </p>
          {selectedPod ? (
            <p className="mt-1 text-xs text-slate-500">
              {selectedVisibleIndex >= 0 ? `${selectedVisibleIndex + 1} of ${visiblePods.length} visible` : `${visiblePods.length} visible`} · press [ or ] to move between pods
            </p>
          ) : null}
          {!selectedPod && !isLoading ? <p className="mt-1 text-xs text-slate-500">Pick a pod from the selector to start streaming.</p> : null}
        </div>
        {selectedPod ? <StatusBadge status={(selectedPod.status.toLowerCase() as "running" | "pending" | "failed" | "unknown") ?? "unknown"} /> : null}
      </div>

      {isMobile ? (
        <div className="min-h-[70vh] rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-4">
          <LogStreamViewer
            namespace={selectedPod?.namespace}
            pod={selectedPod?.name}
            container={activeContainer}
            containers={selectedPod?.containers ?? []}
            onContainerChange={(container) => setSelection((current) => ({ ...current, container }))}
          />
        </div>
      ) : (
        <div className="h-[70vh] min-h-[620px] overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40">
          <PanelGroup orientation="horizontal">
            {!leftCollapsed && (
              <>
                <Panel defaultSize={24} minSize={18}>
                  <PodSelectorTree
                    pods={pods}
                    search={search}
                    onSearchChange={setSearch}
                    selectedKey={selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : undefined}
                    onSelect={handleSelectPod}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-100 dark:bg-white/10 transition hover:bg-indigo-500/50" />
              </>
            )}
            <Panel defaultSize={leftCollapsed ? 100 : 76} minSize={40}>
              <div className="flex h-full min-h-0 flex-col p-4">
                <LogStreamViewer
                  namespace={selectedPod?.namespace}
                  pod={selectedPod?.name}
                  container={activeContainer}
                  containers={selectedPod?.containers ?? []}
                  onContainerChange={(container) => setSelection((current) => ({ ...current, container }))}
                />
              </div>
            </Panel>
          </PanelGroup>
        </div>
      )}

      <BottomSheet open={selectorOpen && isMobile} onClose={() => setSelectorOpen(false)} title="Select pod">
        <div className="h-[70vh] min-h-0">
          <PodSelectorTree
            pods={pods}
            search={search}
            onSearchChange={setSearch}
            selectedKey={selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : undefined}
            onSelect={handleSelectPod}
          />
        </div>
      </BottomSheet>

      {isLoading ? <div className="text-sm text-slate-500">Loading pods…</div> : null}
    </div>
  );
}
