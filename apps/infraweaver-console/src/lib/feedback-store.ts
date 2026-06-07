import "server-only";
import { randomUUID } from "node:crypto";
import { makeCoreApi } from "@/lib/kube-client";

/**
 * Server-side persistence for in-console developer feedback ("report button").
 *
 * State lives in a single ConfigMap (`infraweaver-feedback`) in the console
 * namespace, mirroring the ConfigMap-backed pattern used by access-store.ts.
 * Entries are serialized as a JSON string under the `entries` key so the data
 * is human-inspectable via kubectl. Nothing here auto-executes: entries are
 * captured, then a human approves them before any downstream automation runs.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.FEEDBACK_CONFIGMAP_NAME ?? "infraweaver-feedback";

export type FeedbackType = "bug" | "feature-request" | "note";
export type FeedbackSeverity = "low" | "medium" | "high" | "critical";

/**
 * Lifecycle of a feedback entry. Nothing past `new` happens without a human.
 *  new        — submitted, awaiting admin review
 *  approved   — admin approved; dispatch run kicked off (transient)
 *  dispatched — agent ran + preview built; awaiting reviewer verdict
 *  accepted   — reviewer accepted the fix; commit stays on feedback/staging
 *               until a Publish drains the branch to main
 *  done       — published / released to prod
 *  rejected   — denied
 */
export type FeedbackStatus = "new" | "approved" | "dispatched" | "accepted" | "done" | "rejected";

export interface FeedbackEntry {
  id: string;
  description: string;
  type: FeedbackType;
  /** Page path auto-captured from the browser at submit time. */
  pagePath: string;
  severity?: FeedbackSeverity;
  status: FeedbackStatus;
  /** Identity (email/username) of the submitter, taken from the session. */
  createdBy: string;
  createdAt: string;
  /** Identity of the approver/reviewer who last changed status. */
  reviewedBy?: string;
  reviewedAt?: string;
  /** Optional note left by the reviewer. */
  reviewNote?: string;
  /**
   * URL of the ephemeral preview deployment, written back by the dispatch
   * approve run once a fix is built. Lets the reviewer test the change on the
   * cluster before accepting it.
   */
  previewUrl?: string;
  /** Page/route to deep-link the reviewer to inside the preview (the reported page). */
  testPath?: string;
  /** Latest dispatch run id for this entry — opens the live console / audit log. */
  dispatchRunId?: string;
  /** True once the entry's fix has been published/released to prod via /publish. */
  released?: boolean;
  /** When the fix was published to main/prod. */
  publishedAt?: string;
}

export const FEEDBACK_TYPES: FeedbackType[] = ["bug", "feature-request", "note"];
export const FEEDBACK_SEVERITIES: FeedbackSeverity[] = ["low", "medium", "high", "critical"];
export const FEEDBACK_STATUSES: FeedbackStatus[] = ["new", "approved", "dispatched", "accepted", "done", "rejected"];

interface FeedbackConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedFeedbackState {
  entries: FeedbackEntry[];
  resourceVersion?: string;
}

function isNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not\s*found/i.test(message);
}

function safeParseArray<T>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function readConfigMap(): Promise<FeedbackConfigMap | null> {
  const coreApi = makeCoreApi();
  try {
    return (await coreApi.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as FeedbackConfigMap;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function loadFeedbackState(): Promise<LoadedFeedbackState> {
  const configMap = await readConfigMap();
  if (!configMap) return { entries: [] };
  return {
    entries: safeParseArray<FeedbackEntry>(configMap.data?.entries),
    resourceVersion: configMap.metadata?.resourceVersion,
  };
}

export async function listFeedback(): Promise<FeedbackEntry[]> {
  const { entries } = await loadFeedbackState();
  return [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function writeFeedbackState(state: LoadedFeedbackState): Promise<void> {
  const coreApi = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "infraweaver-console",
        "infraweaver.io/component": "feedback",
      },
      ...(state.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
    },
    data: {
      entries: JSON.stringify(state.entries),
      updatedAt: new Date().toISOString(),
    },
  };

  if (state.resourceVersion) {
    await coreApi.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await coreApi.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

/** Read-modify-write with a single optimistic-concurrency retry on conflict. */
async function mutate<T>(mutator: (state: LoadedFeedbackState) => T): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await loadFeedbackState();
    const result = mutator(state);
    try {
      await writeFeedbackState(state);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /409|conflict/i.test(message);
      if (!conflict || attempt === 1) throw error;
    }
  }
  throw new Error("Failed to persist feedback state");
}

export interface FeedbackInput {
  description: string;
  type: FeedbackType;
  pagePath: string;
  severity?: FeedbackSeverity;
}

/** Keep the ConfigMap bounded: retain the most recent 500 entries. */
function prune(entries: FeedbackEntry[], limit = 500): FeedbackEntry[] {
  return [...entries]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function createFeedback(input: FeedbackInput, actor: string): Promise<FeedbackEntry> {
  return mutate((state) => {
    const entry: FeedbackEntry = {
      id: randomUUID(),
      description: input.description.trim().slice(0, 4000),
      type: input.type,
      pagePath: input.pagePath.trim().slice(0, 512),
      severity: input.severity,
      status: "new",
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };
    state.entries.unshift(entry);
    state.entries = prune(state.entries);
    return entry;
  });
}

export interface UpdateFeedbackOpts {
  previewUrl?: string;
  /** Page/route to deep-link inside the preview. */
  testPath?: string;
  /** Dispatch run id powering the live console / audit log. */
  dispatchRunId?: string;
  released?: boolean;
  publishedAt?: string;
}

/** Like {@link UpdateFeedbackOpts} but may also advance status (no reviewer clobber). */
export interface PatchFeedbackOpts extends UpdateFeedbackOpts {
  status?: FeedbackStatus;
}

export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus,
  actor: string,
  reviewNote?: string,
  opts?: UpdateFeedbackOpts,
): Promise<FeedbackEntry | null> {
  return mutate((state) => {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.status = status;
    entry.reviewedBy = actor;
    entry.reviewedAt = new Date().toISOString();
    if (reviewNote !== undefined) entry.reviewNote = reviewNote.trim().slice(0, 1000);
    if (opts?.previewUrl !== undefined) entry.previewUrl = opts.previewUrl.trim().slice(0, 512);
    if (opts?.testPath !== undefined) entry.testPath = opts.testPath.trim().slice(0, 512);
    if (opts?.dispatchRunId !== undefined) entry.dispatchRunId = opts.dispatchRunId.trim().slice(0, 128);
    if (opts?.released !== undefined) entry.released = opts.released;
    if (opts?.publishedAt !== undefined) entry.publishedAt = opts.publishedAt;
    return entry;
  });
}

/**
 * Patch a subset of fields on an entry WITHOUT touching review identity/status.
 * Used by background dispatch callbacks to write back the preview URL / run id
 * once a long-running approve completes.
 */
export async function patchFeedbackEntry(id: string, patch: PatchFeedbackOpts): Promise<FeedbackEntry | null> {
  return mutate((state) => {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return null;
    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.previewUrl !== undefined) entry.previewUrl = patch.previewUrl.trim().slice(0, 512);
    if (patch.testPath !== undefined) entry.testPath = patch.testPath.trim().slice(0, 512);
    if (patch.dispatchRunId !== undefined) entry.dispatchRunId = patch.dispatchRunId.trim().slice(0, 128);
    if (patch.released !== undefined) entry.released = patch.released;
    if (patch.publishedAt !== undefined) entry.publishedAt = patch.publishedAt;
    return entry;
  });
}

/**
 * On a successful Publish, drain every `accepted` entry to `done` and stamp it
 * released. Returns the ids that were transitioned.
 */
export async function markAllAcceptedDone(actor: string): Promise<string[]> {
  return mutate((state) => {
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (const entry of state.entries) {
      if (entry.status === "accepted") {
        entry.status = "done";
        entry.released = true;
        entry.publishedAt = now;
        entry.reviewedBy = actor;
        entry.reviewedAt = now;
        ids.push(entry.id);
      }
    }
    return ids;
  });
}

/** Count entries currently accepted and awaiting publish. */
export async function countAcceptedFeedback(): Promise<number> {
  const { entries } = await loadFeedbackState();
  return entries.filter((e) => e.status === "accepted").length;
}
