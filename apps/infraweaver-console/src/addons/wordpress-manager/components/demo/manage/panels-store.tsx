"use client";

// Store tab for the per-site "Manage" demo — WooCommerce revenue, orders, products, stock.
import { AlertTriangle, Euro, Package, Percent, Receipt, ShoppingCart, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, StatTile } from "../widgets";
import { DummyBadge } from "../DummyBadge";

type PillTone = "good" | "info" | "warn" | "critical" | "neutral";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const PILL: Record<PillTone, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const fmt = (n: number) => n.toLocaleString("en-US");

const ORDER_TONE: Record<"completed" | "processing" | "pending" | "refunded", PillTone> = {
  completed: "good",
  processing: "info",
  pending: "warn",
  refunded: "critical",
};
const ORDER_LABEL: Record<"completed" | "processing" | "pending" | "refunded", string> = {
  completed: "Completed",
  processing: "Processing",
  pending: "Pending",
  refunded: "Refunded",
};

export function StorePanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { store } = ext;

  if (!store.enabled) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
        WooCommerce not detected — this site isn&apos;t a store.
      </div>
    );
  }

  const maxRevenue = Math.max(...store.revenueTrend.map((d) => d.amount), 1);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
        <StatTile label="Revenue 30d" value={store.revenue30d} prefix="€" icon={Euro} />
        <StatTile label="Orders" value={store.orders30d} icon={ShoppingCart} />
        <StatTile label="AOV" value={store.aov} prefix="€" icon={Receipt} />
        <StatTile label="Conversion" value={store.conversion} decimals={2} suffix="%" icon={Percent} />
      </div>

      <SectionCard title="Revenue (7 days)" description="Daily takings for the past week." icon={TrendingUp} action={<DummyBadge />}>
        <div className="flex h-32 items-end gap-2">
          {store.revenueTrend.map((d) => (
            <div
              key={d.day}
              className="w-full flex-1 rounded-t bg-sky-500/70"
              style={{ height: `${(d.amount / maxRevenue) * 100}%` }}
              title={`€${fmt(d.amount)}`}
            />
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          {store.revenueTrend.map((d) => (
            <span key={d.day} className="flex-1 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
              {d.day}
            </span>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Top products" description="Best sellers over the last 30 days." icon={Package} action={<DummyBadge />}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Product</th>
                <th className="py-2 pr-4 text-right font-medium">Sold</th>
                <th className="py-2 pr-4 text-right font-medium">Revenue</th>
                <th className="py-2 font-medium">Stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {store.topProducts.map((p) => (
                <tr key={p.name} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{p.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{fmt(p.sold)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">€{fmt(p.revenue)}</td>
                  <td className="py-2">
                    {p.stock < 10 ? (
                      <span className={cn(PILL_BASE, PILL.warn)}>{p.stock} left</span>
                    ) : (
                      <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{fmt(p.stock)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Low stock" description="Products running low — restock soon." icon={AlertTriangle} action={<DummyBadge />}>
        {store.lowStock.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Everything is well stocked.
          </div>
        ) : (
          <ul className="space-y-2">
            {store.lowStock.map((s, i) => (
              <li key={`${s.name}-${i}`} className={cn("flex items-center gap-3", TILE)}>
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
                <span className={cn(PILL_BASE, PILL[s.stock < 3 ? "critical" : "warn"])}>{s.stock} in stock</span>
              </li>
            ))}
          </ul>
        )}
        <div className={cn("mt-3 flex items-center justify-between gap-3", TILE)}>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Abandoned carts</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Worth €{fmt(store.abandonedValue)} in recoverable revenue.</p>
          </div>
          <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmt(store.abandonedCarts)}</span>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Recent orders"
        description="The latest orders placed on this store."
        icon={ShoppingCart}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Order</th>
                <th className="py-2 pr-4 font-medium">Customer</th>
                <th className="py-2 pr-4 text-right font-medium">Total</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {store.recentOrders.map((o, i) => (
                <tr key={`${o.id}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{o.id}</td>
                  <td className="py-2 pr-4">{o.customer}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">€{fmt(o.total)}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL_BASE, PILL[ORDER_TONE[o.status]])}>{ORDER_LABEL[o.status]}</span>
                  </td>
                  <td className="py-2 text-zinc-500 dark:text-zinc-400">{o.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
