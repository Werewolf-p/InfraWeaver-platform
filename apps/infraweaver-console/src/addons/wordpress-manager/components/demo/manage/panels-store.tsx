"use client";

// Store panel — live WooCommerce revenue, orders by status, products and low stock.
// Read-only: WooCommerce has no allow-listed Manage mutation, so there are no actions.

import { AlertTriangle, Coins, Package, Receipt, ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoreData } from "../../../lib/manage/probes/store";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
type PillTone = "good" | "info" | "warn" | "critical" | "neutral";
const PILL: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const STATUS_TONE: Readonly<Record<string, PillTone>> = {
  completed: "good",
  processing: "info",
  "on-hold": "warn",
  pending: "neutral",
  refunded: "critical",
  cancelled: "critical",
  failed: "critical",
};

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥", AUD: "$", CAD: "$" };

function currencyPrefix(code: string | null): string {
  if (!code) return "";
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

function statusTone(status: string): PillTone {
  return STATUS_TONE[status] ?? "neutral";
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, " ");
}

export function StorePanel({ site }: { site: string }) {
  const state = useManagePanel<StoreData>(site, "store");

  return (
    <PanelState state={state}>
      {(data) => {
        const symbol = currencyPrefix(data.currency);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
              <StatTile
                label="Gross revenue"
                value={data.grossRevenue ?? 0}
                decimals={2}
                prefix={symbol}
                icon={Coins}
                tone={healthTone(85)}
              />
              <StatTile label="Orders" value={data.totalOrders} icon={ShoppingCart} tone={healthTone(80)} />
              <StatTile label="Products" value={data.productCount} icon={Package} tone={healthTone(80)} />
              <StatTile
                label="Low stock (≤2)"
                value={data.lowStockCount}
                icon={AlertTriangle}
                tone={healthTone(data.lowStockCount === 0 ? 95 : data.lowStockCount < 5 ? 60 : 40)}
              />
            </div>

            <SectionCard
              title="Orders by status"
              description={`${data.totalOrders.toLocaleString("en-US")} orders in total${data.currency ? ` · ${data.currency}` : ""}.`}
              icon={Receipt}
            >
              <ul className="space-y-2">
                {data.ordersByStatus.map((bucket) => (
                  <li key={bucket.status} className={cn("flex items-center justify-between gap-3", TILE)}>
                    <span className={cn(PILL_BASE, PILL[statusTone(bucket.status)])}>{bucket.label}</span>
                    <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {bucket.count.toLocaleString("en-US")}
                    </span>
                  </li>
                ))}
              </ul>
              <div className={cn("mt-3 flex items-center justify-between gap-3", TILE)}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Low stock</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">Products at or below 2 units in stock.</p>
                </div>
                <span
                  className={cn(PILL_BASE, PILL[data.lowStockCount === 0 ? "good" : data.lowStockCount < 5 ? "warn" : "critical"])}
                >
                  {data.lowStockCount} low
                </span>
              </div>
            </SectionCard>

            <SectionCard title="Recent orders" description="The latest orders placed on this store." icon={ShoppingCart}>
              {data.recentOrders.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  No orders yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                        <th className="py-2 pr-4 font-medium">Order</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 font-medium">Placed</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                      {data.recentOrders.map((order) => (
                        <tr key={order.id} className="text-zinc-700 dark:text-zinc-300">
                          <td className="py-2 pr-4 font-mono text-[11px]">#{order.id}</td>
                          <td className="py-2 pr-4">
                            <span className={cn(PILL_BASE, PILL[statusTone(order.status)])}>{statusLabel(order.status)}</span>
                          </td>
                          <td className="py-2 text-zinc-500 dark:text-zinc-400">{order.date ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
