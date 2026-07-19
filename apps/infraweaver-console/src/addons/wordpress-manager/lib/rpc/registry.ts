/**
 * IWSL RPC method registry — the console-side catalog of the signed commands the
 * Connector allow-lists (§6/§7), plus `callRpc`, the typed funnel every managed
 * op routes through on top of the existing signed-command transport
 * (`dispatchSignedCommand`).
 *
 * Phase 0 of the RPC layer: no wire change. The bytes signed and delivered are
 * identical to the pre-registry call sites — `callRpc` forwards the same method
 * string and the same params object to the transport, unchanged. What this adds
 * is one typed definition point for the six methods that mirrors the plugin's
 * `IWSL_Plugin::allowed_methods()` allow-list, so the two sides can be kept in
 * lockstep and future methods have a single home.
 *
 * Deliberately isomorphic (no `server-only`): it holds no transport, only the
 * method catalog and the pass-through. The transport — which IS server-only —
 * is injected by `iwsl-managed-ops`.
 */

/** Signed-command methods the Connector allow-lists (§7). Wire strings — never rename. */
export type RpcMethod =
  | "health.check"
  | "debug.status"
  | "metrics.snapshot"
  | "key.rotate.self"
  | "key.rotate.confirm"
  | "key.rotate.abort"
  | "site.deactivate";

/** Params each method carries on the wire. `Record<string, never>` = no params (§6.3). */
export interface RpcParams {
  "health.check": Record<string, never>;
  "debug.status": Record<string, never>;
  "metrics.snapshot": Record<string, never>;
  "key.rotate.self": { rotation_id: string; new_kid?: number };
  "key.rotate.confirm": { rotation_id: string };
  "key.rotate.abort": { rotation_id: string };
  "site.deactivate": Record<string, never>;
}

/**
 * Numeric/scalar telemetry the plugin returns for `metrics.snapshot` — a
 * gauge-shaped projection of link state (see IWSL_Plugin::metrics_snapshot).
 * Best-effort typing; the exporter still narrows each field before rendering.
 */
export interface ConnectorMetricsResult {
  /** Running Connector version (→ `iwsl_connector_info` label). */
  plugin: string;
  /** PHP version the site runs (→ info label). */
  php: string;
  /** WordPress core version, or null off a real WP context (→ info label). */
  wp: string | null;
  /** Plugin's own clock in unix ms — for scrape-side skew detection. */
  time_ms: number;
  /** libsodium available for signing/verification (0/1). */
  sodium: 0 | 1;
  wp_kid: number;
  iw_kid: number;
  wp_epoch_floor: number;
  iw_epoch_floor: number;
  /** Highest command seq the link has committed (§6.3 replay watermark). */
  last_seq: number;
  /** Live replay-nonce cache size. */
  nonce_cache: number;
  /** A key rotation is prepared-but-unconfirmed (0/1). */
  rotation_pending: 0 | 1;
  /** Unix seconds of the last signing-key reroll, 0 if never (§8). */
  last_reroll_at: number;
  /** Whether that last reroll confirmed (1) or aborted/failed (0). */
  last_reroll_ok: 0 | 1;
}

/**
 * Verified `result` payload each method returns. Best-effort typing — the plugin
 * is the source of truth, so callers still narrow `CommandReply.result` before
 * trusting a field.
 */
export interface RpcResult {
  "health.check": {
    status: string;
    php: string;
    plugin: string;
    kid: number;
    seq: number;
    /** §5 — the site's own live canonical URL, for clone/identity-crisis detection. */
    site_url?: string;
    /** §8 — last signing-key reroll outcome (unix seconds); absent before first reroll. */
    last_reroll?: { at: number; kid: number; ok: boolean; reason?: string };
  };
  "debug.status": Record<string, unknown>;
  "metrics.snapshot": ConnectorMetricsResult;
  "key.rotate.self": { new_wp_pk: string } | { reason: string };
  "key.rotate.confirm": Record<string, never> | { reason: string };
  "key.rotate.abort": Record<string, never>;
  "site.deactivate": { deactivated: true };
}

/** Client-side sanity check for a method's params — mirrors the plugin allow-list validator. */
export type RpcParamsValidator = (params: Record<string, unknown>) => boolean;

export interface RpcMethodSpec {
  /** True when the method carries params; false = wire params must be empty (§6.3). */
  readonly hasParams: boolean;
  /** True when `params` is well-formed for this method (parity with the plugin's validator). */
  readonly validate: RpcParamsValidator;
}

const noParams: RpcParamsValidator = (params) => Object.keys(params).length === 0;

/**
 * Mirror of the plugin's shared `$rotation_params` closure: a non-empty
 * `rotation_id`, an optional integer `new_kid`, and no other keys.
 */
const rotationParams: RpcParamsValidator = (params) =>
  typeof params.rotation_id === "string" &&
  params.rotation_id.length > 0 &&
  (params.new_kid === undefined || Number.isInteger(params.new_kid)) &&
  Object.keys(params).every((key) => key === "rotation_id" || key === "new_kid");

/**
 * The six current signed commands. Single source of truth for the console side;
 * the ordering matches `IWSL_Plugin::allowed_methods()` for easy cross-reading.
 */
export const RPC_REGISTRY: Record<RpcMethod, RpcMethodSpec> = {
  "health.check": { hasParams: false, validate: noParams },
  "debug.status": { hasParams: false, validate: noParams },
  "metrics.snapshot": { hasParams: false, validate: noParams },
  "key.rotate.self": { hasParams: true, validate: rotationParams },
  "key.rotate.confirm": { hasParams: true, validate: rotationParams },
  "key.rotate.abort": { hasParams: true, validate: rotationParams },
  "site.deactivate": { hasParams: false, validate: noParams },
};

/** The allow-listed method names, in registry order. */
export const RPC_METHODS = Object.keys(RPC_REGISTRY) as RpcMethod[];

/** Verified reply from one signed command — the shape `dispatchSignedCommand` returns. */
export interface CommandReply {
  /** The plugin's verified `ok` verdict for the command. */
  ok: boolean;
  /** WP key epoch that signed the (verified) response. */
  kid: number;
  result: Record<string, unknown>;
  roundtripMs: number;
  /** Set when the plugin rejected the command unsigned (§12.5 reason). */
  rejectedReason?: string;
}

export interface DispatchOptions {
  /** Additional legitimate WP-PK (§8 — a prepared-but-unconfirmed new key). */
  altWpPk?: string | null;
}

/**
 * A bound signed-command transport: method + params in, verified `CommandReply`
 * out. `iwsl-managed-ops` supplies one by binding a link record and a delivery
 * (exec or HTTPS) onto `dispatchSignedCommand`.
 */
export type RpcTransport = (
  method: RpcMethod,
  params: Record<string, unknown>,
  opts?: DispatchOptions,
) => Promise<CommandReply>;

/**
 * Typed funnel for the six signed commands. Confirms the method is registered —
 * the same allow-list the plugin enforces, a programming error otherwise — then
 * forwards it, unchanged, to the transport. No wire change versus a direct
 * `dispatchSignedCommand` call: identical method string, identical params object.
 */
export async function callRpc<M extends RpcMethod>(
  transport: RpcTransport,
  method: M,
  params: RpcParams[M],
  opts?: DispatchOptions,
): Promise<CommandReply> {
  if (!(method in RPC_REGISTRY)) {
    throw new Error(`callRpc: ${method} is not an allow-listed IWSL method`);
  }
  return transport(method, params as Record<string, unknown>, opts);
}
