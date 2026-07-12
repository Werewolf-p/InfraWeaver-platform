"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { toast } from "@/lib/notify";
import {
  type AllowedRuleEntry,
  type BlockedDestination,
  type DeniesResponse,
  type Direction,
  type FeedEntry,
  type PodDenies,
  type RulesResponse,
  flowId,
  podKey,
} from "./types";

const POLL_MS = 15000;
const HISTORY_POINTS = 48;
const FEED_MAX = 24;

export interface AllowOutcome {
  ok: boolean;
}

export interface FirewallState {
  data: DeniesResponse | null;
  loading: boolean;
  error: string | null;
  dataplaneLive: boolean;
  windowMinutes: number;
  /** Pods with the optimistically-allowed flows already filtered out. */
  pods: PodDenies[];
  dropHistory: number[];
  feed: FeedEntry[];
  rules: Record<string, RulesResponse | null>;
  stats: { pods: number; flows: number; dropsPerSec: number };
}

export interface FirewallActions {
  reload: () => void;
  loadRules: (pod: PodDenies) => void;
  performAllow: (pod: PodDenies, direction: Direction, peer: BlockedDestination, bidirectional: boolean) => Promise<AllowOutcome>;
  commitAllowed: (id: string) => void;
  removeRule: (pod: PodDenies, rule: AllowedRuleEntry) => Promise<AllowOutcome>;
}

function destSet(pods: PodDenies[]): Map<string, FeedEntry> {
  const out = new Map<string, FeedEntry>();
  const now = Date.now();
  for (const p of pods) {
    for (const [direction, list] of [
      ["egress", p.egress],
      ["ingress", p.ingress],
    ] as const) {
      for (const peer of list) {
        const id = flowId(p, direction, peer);
        out.set(id, {
          id,
          ts: now,
          namespace: p.namespace,
          pod: p.pod,
          direction,
          kind: peer.kind,
          target: peer.target,
          port: peer.port,
        });
      }
    }
  }
  return out;
}

/** Owns all firewall data: polling, optimistic mutations, derived posture + feed. */
export function useFirewall(): FirewallState & FirewallActions {
  const [rules, setRules] = useState<Record<string, RulesResponse | null>>({});
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [dropHistory, setDropHistory] = useState<number[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);

  const query = useApiQuery<DeniesResponse>({
    queryKey: ["network", "blocked-flows"],
    path: "/api/network/blocked-flows?window=10",
    request: { cache: "no-store" },
    refetchInterval: POLL_MS,
  });
  const data = query.data ?? null;
  const { dataUpdatedAt, refetch } = query;

  // Per-poll side effects: append a drop-history point, emit feed entries for
  // flows we have never seen before, and prune optimistic allows that are no
  // longer reported as blocked anyway. Keyed on dataUpdatedAt so this runs once
  // per successful poll even when the payload is structurally unchanged. On the
  // very first poll we seed the seen-set silently so the feed shows live
  // activity, not a burst of everything that was already blocked on page open.
  useEffect(() => {
    if (!data) return;
    const pods = data.pods ?? [];
    const total = pods.reduce((s, p) => s + (p.totalDropRate || 0), 0);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one bounded update per completed poll, not a render cascade
    setDropHistory((h) => [...h, total].slice(-HISTORY_POINTS));

    const current = destSet(pods);
    if (firstLoadRef.current) {
      for (const id of current.keys()) seenRef.current.add(id);
      firstLoadRef.current = false;
    } else {
      const fresh: FeedEntry[] = [];
      for (const [id, entry] of current) {
        if (!seenRef.current.has(id)) {
          seenRef.current.add(id);
          fresh.push(entry);
        }
      }
      if (fresh.length) setFeed((f) => [...fresh, ...f].slice(0, FEED_MAX));
    }
    setAllowed((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) if (current.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [data, dataUpdatedAt]);

  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);

  const loadRules = useCallback(async (pod: PodDenies) => {
    const key = podKey(pod);
    try {
      const res = await fetch(
        `/api/network/pod-rules?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.pod)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as RulesResponse;
      // Normalize: the API may omit ingress/egress when unavailable — keep them
      // arrays so consumers can spread/iterate without guarding everywhere.
      const normalized: RulesResponse = {
        available: body.available ?? false,
        ingress: body.ingress ?? [],
        egress: body.egress ?? [],
      };
      setRules((r) => ({ ...r, [key]: normalized }));
    } catch {
      setRules((r) => ({ ...r, [key]: { available: false, ingress: [], egress: [] } }));
    }
  }, []);

  const performAllow = useCallback(
    async (pod: PodDenies, direction: Direction, peer: BlockedDestination, bidirectional: boolean): Promise<AllowOutcome> => {
      try {
        const res = await fetch("/api/network/blocked-flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: pod.namespace, pod: pod.pod, direction, peer, bidirectional }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        toast.success(
          body.bothSides
            ? `Opened ${peer.target} both ways for ${podKey(pod)}`
            : `Opened ${peer.target} for ${podKey(pod)}`,
        );
        if (rules[podKey(pod)]) loadRules(pod);
        return { ok: true };
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open this flow");
        return { ok: false };
      }
    },
    [rules, loadRules],
  );

  // Commit an optimistic removal: the row exits, then the next poll confirms it
  // is gone for good. Kept separate from performAllow so the success animation
  // can play first.
  const commitAllowed = useCallback((id: string) => {
    setAllowed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const removeRule = useCallback(
    async (pod: PodDenies, rule: AllowedRuleEntry): Promise<AllowOutcome> => {
      try {
        const res = await fetch("/api/network/pod-rules", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace: rule.namespace,
            policyName: rule.policyName,
            direction: rule.direction,
            index: rule.index,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        toast.success(
          body.deletedPolicy ? `Re-sealed — removed the last rule in ${rule.policyName}` : `Removed exception from ${rule.policyName}`,
        );
        await loadRules(pod);
        return { ok: true };
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not remove this exception");
        return { ok: false };
      }
    },
    [loadRules],
  );

  const pods = useMemo<PodDenies[]>(() => {
    const src = data?.pods ?? [];
    if (allowed.size === 0) return src;
    return src
      .map((p) => ({
        ...p,
        egress: p.egress.filter((d) => !allowed.has(flowId(p, "egress", d))),
        ingress: p.ingress.filter((d) => !allowed.has(flowId(p, "ingress", d))),
      }))
      .filter((p) => p.egress.length > 0 || p.ingress.length > 0);
  }, [data, allowed]);

  const stats = useMemo(() => {
    const flows = pods.reduce((s, p) => s + p.ingress.length + p.egress.length, 0);
    const dropsPerSec = pods.reduce((s, p) => s + (p.totalDropRate || 0), 0);
    return { pods: pods.length, flows, dropsPerSec };
  }, [pods]);

  return {
    data,
    loading: query.isLoading,
    error: query.error ? query.error.message : null,
    dataplaneLive: data?.dataplaneLive ?? false,
    windowMinutes: data?.windowMinutes ?? 10,
    pods,
    dropHistory,
    feed,
    rules,
    stats,
    reload,
    loadRules,
    performAllow,
    commitAllowed,
    removeRule,
  };
}
