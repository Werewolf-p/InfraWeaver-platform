/** @jest-environment node */
import {
  runScheduledRotation,
  type RotationReply,
  type RotationTransport,
  type SiteLinkState,
} from "@/lib/iwsl/rotation";

const T0 = 1751600000000;

function initialState(): SiteLinkState {
  return {
    siteId: "site-1",
    kid: 1,
    epochFloor: 1,
    wpPk: "old-pk",
    pendingRotation: null,
  };
}

/**
 * Mock Connector implementing the plugin's §8 semantics: PREPARE/CONFIRM
 * idempotent on rotation_id, responses signed under the prepared epoch once
 * one exists. `lose` eats the reply of the matching call (send processed,
 * ack lost — the interesting failure).
 */
function mockSite(opts: { loseFirst?: string[] } = {}) {
  const prepared = new Map<string, { kid: number; pk: string }>();
  const confirmed = new Set<string>();
  let currentKid = 1;
  let keyCounter = 0;
  const losses = [...(opts.loseFirst ?? [])];

  const transport: RotationTransport = async (method, params) => {
    const rotationId = params.rotation_id as string | undefined;
    let reply: RotationReply;
    if (method === "key.rotate.self") {
      if (rotationId === undefined) throw new Error("rotation_id required");
      const existing = prepared.get(rotationId);
      const entry = existing ?? { kid: (params.new_kid as number) ?? currentKid + 1, pk: `pk-${++keyCounter}` };
      prepared.set(rotationId, entry);
      // §8 chain of custody: the PREPARE response is signed by the OLD key.
      reply = { ok: true, kid: currentKid, result: { new_wp_pk: entry.pk } };
    } else if (method === "key.rotate.confirm") {
      const entry = rotationId === undefined ? undefined : prepared.get(rotationId);
      if (entry !== undefined) {
        currentKid = entry.kid;
        confirmed.add(rotationId as string);
      }
      reply = {
        ok: entry !== undefined || confirmed.has(rotationId ?? ""),
        kid: currentKid,
        result: {},
      };
    } else if (method === "key.rotate.abort") {
      if (rotationId !== undefined) prepared.delete(rotationId);
      reply = { ok: true, kid: currentKid, result: {} };
    } else {
      // health.check — signed under the prepared epoch when a rotation is pending.
      const pendingEntry = [...prepared.values()].pop();
      const kid = pendingEntry !== undefined && !confirmed.has([...prepared.keys()].pop() ?? "") ? pendingEntry.kid : currentKid;
      reply = { ok: true, kid, result: { status: "ok" } };
    }
    const lossIndex = losses.indexOf(method);
    if (lossIndex >= 0) {
      losses.splice(lossIndex, 1);
      return null; // site processed the command; the ack never arrived
    }
    return reply;
  };

  return { transport, state: () => ({ currentKid, preparedCount: keyCounter }) };
}

describe("IWSL scheduled rotation driver (§8 v1.2)", () => {
  test("happy path: prepare → verify → confirm ratchets the epoch", async () => {
    const site = mockSite();
    const run = await runScheduledRotation(initialState(), site.transport, {
      rotationId: "rot-1",
      now: T0,
    });
    expect(run.outcome).toBe("confirmed");
    expect(run.state.kid).toBe(2);
    expect(run.state.epochFloor).toBe(2);
    expect(run.state.wpPk).toBe("pk-1");
    expect(run.state.pendingRotation).toBeNull();
  });

  test("lost PREPARE ack: retry recovers the SAME key — no second key minted", async () => {
    const site = mockSite({ loseFirst: ["key.rotate.self"] });
    const run = await runScheduledRotation(initialState(), site.transport, {
      rotationId: "rot-1",
      now: T0,
    });
    expect(run.outcome).toBe("confirmed");
    expect(run.state.wpPk).toBe("pk-1");
    expect(site.state().preparedCount).toBe(1); // idempotent retry, single key
  });

  test("lost CONFIRM ack: run stays pending, resume completes without re-keying", async () => {
    const site = mockSite({ loseFirst: ["key.rotate.confirm", "key.rotate.confirm", "key.rotate.confirm"] });
    const first = await runScheduledRotation(initialState(), site.transport, {
      rotationId: "rot-1",
      now: T0,
      maxAttempts: 3,
    });
    expect(first.outcome).toBe("pending");
    expect(first.state.pendingRotation?.phase).toBe("verify");
    expect(first.state.kid).toBe(1); // not committed yet

    const resumed = await runScheduledRotation(first.state, site.transport, {
      rotationId: "rot-1",
      now: T0 + 60_000,
    });
    expect(resumed.outcome).toBe("confirmed");
    expect(resumed.state.kid).toBe(2);
    expect(site.state().preparedCount).toBe(1);
  });

  test("site unreachable at PREPARE: no state change, retry next interval", async () => {
    const site = mockSite({ loseFirst: ["key.rotate.self", "key.rotate.self", "key.rotate.self"] });
    const state = initialState();
    const run = await runScheduledRotation(state, site.transport, {
      rotationId: "rot-1",
      now: T0,
      maxAttempts: 3,
    });
    expect(run.outcome).toBe("pending");
    expect(run.state).toEqual(state); // §8: offline at PREPARE → nothing changed
  });

  test("verify window expiry aborts — old key keeps working, no rollback path", async () => {
    const site = mockSite();
    // Force a resumed rotation whose deadline has passed.
    const stuck: SiteLinkState = {
      ...initialState(),
      pendingRotation: {
        rotationId: "rot-stale",
        newKid: 2,
        newWpPk: "pk-unverified",
        phase: "verify",
        startedTs: T0 - 73 * 3600_000,
        deadlineTs: T0 - 3600_000,
      },
    };
    const run = await runScheduledRotation(stuck, site.transport, {
      rotationId: "rot-stale",
      now: T0,
    });
    expect(run.outcome).toBe("aborted");
    expect(run.state.kid).toBe(1);
    expect(run.state.wpPk).toBe("old-pk"); // old key never invalidated
    expect(run.state.pendingRotation).toBeNull();
  });
});
