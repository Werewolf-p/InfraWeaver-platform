/**
 * Boundary validation for port-forward rules coming off the API route. Never
 * trust client input: a bad rule pushed to the edge router could open an
 * unintended WAN port, so we validate shape, ranges, and the LAN target before
 * anything reaches the UDM.
 */

import type { PortForwardProto, PortForwardRule } from "@/lib/udm/types";

const PROTOS: readonly PortForwardProto[] = ["tcp", "udp", "tcp_udp"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;

function isPort(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

function isIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  rule?: PortForwardRule;
}

/** Validate + normalize an untrusted port-forward payload. */
export function validatePortForwardRule(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body must be an object" };
  const r = input as Record<string, unknown>;

  if (typeof r.name !== "string" || !NAME_RE.test(r.name)) {
    return { ok: false, error: "invalid name" };
  }
  if (typeof r.proto !== "string" || !PROTOS.includes(r.proto as PortForwardProto)) {
    return { ok: false, error: "proto must be tcp, udp, or tcp_udp" };
  }
  if (!isPort(r.dst_port)) return { ok: false, error: "invalid dst_port" };
  if (!isPort(r.fwd_port)) return { ok: false, error: "invalid fwd_port" };
  if (!isIpv4(r.fwd)) return { ok: false, error: "fwd must be an IPv4 address" };
  if (r.src !== undefined && typeof r.src !== "string") return { ok: false, error: "invalid src" };

  return {
    ok: true,
    rule: {
      name: r.name,
      enabled: r.enabled !== false,
      proto: r.proto as PortForwardProto,
      dst_port: r.dst_port,
      fwd: r.fwd,
      fwd_port: r.fwd_port,
      src: typeof r.src === "string" ? r.src : "any",
      log: r.log === true,
    },
  };
}

/** Validate a rule name used as a path/query key for delete. */
export function isValidRuleName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}
