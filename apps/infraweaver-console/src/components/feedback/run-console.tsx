"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Radio, Terminal } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** A dispatch run record (audit history entry). Mirrors the dispatch service. */
interface DispatchRun {
  runId: string;
  feedbackId: string;
  kind: string;
  phase: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  previewUrl: string | null;
  tag: string | null;
  commit: string | null;
  error?: string;
}

interface RunConsoleProps {
  feedbackId: string;
}

const STATUS_DOT: Record<DispatchRun["status"], string> = {
  running: "bg-amber-500 animate-pulse",
  success: "bg-emerald-500",
  failed: "bg-rose-500",
};

function formatDuration(start: string, end: string | null): string {
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Log pane for a single run. Mounted with a `key={run.runId}` so switching runs
 * remounts it — state initialises fresh and we never reset state inside an
 * effect. While the run is active it streams the dispatch SSE; otherwise it
 * loads the static transcript. setState only happens in async callbacks/handlers.
 */
function RunLog({
  feedbackId,
  run,
  onDone,
}: {
  feedbackId: string;
  run: DispatchRun;
  onDone: () => void;
}) {
  const live = run.status === "running";
  const [logText, setLogText] = useState("");
  const [livePhase, setLivePhase] = useState<string | null>(live ? run.phase : null);
  const [streaming, setStreaming] = useState(live);
  const boxRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!live) {
      let cancelled = false;
      apiClient
        .get<{ log: string }>(`/api/feedback/${feedbackId}/runs/${run.runId}/log`)
        .then((res) => {
          if (!cancelled) setLogText(res.log ?? "");
        })
        .catch(() => {
          if (!cancelled) setLogText("(failed to load transcript)");
        });
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(`/api/feedback/${feedbackId}/runs/${run.runId}/stream`);
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { log?: string };
        if (parsed.log) setLogText((prev) => prev + parsed.log);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener("phase", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { phase?: string };
        if (parsed.phase) setLivePhase(parsed.phase);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", () => {
      setStreaming(false);
      es.close();
      onDone();
    });
    es.onerror = () => {
      setStreaming(false);
      es.close();
    };
    return () => es.close();
  }, [live, feedbackId, run.runId, onDone]);

  // Keep the pane pinned to the newest output while streaming.
  useEffect(() => {
    if (streaming && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logText, streaming]);

  return (
    <>
      <div className="mb-1 flex items-center justify-between text-[10px] text-gray-400 dark:text-[#666]">
        <span>
          {run.kind} · {run.status}
          {streaming && livePhase ? ` · ${livePhase}` : ""}
        </span>
        {run.previewUrl && (
          <a href={run.previewUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
            preview
          </a>
        )}
      </div>
      <pre
        ref={boxRef}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-950 p-2 font-mono text-[10px] leading-relaxed text-gray-200"
      >
        {streaming && !logText ? (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <Loader2 className="h-3 w-3 animate-spin" /> waiting for output…
          </span>
        ) : (
          logText || "(no output)"
        )}
      </pre>
    </>
  );
}

/**
 * Live progress + audit history for an entry's dispatch runs. While a run is
 * active it streams Claude's plan→validate→implement→build→deploy output (SSE);
 * finished runs collapse to a replayable history list for auditing.
 */
export function RunConsole({ feedbackId }: RunConsoleProps) {
  const [open, setOpen] = useState(false);
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ["feedback", "runs", feedbackId],
    queryFn: () => apiClient.get<{ runs: DispatchRun[] }>(`/api/feedback/${feedbackId}/runs`),
    enabled: open,
    // Poll the history while any run is active so a freshly-started run appears.
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => r.status === "running") ? 4000 : false,
  });

  const runs = useMemo(() => data?.runs ?? [], [data]);
  const activeRun = useMemo(() => runs.find((r) => r.status === "running"), [runs]);

  // Derive the shown run (no setState-in-effect): user's pin if still valid,
  // else the active run, else the newest.
  const selectedRun = useMemo(() => {
    if (pinnedRunId) {
      const pinned = runs.find((r) => r.runId === pinnedRunId);
      if (pinned) return pinned;
    }
    return activeRun ?? runs[0] ?? null;
  }, [pinnedRunId, runs, activeRun]);

  const handleDone = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <div className="mt-3 rounded-lg border border-gray-200 dark:border-[#262626]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:text-[#aaa] dark:hover:bg-[#1d1d1d]"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Terminal className="h-3.5 w-3.5" />
        Progress / logs
        {activeRun && (
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-300">
            <Radio className="h-3 w-3 animate-pulse" /> {activeRun.phase}
          </span>
        )}
        {!activeRun && runs.length > 0 && (
          <span className="ml-1 text-[10px] text-gray-400 dark:text-[#666]">
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-gray-200 px-3 py-2 dark:border-[#262626]">
          {runs.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-gray-400 dark:text-[#555]">No runs recorded yet.</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {runs.map((run) => (
                  <button
                    key={run.runId}
                    type="button"
                    onClick={() => setPinnedRunId(run.runId)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition",
                      selectedRun?.runId === run.runId
                        ? "border-gray-400 bg-gray-100 text-gray-800 dark:border-[#444] dark:bg-[#222] dark:text-white"
                        : "border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d]",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[run.status])} />
                    {run.kind}
                    <span className="text-gray-400 dark:text-[#666]">{formatDuration(run.startedAt, run.finishedAt)}</span>
                  </button>
                ))}
              </div>

              {selectedRun && <RunLog key={selectedRun.runId} feedbackId={feedbackId} run={selectedRun} onDone={handleDone} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default RunConsole;
