/**
 * UdmClient — idempotent UDM Pro Network API client.
 *
 * A TypeScript port of the reference `scratchpad/udm.py`: upsert-by-name and
 * delete-by-name against `rest/portforward`, plus WAN-health/CGNAT read. All
 * network I/O goes through an injected {@link UdmTransport}, so this logic is
 * unit-testable without a live router; the default transport is the cert-pinned
 * node:https one (see `https-transport.ts`).
 */

import { isCgnatIp } from "@/lib/udm/cgnat";
import {
  findDuplicateWanPorts,
  firstFreePort,
  occupiedLanTargets,
  occupiedWanPorts,
  type DuplicateWanPort,
} from "@/lib/udm/ports";
import type {
  PortAllocation,
  PortForwardRecord,
  PortForwardRule,
  ReconcileResult,
  TransportResponse,
  UdmTransport,
  WanStatus,
} from "@/lib/udm/types";

/** Thrown when the UDM returns a non-2xx status. Carries the HTTP status. */
export class UdmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UdmError";
  }
}

function ensureOk(res: TransportResponse, what: string): TransportResponse {
  if (res.status < 200 || res.status >= 300) {
    throw new UdmError(`UDM ${what} failed (HTTP ${res.status})`, res.status);
  }
  return res;
}

function dataArray(res: TransportResponse): unknown[] {
  const body = res.json as { data?: unknown } | null;
  const data = body?.data;
  return Array.isArray(data) ? data : [];
}

export class UdmClient {
  private readonly site: string;

  constructor(
    private readonly transport: UdmTransport,
    site = "default",
  ) {
    this.site = site;
  }

  private apiPath(suffix: string): string {
    return `/proxy/network/api/s/${this.site}/${suffix}`;
  }

  /** List all port-forward rules. */
  async listPortForwards(): Promise<PortForwardRecord[]> {
    const res = ensureOk(await this.transport("GET", this.apiPath("rest/portforward")), "list port-forwards");
    return dataArray(res) as PortForwardRecord[];
  }

  /** Find a single rule by its unique `name`, or null. */
  async findPortForward(name: string): Promise<PortForwardRecord | null> {
    const all = await this.listPortForwards();
    return all.find((r) => r.name === name) ?? null;
  }

  /**
   * Create the rule if absent, else PUT it in place (merging onto the existing
   * document so the `_id` and any UDM-managed fields are preserved). Keyed by
   * `name`, so repeated calls never produce duplicates.
   */
  async upsertPortForward(rule: PortForwardRule): Promise<ReconcileResult> {
    const existing = await this.findPortForward(rule.name);
    if (existing) {
      await ensureOk(
        await this.transport("PUT", this.apiPath(`rest/portforward/${existing._id}`), {
          ...existing,
          ...rule,
        }),
        "update port-forward",
      );
      return { action: "updated", id: existing._id };
    }
    const res = ensureOk(
      await this.transport("POST", this.apiPath("rest/portforward"), rule),
      "create port-forward",
    );
    const created = dataArray(res)[0] as { _id?: string } | undefined;
    return { action: "created", id: created?._id ?? null };
  }

  /**
   * Upsert a rule, but never collide on the WAN port. If the requested
   * `dst_port` is already claimed by another enabled, protocol-overlapping rule,
   * the port is bumped upward (wrapping within `[min,max]`) until a free one is
   * found — so two servers can never silently share a WAN port. The rule stays
   * keyed by `name`, so re-reconciling the same server is idempotent and keeps
   * its already-assigned port (it only moves if that port later conflicts).
   *
   * "Free on both sides": the LAN target (`fwd:fwd_port`) must also be unclaimed;
   * a second forward to the identical internal endpoint is rejected (409) rather
   * than silently duplicated. With `keepFwdPortInSync`, the LAN `fwd_port` tracks
   * the assigned WAN port so both sides advance together (the game-server case
   * where the public port and the nodePort are meant to match).
   */
  async upsertPortForwardNoConflict(
    rule: PortForwardRule,
    opts: { min?: number; max?: number; keepFwdPortInSync?: boolean } = {},
  ): Promise<PortAllocation> {
    const rules = await this.listPortForwards();
    const existing = rules.find((r) => r.name === rule.name) ?? null;
    const requestedPort = rule.dst_port;

    const occupied = occupiedWanPorts(rules, rule.proto, rule.name);
    const desiredNum = Number(rule.dst_port);

    // Prefer stability: an existing same-name rule keeps its current WAN port
    // unless that port now conflicts with another rule.
    let assignedNum: number | null = null;
    if (existing) {
      const currentNum = Number(existing.dst_port);
      if (Number.isInteger(currentNum) && !occupied.has(currentNum)) {
        assignedNum = currentNum;
      }
    }
    if (assignedNum === null) {
      assignedNum = firstFreePort(desiredNum, occupied, opts);
    }
    if (assignedNum === null) {
      throw new UdmError("no free WAN port available in range", 409);
    }

    const assigned = String(assignedNum);
    const fwdPort = opts.keepFwdPortInSync ? assigned : rule.fwd_port;

    // LAN-side duplicate guard: don't create a second forward that delivers to
    // the exact same internal endpoint under a different rule name.
    const lanOccupied = occupiedLanTargets(rules, rule.proto, rule.name);
    if (lanOccupied.has(`${rule.fwd}:${fwdPort}`)) {
      throw new UdmError(`LAN target ${rule.fwd}:${fwdPort} is already forwarded`, 409);
    }

    const finalRule: PortForwardRule = { ...rule, dst_port: assigned, fwd_port: fwdPort };
    const result = await this.upsertPortForward(finalRule);
    return {
      ...result,
      requestedPort,
      assignedPort: assigned,
      bumped: assigned !== requestedPort,
    };
  }

  /** WAN ports claimed by more than one rule (overlapping protos) — UI integrity check. */
  async findDuplicatePorts(): Promise<DuplicateWanPort[]> {
    return findDuplicateWanPorts(await this.listPortForwards());
  }

  /** Delete the rule with this `name`. Returns `absent` when nothing matched. */
  async deletePortForward(name: string): Promise<ReconcileResult> {
    const existing = await this.findPortForward(name);
    if (!existing) return { action: "absent", id: null };
    await ensureOk(
      await this.transport("DELETE", this.apiPath(`rest/portforward/${existing._id}`)),
      "delete port-forward",
    );
    return { action: "deleted", id: existing._id };
  }

  /** Names that appear on more than one rule — an integrity check for the UI. */
  async findDuplicateNames(): Promise<string[]> {
    const counts = new Map<string, number>();
    for (const r of await this.listPortForwards()) {
      counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort();
  }

  /** Read WAN health: public IP, link state, and CGNAT detection. */
  async getWanStatus(): Promise<WanStatus> {
    const res = ensureOk(await this.transport("GET", this.apiPath("stat/health")), "read WAN health");
    const subsystems = dataArray(res) as Array<Record<string, unknown>>;
    const wan =
      subsystems.find((s) => s.subsystem === "wan") ??
      subsystems.find((s) => s.subsystem === "www") ??
      {};
    const wanIp = typeof wan.wan_ip === "string" ? wan.wan_ip : "";
    return {
      wanIp,
      up: wan.status === "ok",
      isCgnat: wanIp ? isCgnatIp(wanIp) : false,
    };
  }
}
