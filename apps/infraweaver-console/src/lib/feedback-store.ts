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

/** Lifecycle of a feedback entry. Nothing past `new` happens without a human. */
export type FeedbackStatus = "new" | "approved" | "dispatched" | "done" | "rejected";

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
}

export const FEEDBACK_TYPES: FeedbackType[] = ["bug", "feature-request", "note"];
export const FEEDBACK_SEVERITIES: FeedbackSeverity[] = ["low", "medium", "high", "critical"];
export const FEEDBACK_STATUSES: FeedbackStatus[] = ["new", "approved", "dispatched", "done", "rejected"];

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

export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus,
  actor: string,
  reviewNote?: string,
): Promise<FeedbackEntry | null> {
  return mutate((state) => {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.status = status;
    entry.reviewedBy = actor;
    entry.reviewedAt = new Date().toISOString();
    if (reviewNote !== undefined) entry.reviewNote = reviewNote.trim().slice(0, 1000);
    return entry;
  });
}
