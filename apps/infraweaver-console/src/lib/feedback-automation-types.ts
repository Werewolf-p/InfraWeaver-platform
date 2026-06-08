/**
 * Shared, client-safe types and pure helpers for the Agent Studio pipeline editor.
 *
 * The auto-fix pipeline is the ordered list of agent "steps" the dispatch service
 * runs on /approve (plan → validate → implement by default). This module holds the
 * wire shapes the console and the dispatch service agree on, plus a few pure
 * helpers the modal and its unit test share. It is deliberately free of
 * `server-only` and of any I/O so the client component and Jest can both import it.
 *
 * The authoritative validation lives in the dispatch service (pipeline-store.js);
 * these helpers only mirror enough of it to give the editor fast, friendly
 * feedback before a save round-trips.
 */

/** One agent run in the pipeline. Mirrors dispatch pipeline-store.js. */
export interface PipelineStep {
  id: string;
  name: string;
  enabled: boolean;
  agent: string;
  /** "" means the agent's default model. */
  model: string;
  /** Specialist id whose system prompt is appended; "" means none. */
  specialism: string;
  promptTemplate: string;
  allowedTools: string[];
  mcpServers: string[];
  continueOnError: boolean;
}

export interface Pipeline {
  version: number;
  steps: PipelineStep[];
}

/** A specialist prompt the operator can append to a step. */
export interface Specialist {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  category: string;
}

export interface SpecialistLibrary {
  updatedAt: string;
  source: string;
  items: Specialist[];
}

/** The option catalogs the editor renders its pickers from. */
export interface AutomationCatalog {
  agents: string[];
  tools: string[];
  models: string[];
  mcp: string[];
}

export const MAX_STEPS = 12;
export const MAX_PROMPT_LENGTH = 8000;

/** A fresh, enabled step with safe defaults, ready to drop into the editor. */
export function makeEmptyStep(index: number): PipelineStep {
  return {
    id: `step-${index + 1}`,
    name: `Step ${index + 1}`,
    enabled: true,
    agent: "claude",
    model: "",
    specialism: "",
    promptTemplate: "",
    allowedTools: ["Read", "Grep", "Glob"],
    mcpServers: [],
    continueOnError: false,
  };
}

/**
 * Coerce a raw step into a safe, well-typed shape, dropping any tool/mcp value not
 * present in the catalog so a stale editor can never submit an unknown option.
 */
export function normalizeStep(
  raw: Partial<PipelineStep>,
  index: number,
  catalog?: AutomationCatalog,
): PipelineStep {
  const base = makeEmptyStep(index);
  const tools = Array.isArray(raw.allowedTools) ? raw.allowedTools : base.allowedTools;
  const mcp = Array.isArray(raw.mcpServers) ? raw.mcpServers : base.mcpServers;
  return {
    id: (raw.id || base.id).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || base.id,
    name: (raw.name ?? base.name).slice(0, 60) || base.name,
    enabled: raw.enabled !== false,
    agent: raw.agent || base.agent,
    model: raw.model ?? "",
    specialism: (raw.specialism ?? "").slice(0, 80),
    promptTemplate: (raw.promptTemplate ?? "").slice(0, MAX_PROMPT_LENGTH),
    allowedTools: catalog ? tools.filter((t) => catalog.tools.includes(t)) : tools,
    mcpServers: catalog ? mcp.filter((m) => catalog.mcp.includes(m)) : mcp,
    continueOnError: Boolean(raw.continueOnError),
  };
}

/**
 * Validate a pipeline the way the editor's Save button does. Returns a
 * user-facing error message, or null when the pipeline is safe to persist.
 */
export function validatePipeline(pipeline: Pipeline): string | null {
  if (!pipeline.steps.length || pipeline.steps.length > MAX_STEPS) {
    return `A pipeline needs between 1 and ${MAX_STEPS} steps`;
  }
  if (!pipeline.steps.some((step) => step.enabled)) {
    return "Enable at least one step before saving";
  }
  if (pipeline.steps.some((step) => step.enabled && !step.promptTemplate.trim())) {
    return "Every step needs a prompt";
  }
  return null;
}
