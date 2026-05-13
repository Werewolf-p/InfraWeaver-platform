"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FileText, PanelLeftClose, PanelLeftOpen, Rows3 } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { LogStreamViewer } from "@/components/logs/log-stream-viewer";
import { PodSelectorTree } from "@/components/logs/pod-selector-tree";
import { BottomSheet } from "@/components/ui/bottom-sheet";
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

export default function LogsPage() {
  const { canAny } = useRBAC();
  const { data: pods = [], isLoading } = usePods();
  const isMobile = useMediaQuery("(max-width: 1024px)");
  const [search, setSearch] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [selection, setSelection] = useState<StoredSelection>(() => loadStoredSelection());

  const selectedPod = useMemo(
    () => pods.find((pod) => pod.namespace === selection.namespace && pod.name === selection.pod) ?? null,
    [pods, selection.namespace, selection.pod]
  );
  const activeContainer = selectedPod?.containers.includes(selection.container) ? selection.container : (selectedPod?.containers[0] ?? "");

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

  const handleSelectPod = (pod: (typeof pods)[number]) => {
    setSelection({
      namespace: pod.namespace,
      pod: pod.name,
      container: pod.containers[0] ?? "",
    });
    if (isMobile) {
      setSelectorOpen(false);
    }
  };

  if (!canAny(["cluster:read", "infra:read"])) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-center">
        <AlertCircle className="mb-3 h-8 w-8 text-red-400" />
        <h3 className="mb-1 font-semibold text-white">Access denied</h3>
        <p className="text-sm text-slate-400">You need cluster:read or infra:read permission to view pod logs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        title="Pod Logs"
        subtitle="Split-view pod selector with live log streaming"
        actions={
          <button
            onClick={() => (isMobile ? setSelectorOpen(true) : setLeftCollapsed((current) => !current))}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
          >
            {isMobile ? <Rows3 className="h-4 w-4" /> : leftCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {isMobile ? "Select pod" : leftCollapsed ? "Show selector" : "Hide selector"}
          </button>
        }
      />

      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Current target</p>
          <p className="mt-1 text-sm text-white">
            {selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : "No pod selected"}
          </p>
        </div>
        {selectedPod ? <StatusBadge status={(selectedPod.status.toLowerCase() as "running" | "pending" | "failed" | "unknown") ?? "unknown"} /> : null}
      </div>

      {isMobile ? (
        <div className="min-h-[70vh] rounded-2xl border border-white/10 bg-slate-950/40 p-4">
          <LogStreamViewer
            namespace={selectedPod?.namespace}
            pod={selectedPod?.name}
            container={activeContainer}
            containers={selectedPod?.containers ?? []}
            onContainerChange={(container) => setSelection((current) => ({ ...current, container }))}
          />
        </div>
      ) : (
        <div className="h-[70vh] min-h-[620px] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40">
          <PanelGroup orientation="horizontal">
            {!leftCollapsed && (
              <>
                <Panel
                  defaultSize={24}
                  minSize={18}
                >
                  <PodSelectorTree
                    pods={pods}
                    search={search}
                    onSearchChange={setSearch}
                    selectedKey={selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : undefined}
                    onSelect={handleSelectPod}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-white/10 transition hover:bg-indigo-500/50" />
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
