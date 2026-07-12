// @kubernetes/client-node ships ESM-only and jest's CJS runtime only transpiles
// @noble/*, so importing game-hub-server (which imports it) explodes at load.
// The k8s client is used only as an erased type here, so stub the package out.
jest.mock("@kubernetes/client-node", () => ({}));

import { waitForVolumeReleased } from "@/addons/gamehub/lib/game-hub-server";

// A game server's data PVC is ReadWriteOnce: it stays attached to the old pod
// until that pod fully terminates. Scaling a start up while the old pod is
// still terminating schedules the new pod onto a volume it cannot get ->
// `Multi-Attach error for volume` and pod churn until the detach lands. This
// guard gates the scale-up on the terminating pod being gone, but must never
// hang a start indefinitely, and must stay idempotent for an already-live
// server.

type Pod = { metadata?: { deletionTimestamp?: string } };
type PodList = { items: Pod[] };

/**
 * Fake CoreV1Api whose listNamespacedPod returns each queued result in turn,
 * repeating the last one once the queue is drained. An `Error` entry is thrown
 * to simulate a transient API failure.
 */
function fakeCore(results: Array<PodList | Error>) {
  const queue = [...results];
  const listNamespacedPod = jest.fn(async () => {
    const next = queue.length > 1 ? (queue.shift() as PodList | Error) : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
  return { listNamespacedPod } as unknown as Parameters<typeof waitForVolumeReleased>[0] & {
    listNamespacedPod: jest.Mock;
  };
}

const terminating: Pod = { metadata: { deletionTimestamp: "2026-07-12T00:00:00Z" } };
const live: Pod = { metadata: {} };

describe("waitForVolumeReleased", () => {
  it("returns at once when no pods remain (server was already stopped)", async () => {
    const core = fakeCore([{ items: [] }]);
    await expect(waitForVolumeReleased(core, "srv")).resolves.toBe(true);
    expect(core.listNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("returns at once when only a live pod exists (start is idempotent)", async () => {
    const core = fakeCore([{ items: [live] }]);
    await expect(waitForVolumeReleased(core, "srv")).resolves.toBe(true);
    expect(core.listNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("waits for a terminating pod to disappear, then proceeds", async () => {
    const core = fakeCore([{ items: [terminating] }, { items: [] }]);
    await expect(waitForVolumeReleased(core, "srv", 5_000)).resolves.toBe(true);
    expect(core.listNamespacedPod.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("gives up (false) when the terminating pod never clears before the deadline", async () => {
    const core = fakeCore([{ items: [terminating] }]);
    await expect(waitForVolumeReleased(core, "srv", 200)).resolves.toBe(false);
  });

  it("keeps polling through a transient list failure instead of proceeding early", async () => {
    const core = fakeCore([new Error("api unavailable"), { items: [] }]);
    await expect(waitForVolumeReleased(core, "srv", 5_000)).resolves.toBe(true);
    expect(core.listNamespacedPod.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
