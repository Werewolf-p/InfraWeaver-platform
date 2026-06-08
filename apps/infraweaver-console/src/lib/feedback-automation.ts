import "server-only";
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
 * Like feedback-dispatch.ts this is env-driven and FAIL-SAFE: when DISPATCH_URL is
 * unset the read helpers return null and the mutating helpers report `skipped`, so
 * the editor degrades to read-only instead of throwing.
 */
const DISPATCH_URL = process.env.DISPATCH_URL;
const MISSING = "dispatch service not configured (DISPATCH_URL)";
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

interface DispatchCall {
  ok: boolean;
  status: number;
  payload: unknown;
}

async function call(
  pathname: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<DispatchCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(pathname, DISPATCH_URL), {
      ...init,
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** True when the dispatch service is configured (editor is writable). */
export function isAutomationConfigured(): boolean {
  return Boolean(DISPATCH_URL);
}

export async function getPipeline(): Promise<Pipeline | null> {
  if (!DISPATCH_URL) return null;
  try {
    const { ok, payload } = await call("/pipeline", { method: "GET" }, QUICK_TIMEOUT_MS);
    return ok && payload ? (payload as Pipeline) : null;
  } catch {
    return null;
  }
}

export async function savePipeline(pipeline: unknown): Promise<AutomationResult<Pipeline>> {
  if (!DISPATCH_URL) return { ok: false, skipped: true, error: MISSING };
  try {
    const { ok, payload } = await call(
      "/pipeline",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pipeline),
      },
      QUICK_TIMEOUT_MS,
    );
    const body = payload as { ok?: boolean; pipeline?: Pipeline; error?: string } | null;
    if (!ok || !body?.ok) {
      return { ok: false, error: body?.error ?? "Failed to save pipeline" };
    }
    return { ok: true, data: body.pipeline };
  } catch (error) {
    return { ok: false, error: message(error, "Failed to save pipeline") };
  }
}

export async function resetPipeline(): Promise<AutomationResult<Pipeline>> {
  if (!DISPATCH_URL) return { ok: false, skipped: true, error: MISSING };
  try {
    const { ok, payload } = await call("/pipeline/reset", { method: "POST" }, QUICK_TIMEOUT_MS);
    const body = payload as { ok?: boolean; pipeline?: Pipeline } | null;
    if (!ok || !body?.ok) return { ok: false, error: "Failed to reset pipeline" };
    return { ok: true, data: body.pipeline };
  } catch (error) {
    return { ok: false, error: message(error, "Failed to reset pipeline") };
  }
}

export async function getSpecialists(): Promise<SpecialistLibrary | null> {
  if (!DISPATCH_URL) return null;
  try {
    const { ok, payload } = await call("/specialists", { method: "GET" }, QUICK_TIMEOUT_MS);
    return ok && payload ? (payload as SpecialistLibrary) : null;
  } catch {
    return null;
  }
}

export async function refreshSpecialists(
  repo?: string,
): Promise<AutomationResult<SpecialistLibrary>> {
  if (!DISPATCH_URL) return { ok: false, skipped: true, error: MISSING };
  try {
    const { payload } = await call(
      "/specialists/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(repo ? { repo } : {}),
      },
      REFRESH_TIMEOUT_MS,
    );
    const body = payload as
      | { ok?: boolean; error?: string; cache?: SpecialistLibrary }
      | null;
    if (!body?.ok) {
      return { ok: false, error: body?.error ?? "Refresh failed", data: body?.cache };
    }
    return { ok: true, data: body.cache };
  } catch (error) {
    return { ok: false, error: message(error, "Refresh failed") };
  }
}

export async function getCatalog(): Promise<AutomationCatalog | null> {
  if (!DISPATCH_URL) return null;
  try {
    const { ok, payload } = await call("/catalog", { method: "GET" }, QUICK_TIMEOUT_MS);
    return ok && payload ? (payload as AutomationCatalog) : null;
  } catch {
    return null;
  }
}
