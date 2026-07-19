/**
 * Store panel probe — WooCommerce revenue, orders (by status), product count,
 * recent orders and low-stock, read live over `wp-cli`. WooCommerce MUST be loaded
 * for the shop CPTs to resolve, so the CPT reads use `WP` (full — no
 * `--skip-plugins`). Gross revenue and low-stock come from guarded `wp db query`
 * aggregates against the real table prefix. Every read is wrapped so one failure
 * (missing table, briefly-down DB) yields an empty value instead of sinking the
 * panel. Gated on the `woocommerce` capability — the dispatcher refuses this panel
 * on a site without WooCommerce, so `fetch` only ever runs on a real store.
 * Read-only: WooCommerce has no allow-listed mutation, so the panel renders no
 * action buttons.
 */
import { WP, kvLine, parseKv, parseJsonArray, toInt, toNum, toStr, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** One WooCommerce order-status bucket (wc-processing, wc-completed, …). */
export interface StoreStatusCount {
  /** Human status key without the `wc-` prefix (processing, completed, on-hold, pending). */
  readonly status: string;
  readonly label: string;
  readonly count: number;
}

export interface RecentStoreOrder {
  readonly id: string;
  readonly date: string | null;
  /** Order status without the `wc-` prefix. */
  readonly status: string;
}

export interface StoreData {
  /** WooCommerce store currency code (e.g. EUR), or null when unreadable. */
  readonly currency: string | null;
  /** Lifetime gross = SUM(_order_total) across all orders, or null when unreadable. */
  readonly grossRevenue: number | null;
  readonly totalOrders: number;
  readonly productCount: number;
  /** Products at or below 2 units of stock. */
  readonly lowStockCount: number;
  readonly ordersByStatus: readonly StoreStatusCount[];
  readonly recentOrders: readonly RecentStoreOrder[];
}

type OrderRow = {
  ID?: string | number;
  post_date?: string;
  post_status?: string;
};

/** The four order statuses we count, in display order. */
const STATUS_BUCKETS: readonly { key: string; status: string; label: string }[] = [
  { key: "ORD_PROCESSING", status: "processing", label: "Processing" },
  { key: "ORD_COMPLETED", status: "completed", label: "Completed" },
  { key: "ORD_ONHOLD", status: "on-hold", label: "On hold" },
  { key: "ORD_PENDING", status: "pending", label: "Pending" },
];

/** Strip WooCommerce's `wc-` status prefix for display. */
function stripWcPrefix(status: string): string {
  return status.startsWith("wc-") ? status.slice(3) : status;
}

export function parseStore(input: { scalars: string; recent: string; revenue: string; lowStock: string }): StoreData {
  const kv = parseKv(input.scalars);
  const count = (key: string): number => toInt(kv.get(key)) ?? 0;

  const ordersByStatus: StoreStatusCount[] = STATUS_BUCKETS.map((bucket) => ({
    status: bucket.status,
    label: bucket.label,
    count: count(bucket.key),
  }));

  const recentOrders: RecentStoreOrder[] = parseJsonArray<OrderRow>(input.recent).map((row) => {
    const id = row.ID;
    return {
      id: id === undefined || id === null ? "—" : String(id),
      date: fieldStr(row, "post_date"),
      status: stripWcPrefix(fieldStr(row, "post_status") ?? "pending"),
    };
  });

  return {
    currency: toStr(input.scalars ? kv.get("CURRENCY") : undefined),
    grossRevenue: toNum(input.revenue),
    totalOrders: count("ORDERS_TOTAL"),
    productCount: count("PRODUCTS"),
    lowStockCount: toInt(input.lowStock) ?? 0,
    ordersByStatus,
    recentOrders,
  };
}

async function fetchStore(ctx: PanelProbeContext): Promise<StoreData> {
  // One shell batch for every plain count/option read (no nested quoting). The two
  // aggregate `wp db query` reads run separately because they carry their own
  // double-quoted SQL that can't be nested inside kvLine's `echo "KEY=$(…)"`.
  const scalarsCmd = [
    kvLine("PRODUCTS", `${WP} post list --post_type=product --post_status=publish --format=count`),
    kvLine("ORDERS_TOTAL", `${WP} post list --post_type=shop_order --format=count`),
    kvLine("ORD_PROCESSING", `${WP} post list --post_type=shop_order --post_status=wc-processing --format=count`),
    kvLine("ORD_COMPLETED", `${WP} post list --post_type=shop_order --post_status=wc-completed --format=count`),
    kvLine("ORD_ONHOLD", `${WP} post list --post_type=shop_order --post_status=wc-on-hold --format=count`),
    kvLine("ORD_PENDING", `${WP} post list --post_type=shop_order --post_status=wc-pending --format=count`),
    kvLine("CURRENCY", `${WP} option get woocommerce_currency`),
  ].join("\n");

  // `\\\`` emits a literal backslash-backtick so the shell (inside the double-quoted
  // SQL) treats the backtick as a literal identifier quote for MySQL rather than a
  // command substitution; `$(wp … db prefix)` expands to the site's real table prefix.
  const revenueCmd = `${WP} db query "SELECT ROUND(SUM(meta_value),2) FROM \\\`$(wp --allow-root db prefix)postmeta\\\` WHERE meta_key='_order_total'" --skip-column-names 2>/dev/null`;
  const lowStockCmd = `${WP} db query "SELECT COUNT(*) FROM \\\`$(wp --allow-root db prefix)postmeta\\\` WHERE meta_key='_stock' AND CAST(meta_value AS SIGNED) <= 2" --skip-column-names 2>/dev/null`;

  const [scalars, recent, revenue, lowStock] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP} post list --post_type=shop_order --posts_per_page=8 --format=json --fields=ID,post_date,post_status`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx.exec(revenueCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(lowStockCmd).then((r) => r.stdout).catch(() => ""),
  ]);

  return parseStore({ scalars, recent, revenue, lowStock });
}

export const storeProbe: PanelProbe<StoreData> = {
  id: "store",
  requiresCapability: "woocommerce",
  fetch: fetchStore,
};
