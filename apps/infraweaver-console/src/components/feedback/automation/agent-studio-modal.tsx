"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, RotateCcw, Save } from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import {
  makeEmptyStep,
  validatePipeline,
  type AutomationCatalog,
  type Pipeline,
  type PipelineStep,
  type Specialist,
  type SpecialistLibrary,
} from "@/lib/feedback-automation-types";
import { PipelineStepCard } from "@/components/feedback/automation/pipeline-step-card";

const PIPELINE_PATH = "/api/feedback/automation/pipeline";
const CATALOG_PATH = "/api/feedback/automation/catalog";
const SPECIALISTS_PATH = "/api/feedback/automation/specialists";
const REFRESH_PATH = "/api/feedback/automation/specialists/refresh";
const RESET_PATH = "/api/feedback/automation/pipeline/reset";

const EMPTY_CATALOG: AutomationCatalog = { agents: ["claude"], tools: [], models: [""], mcp: [] };

interface AgentStudioModalProps {
  open: boolean;
  onClose: () => void;
}

interface StudioData {
  pipeline: Pipeline | null;
  catalog: AutomationCatalog | null;
  library: SpecialistLibrary | null;
}

/**
 * Agent Studio — the n8n-style editor for the feedback auto-fix pipeline. Admins
 * configure the ordered steps (prompt / agent / model / specialism / tools / MCP)
 * that the dispatch service runs on /approve. Degrades to a read-only notice when
 * the dispatch service isn't configured.
 */
export function AgentStudioModal({ open, onClose }: AgentStudioModalProps) {
  const { data, isLoading, error } = useQuery<StudioData>({
    queryKey: ["feedback-automation", "studio"],
    enabled: open,
    queryFn: async () => {
      const [pipelineRes, catalogRes, specialistsRes] = await Promise.all([
        apiClient.get<{ pipeline: Pipeline | null }>(PIPELINE_PATH),
        apiClient.get<{ catalog: AutomationCatalog | null }>(CATALOG_PATH),
        apiClient.get<{ library: SpecialistLibrary | null }>(SPECIALISTS_PATH),
      ]);
      return {
        pipeline: pipelineRes.pipeline,
        catalog: catalogRes.catalog,
        library: specialistsRes.library,
      };
    },
  });

  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [library, setLibrary] = useState<Specialist[]>([]);
  const [busy, setBusy] = useState<"" | "save" | "reset" | "refresh">("");

  // Seed local editor state whenever a fresh pipeline/library loads.
  useEffect(() => {
    if (data?.pipeline) setSteps(data.pipeline.steps);
  }, [data?.pipeline]);
  useEffect(() => {
    if (data?.library) setLibrary(data.library.items);
  }, [data?.library]);

  const catalog = data?.catalog ?? EMPTY_CATALOG;
  const configured = Boolean(data?.catalog);
  const editing = busy !== "";

  const updateStep = (index: number, next: PipelineStep) =>
    setSteps((current) => current.map((step, i) => (i === index ? next : step)));
  const removeStep = (index: number) =>
    setSteps((current) => current.filter((_, i) => i !== index));
  const addStep = () => setSteps((current) => [...current, makeEmptyStep(current.length)]);

  async function save() {
    const pipeline: Pipeline = { version: 1, steps };
    const problem = validatePipeline(pipeline);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy("save");
    try {
      const { pipeline: saved } = await apiClient.put<{ pipeline: Pipeline }>(PIPELINE_PATH, {
        json: pipeline,
      });
      if (saved) setSteps(saved.steps);
      toast.success("Pipeline saved");
    } catch (saveError) {
      toast.error(toApiErrorMessage(saveError, "Failed to save pipeline"));
    } finally {
      setBusy("");
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const { pipeline } = await apiClient.post<{ pipeline: Pipeline }>(RESET_PATH);
      if (pipeline) setSteps(pipeline.steps);
      toast.success("Pipeline reset to default");
    } catch (resetError) {
      toast.error(toApiErrorMessage(resetError, "Failed to reset"));
    } finally {
      setBusy("");
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      const { library: refreshed } = await apiClient.post<{ library: SpecialistLibrary }>(
        REFRESH_PATH,
      );
      if (refreshed) setLibrary(refreshed.items);
      toast.success("Specialist library refreshed from GitHub");
    } catch (refreshError) {
      toast.error(toApiErrorMessage(refreshError, "Refresh failed"));
    } finally {
      setBusy("");
    }
  }

  const footer = useMemo(
    () => (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          onClick={refresh}
          disabled={!configured || editing}
        >
          {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh library from GitHub
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          onClick={reset}
          disabled={!configured || editing}
        >
          {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Reset to default
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={save}
          disabled={!configured || editing}
        >
          {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save pipeline
        </button>
      </div>
    ),
    [busy, configured, editing, steps],
  );

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      title="Agent Studio — auto-fix pipeline"
      description="Control the steps Claude runs to fix approved feedback: prompts, agent, specialism, tools and plugins. Saved changes apply to the next approved fix."
      size="lg"
      footer={configured ? footer : undefined}
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pipeline…
        </div>
      ) : error ? (
        <p className="py-6 text-sm text-destructive">{toApiErrorMessage(error)}</p>
      ) : !configured ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
          The dispatch service isn&apos;t configured, so the pipeline can&apos;t be edited here.
        </p>
      ) : (
        <div className="space-y-3">
          {steps.map((step, index) => (
            <PipelineStepCard
              key={`${step.id}-${index}`}
              step={step}
              index={index}
              catalog={catalog}
              specialists={library}
              onChange={(next) => updateStep(index, next)}
              onRemove={() => removeStep(index)}
            />
          ))}
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-sm text-muted-foreground hover:bg-muted"
            onClick={addStep}
          >
            <Plus className="h-4 w-4" /> New step
          </button>
        </div>
      )}
    </ResponsiveSheet>
  );
}

export default AgentStudioModal;
