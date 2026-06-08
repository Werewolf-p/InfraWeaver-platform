"use client";

import { GripVertical, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  AutomationCatalog,
  PipelineStep,
  Specialist,
} from "@/lib/feedback-automation-types";

interface PipelineStepCardProps {
  step: PipelineStep;
  index: number;
  catalog: AutomationCatalog;
  specialists: Specialist[];
  onChange: (step: PipelineStep) => void;
  onRemove: () => void;
}

const labelClass = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/** Toggle one value in/out of a string array immutably. */
function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function PipelineStepCard({
  step,
  index,
  catalog,
  specialists,
  onChange,
  onRemove,
}: PipelineStepCardProps) {
  const update = (patch: Partial<PipelineStep>) => onChange({ ...step, ...patch });

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-border bg-card p-3",
        !step.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-semibold text-muted-foreground">{index + 1}</span>
        <input
          className={cn(inputClass, "flex-1 font-medium")}
          value={step.name}
          maxLength={60}
          placeholder="Step name"
          aria-label="Step name"
          onChange={(event) => update({ name: event.target.value })}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={step.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove step"
          title="Remove"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <span className={labelClass}>Agent</span>
          <select
            className={inputClass}
            value={step.agent}
            onChange={(event) => update({ agent: event.target.value })}
          >
            {catalog.agents.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <span className={labelClass}>Model</span>
          <select
            className={inputClass}
            value={step.model}
            onChange={(event) => update({ model: event.target.value })}
          >
            {catalog.models.map((model) => (
              <option key={model || "default"} value={model}>
                {model || "Agent default"}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <span className={labelClass}>Specialism</span>
          <select
            className={inputClass}
            value={step.specialism}
            onChange={(event) => update({ specialism: event.target.value })}
          >
            <option value="">No specialism</option>
            {specialists.map((specialist) => (
              <option key={specialist.id} value={specialist.id}>
                {specialist.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <span className={labelClass}>Prompt</span>
        <textarea
          className={cn(inputClass, "min-h-[120px] font-mono text-xs leading-relaxed")}
          value={step.promptTemplate}
          maxLength={8000}
          placeholder="What this step should do. Placeholders: {{description}}, {{pagePath}}, {{type}}, {{previousOutput}}"
          onChange={(event) => update({ promptTemplate: event.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <span className={labelClass}>Allowed tools</span>
          <div className="flex flex-wrap gap-1.5">
            {catalog.tools.map((tool) => (
              <label
                key={tool}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-0.5 text-xs",
                  step.allowedTools.includes(tool)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={step.allowedTools.includes(tool)}
                  onChange={() => update({ allowedTools: toggle(step.allowedTools, tool) })}
                />
                {tool}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1.5">
          <span className={labelClass}>MCP servers (plugins)</span>
          <div className="flex flex-wrap gap-1.5">
            {catalog.mcp.map((server) => (
              <label
                key={server}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-0.5 text-xs",
                  step.mcpServers.includes(server)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={step.mcpServers.includes(server)}
                  onChange={() => update({ mcpServers: toggle(step.mcpServers, server) })}
                />
                {server}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={step.continueOnError}
          onChange={(event) => update({ continueOnError: event.target.checked })}
        />
        Continue if this step fails
      </label>
    </div>
  );
}
