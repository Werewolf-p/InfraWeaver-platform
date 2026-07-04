// IWSL scheduled WP-key rotation driver — IW side of §8 v1.2.
// PREPARE → VERIFY → CONFIRM, overlap + ratchet forward, never atomic swap,
// never rollback past a commit. Lost acks are recovered by idempotent retry:
// the plugin keys PREPARE/CONFIRM on rotation_id, so a re-sent step returns
// the same result instead of minting a second key.
//
// The transport is abstract: callers wrap the signed command channel
// (createSignedCommand + HTTP + verifySignedResponse) and hand the driver a
// function that returns the verified reply — or null when the reply was lost.
// Signature verification against old vs prepared-new WP key happens in that
// wrapper; the driver only reasons about epochs and phases.

export type RotationOutcome = "confirmed" | "aborted" | "pending";

export interface SiteLinkState {
  readonly siteId: string;
  /** Confirmed WP key epoch. */
  readonly kid: number;
  /** Monotonic floor: responses with kid < epochFloor are rejected forever. */
  readonly epochFloor: number;
  /** Active pinned WP-PK (base64url). */
  readonly wpPk: string;
  readonly pendingRotation: PendingRotation | null;
}

export interface PendingRotation {
  readonly rotationId: string;
  readonly newKid: number;
  readonly newWpPk: string | null;
  readonly phase: "prepare" | "verify";
  readonly startedTs: number;
  readonly deadlineTs: number;
}

export interface RotationReply {
  ok: boolean;
  /** Epoch of the WP key that signed the (already verified) response. */
  kid: number;
  result: Record<string, unknown>;
}

export type RotationTransport = (
  method: string,
  params: Record<string, unknown>,
) => Promise<RotationReply | null>;

export interface RotationOptions {
  rotationId: string;
  now: number;
  /** VERIFY window (§8 step 2), default 72h. */
  verifyDeadlineMs?: number;
  /** Per-step resend attempts within this driver run. */
  maxAttempts?: number;
}

export interface RotationRun {
  state: SiteLinkState;
  outcome: RotationOutcome;
}

const DEFAULT_VERIFY_DEADLINE_MS = 72 * 3600_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Run (or resume) one scheduled rotation cycle. Safe to call again with the
 * returned state after a "pending" outcome — every step is idempotent.
 */
export async function runScheduledRotation(
  state: SiteLinkState,
  transport: RotationTransport,
  opts: RotationOptions,
): Promise<RotationRun> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let current = state;

  if (current.pendingRotation === null) {
    current = withPending(current, {
      rotationId: opts.rotationId,
      newKid: current.kid + 1,
      newWpPk: null,
      phase: "prepare",
      startedTs: opts.now,
      deadlineTs: opts.now + (opts.verifyDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS),
    });
  }
  const pending = current.pendingRotation as PendingRotation;

  if (opts.now > pending.deadlineTs) {
    return abortRotation(current, transport);
  }

  if (pending.phase === "prepare") {
    const prepared = await sendWithRetry(transport, maxAttempts, "key.rotate.self", {
      rotation_id: pending.rotationId,
      new_kid: pending.newKid,
    });
    if (prepared === null) {
      // Site unreachable at PREPARE: no state change, retry next interval (§8).
      return { state, outcome: "pending" };
    }
    const newWpPk = prepared.result.new_wp_pk;
    if (!prepared.ok || typeof newWpPk !== "string" || newWpPk.length === 0) {
      return abortRotation(current, transport);
    }
    current = withPending(current, { ...pending, newWpPk, phase: "verify" });
  }

  const verifying = current.pendingRotation as PendingRotation;
  const verified = await sendWithRetry(transport, maxAttempts, "health.check", {});
  const verifiedUnderNewEpoch =
    verified !== null && verified.ok && verified.kid === verifying.newKid;
  if (!verifiedUnderNewEpoch) {
    // Verify not yet proven. Old key stays fully operational; retry until the
    // window expires, then ABORT (discard new key — never roll back a commit).
    return opts.now > verifying.deadlineTs
      ? abortRotation(current, transport)
      : { state: current, outcome: "pending" };
  }

  const confirmed = await sendWithRetry(transport, maxAttempts, "key.rotate.confirm", {
    rotation_id: verifying.rotationId,
  });
  if (confirmed === null || !confirmed.ok) {
    // Lost CONFIRM ack: both sides still hold old+new; resume next interval.
    return { state: current, outcome: "pending" };
  }

  return {
    state: {
      siteId: current.siteId,
      kid: verifying.newKid,
      epochFloor: verifying.newKid,
      wpPk: verifying.newWpPk as string,
      pendingRotation: null,
    },
    outcome: "confirmed",
  };
}

async function abortRotation(
  state: SiteLinkState,
  transport: RotationTransport,
): Promise<RotationRun> {
  const rotationId = state.pendingRotation?.rotationId;
  if (rotationId !== undefined) {
    // Best-effort: plugin also discards on its own when a new PREPARE arrives.
    await transport("key.rotate.abort", { rotation_id: rotationId });
  }
  return {
    state: { ...state, pendingRotation: null },
    outcome: "aborted",
  };
}

async function sendWithRetry(
  transport: RotationTransport,
  maxAttempts: number,
  method: string,
  params: Record<string, unknown>,
): Promise<RotationReply | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const reply = await transport(method, params);
    if (reply !== null) {
      return reply;
    }
  }
  return null;
}

function withPending(state: SiteLinkState, pending: PendingRotation): SiteLinkState {
  return { ...state, pendingRotation: pending };
}
