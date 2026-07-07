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
import type {
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
