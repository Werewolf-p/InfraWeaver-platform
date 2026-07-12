import "server-only";
import { dispatchGet, dispatchMutate } from "@/lib/dispatch-client";
import type {
  AutomationCatalog,
  Pipeline,
  SpecialistLibrary,
} from "@/lib/feedback-automation-types";

/**
 * Server-side client for the dispatch service's Agent Studio endpoints.
 *
 * Agent Studio is the editable, n8n-style auto-fix pipeline: the operator defines
 * the ordered agent steps (prompt / agent / model / specialism / tool allowlist /
 * MCP plugins) the dispatch service runs on /approve. These helpers proxy the
 * dispatch endpoints that back the console's pipeline editor:
 *
 *   GET  /pipeline            current pipeline definition
 *   PUT  /pipeline            save an edited pipeline
 *   POST /pipeline/reset      restore the default plan→validate→implement pipeline
 *   GET  /specialists         the specialist-prompt library
 *   POST /specialists/refresh refresh the library from a public GitHub repo
 *   GET  /catalog             the option catalogs (agents/tools/models/mcp)
 *
 * Transport, HMAC signing of mutations, and the FAIL-SAFE posture live in
 * `@/lib/dispatch-client`: when DISPATCH_URL is unset the read helpers return
 * null and the mutating helpers report `skipped`, so the editor degrades to
 * read-only instead of throwing.
 */
// Quick config reads; the GitHub-backed library refresh is allowed longer.
const QUICK_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 60_000;

export type {
  AutomationCatalog,
  Pipeline,
  PipelineStep,
  Specialist,
  SpecialistLibrary,
} from "@/lib/feedback-automation-types";

/** Result of a mutating Agent Studio call. */
export interface AutomationResult<T> {
  ok: boolean;
  /** True when DISPATCH_URL is unset — nothing was attempted. */
  skipped?: boolean;
  error?: string;
  data?: T;
}

/** True when the dispatch service is configured (editor is writable). */
export { isDispatchConfigured as isAutomationConfigured } from "@/lib/dispatch-client";

export async function getPipeline(): Promise<Pipeline | null> {
  return dispatchGet<Pipeline>("/pipeline", { timeoutMs: QUICK_TIMEOUT_MS });
}

export async function savePipeline(pipeline: unknown): Promise<AutomationResult<Pipeline>> {
  const result = await dispatchMutate<{ pipeline?: Pipeline }>(
    "/pipeline",
    pipeline as Record<string, unknown>,
    { method: "PUT", timeoutMs: QUICK_TIMEOUT_MS },
  );
  if (!result.ok) return { ok: false, skipped: result.skipped, error: result.error ?? "Failed to save pipeline" };
  return { ok: true, data: result.data?.pipeline };
}

export async function resetPipeline(): Promise<AutomationResult<Pipeline>> {
  const result = await dispatchMutate<{ pipeline?: Pipeline }>("/pipeline/reset", {}, { timeoutMs: QUICK_TIMEOUT_MS });
  if (!result.ok) return { ok: false, skipped: result.skipped, error: result.error ?? "Failed to reset pipeline" };
  return { ok: true, data: result.data?.pipeline };
}

export async function getSpecialists(): Promise<SpecialistLibrary | null> {
  return dispatchGet<SpecialistLibrary>("/specialists", { timeoutMs: QUICK_TIMEOUT_MS });
}

export async function refreshSpecialists(
  repo?: string,
): Promise<AutomationResult<SpecialistLibrary>> {
  const result = await dispatchMutate<{ cache?: SpecialistLibrary }>(
    "/specialists/refresh",
    repo ? { repo } : {},
    { timeoutMs: REFRESH_TIMEOUT_MS },
  );
  if (!result.ok) {
    return { ok: false, skipped: result.skipped, error: result.error ?? "Refresh failed", data: result.data?.cache };
  }
  return { ok: true, data: result.data?.cache };
}

export async function getCatalog(): Promise<AutomationCatalog | null> {
  return dispatchGet<AutomationCatalog>("/catalog", { timeoutMs: QUICK_TIMEOUT_MS });
}
