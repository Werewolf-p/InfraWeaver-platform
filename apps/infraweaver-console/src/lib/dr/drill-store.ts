import "server-only";
import { createConfigMapJsonStore } from "@/lib/configmap-store";
import type { DrillEntry } from "./drill-analysis";

/**
 * Durable restore-drill log, ConfigMap-backed (human-inspectable via kubectl).
 * Records manual DR-drill outcomes so "days since last verified restore" is a
 * real, persistent metric rather than tribal knowledge.
 */

interface DrillState {
  entries: DrillEntry[];
}

const MAX_DRILLS = 200;

const store = createConfigMapJsonStore<DrillState>({
  name: "infraweaver-dr-drills",
  labels: { "infraweaver.io/kind": "dr-drills" },
});

export async function listDrills(): Promise<DrillEntry[]> {
  const state = await store.load();
  return state?.entries ?? [];
}

/** Prepend a drill entry (newest first), capped at MAX_DRILLS. */
export async function recordDrill(entry: DrillEntry): Promise<DrillEntry> {
  await store.mutate((current) => {
    const entries = [entry, ...(current?.entries ?? [])].slice(0, MAX_DRILLS);
    return { entries };
  });
  return entry;
}
