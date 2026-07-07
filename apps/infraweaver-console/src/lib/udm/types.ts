/**
 * UniFi Dream Machine (UDM Pro) connector — shared types.
 *
 * The connector talks to the edge router's Network API to reconcile WAN
 * port-forward rules (e.g. exposing a game server's NodePort) and to read WAN
 * health (public IP + CGNAT detection). Auth is a UniFi OS **API key** sent as
 * the `X-API-KEY` header — no username/password, no CSRF/cookie dance.
 */

export type PortForwardProto = "tcp" | "udp" | "tcp_udp";

/** A port-forward rule as accepted by the UDM `rest/portforward` endpoint. */
export interface PortForwardRule {
  name: string;
  enabled: boolean;
  proto: PortForwardProto;
  /** WAN-side port (string, as the UDM API expects). */
  dst_port: string;
  /** LAN target IP. */
  fwd: string;
  /** LAN target port. */
  fwd_port: string;
  /** Source restriction; "any" when unset. */
  src?: string;
  log?: boolean;
}

/** A port-forward rule as returned by the UDM, carrying its document id. */
export interface PortForwardRecord extends PortForwardRule {
  _id: string;
  [key: string]: unknown;
}

/** Result of an idempotent upsert/delete, for audit/UI reporting. */
export type ReconcileAction = "created" | "updated" | "deleted" | "absent";

export interface ReconcileResult {
  action: ReconcileAction;
  id: string | null;
}

/** Parsed WAN status, including CGNAT detection. */
export interface WanStatus {
  wanIp: string;
  isCgnat: boolean;
  up: boolean;
}

export interface UdmConfig {
  /** Base URL, e.g. `https://10.10.0.1`. */
  host: string;
  /** UniFi OS API key (X-API-KEY). */
  apiKey: string;
  /** Pinned server-cert SHA-256 fingerprint (colon-hex or plain hex). */
  fingerprintSha256: string;
  /** UniFi site slug; defaults to `default`. */
  site?: string;
  /** Per-request timeout in ms; defaults to 15000. */
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  json: unknown;
}

/**
 * Low-level request function. Injected into {@link UdmClient} so business logic
 * (find/upsert/delete/parse) is unit-testable without a live router. The
 * default implementation is the cert-pinned node:https transport.
 */
export type UdmTransport = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<TransportResponse>;
