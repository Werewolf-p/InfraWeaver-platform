/**
 * Port-conflict math for UDM WAN forwards — pure, side-effect-free helpers so the
 * allocation logic in {@link UdmClient} is unit-testable without a live router.
 *
 * The core problem: two port-forward rules must never claim the same WAN port on
 * overlapping protocols (a silent duplicate that makes one server unreachable).
 * These helpers expand the UDM's port syntax (single, comma-list, or range),
 * decide protocol overlap, and find the first free port to bump onto.
 */

import type { PortForwardProto, PortForwardRecord } from "@/lib/udm/types";

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * Expand a UDM port token into concrete port numbers.
 * Accepts a single port (`"8211"`), a comma list (`"80,443"`), or a range
 * (`"2456-2457"`), or any mix. Non-numeric / malformed tokens are skipped.
 */
export function expandPortTokens(spec: string): number[] {
  const out: number[] = [];
  for (const token of spec.split(",")) {
    const t = token.trim();
    if (!t) continue;
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (lo >= MIN_PORT && hi <= MAX_PORT && lo <= hi) {
        for (let p = lo; p <= hi; p++) out.push(p);
      }
      continue;
    }
    if (/^\d+$/.test(t)) {
      const p = Number(t);
      if (p >= MIN_PORT && p <= MAX_PORT) out.push(p);
    }
  }
  return out;
}

/** Whether two protocols share the wire. `tcp_udp` overlaps everything. */
export function protosOverlap(a: PortForwardProto, b: PortForwardProto): boolean {
  if (a === "tcp_udp" || b === "tcp_udp") return true;
  return a === b;
}

/**
 * Set of WAN (`dst_port`) ports already claimed by enabled, protocol-overlapping
 * rules. Pass `excludeName` to ignore the rule being reconciled (so a rule never
 * conflicts with itself).
 */
export function occupiedWanPorts(
  rules: readonly PortForwardRecord[],
  proto: PortForwardProto,
  excludeName?: string,
): Set<number> {
  const set = new Set<number>();
  for (const r of rules) {
    if (excludeName !== undefined && r.name === excludeName) continue;
    if (r.enabled === false) continue; // a disabled rule holds no live port
    if (!protosOverlap(proto, r.proto)) continue;
    for (const p of expandPortTokens(String(r.dst_port))) set.add(p);
  }
  return set;
}

/**
 * Set of LAN targets (`"ip:port"`) already receiving an enabled,
 * protocol-overlapping forward — used to reject a second forward that would
 * deliver to the exact same internal endpoint.
 */
export function occupiedLanTargets(
  rules: readonly PortForwardRecord[],
  proto: PortForwardProto,
  excludeName?: string,
): Set<string> {
  const set = new Set<string>();
  for (const r of rules) {
    if (excludeName !== undefined && r.name === excludeName) continue;
    if (r.enabled === false) continue;
    if (!protosOverlap(proto, r.proto)) continue;
    for (const p of expandPortTokens(String(r.fwd_port))) set.add(`${r.fwd}:${p}`);
  }
  return set;
}

export interface FreePortOptions {
  /** Lowest port the allocator may hand out (inclusive). Default {@link MIN_PORT}. */
  min?: number;
  /** Highest port the allocator may hand out (inclusive). Default {@link MAX_PORT}. */
  max?: number;
  /** Cap on candidates probed before giving up. Default = full [min,max] span. */
  maxProbe?: number;
}

/**
 * First free port at or above `desired`, probing upward and wrapping to `min`
 * once `max` is passed, skipping anything in `occupied`. Returns `null` when no
 * port is free within the probe budget.
 */
export function firstFreePort(
  desired: number,
  occupied: ReadonlySet<number>,
  opts: FreePortOptions = {},
): number | null {
  const min = opts.min ?? MIN_PORT;
  const max = opts.max ?? MAX_PORT;
  if (min > max) return null;
  const span = max - min + 1;
  const maxProbe = Math.min(opts.maxProbe ?? span, span);
  let candidate = Math.min(Math.max(desired, min), max);
  for (let i = 0; i < maxProbe; i++) {
    if (!occupied.has(candidate)) return candidate;
    candidate = candidate >= max ? min : candidate + 1;
  }
  return null;
}

export interface DuplicateWanPort {
  port: number;
  names: string[];
}

/**
 * WAN ports claimed by more than one enabled rule on overlapping protocols — an
 * integrity report for the UI, mirroring `findDuplicateNames`. A `tcp` rule and
 * a `udp` rule on the same port are NOT a duplicate (distinct wires); a `tcp`
 * rule overlapping a `tcp_udp` rule is.
 */
export function findDuplicateWanPorts(rules: readonly PortForwardRecord[]): DuplicateWanPort[] {
  const byPort = new Map<number, Array<{ name: string; proto: PortForwardProto }>>();
  for (const r of rules) {
    if (r.enabled === false) continue;
    for (const p of expandPortTokens(String(r.dst_port))) {
      const list = byPort.get(p) ?? [];
      list.push({ name: r.name, proto: r.proto });
      byPort.set(p, list);
    }
  }

  const dups: DuplicateWanPort[] = [];
  for (const [port, entries] of byPort) {
    if (entries.length < 2) continue;
    const conflicting = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (protosOverlap(entries[i].proto, entries[j].proto)) {
          conflicting.add(entries[i].name);
          conflicting.add(entries[j].name);
        }
      }
    }
    if (conflicting.size > 0) {
      dups.push({ port, names: [...conflicting].sort() });
    }
  }
  return dups.sort((a, b) => a.port - b.port);
}
