// ─────────────────────────────────────────────────────────────────────────────
// ALL DATA IN THIS FILE IS FAKE / DEMO. Nothing here reflects real site state,
// real security posture, real uptime, real backups or real analytics. It exists
// only to preview what a full-fleet WordPress management surface could look like.
// Every widget rendered from this data is labelled with a <DummyBadge/>.
//
// Determinism: the longer series below are built with a *seeded* PRNG (mulberry32),
// never Math.random() or Date.now(). The same numbers are produced on the server
// and the client on every render, so there are no hydration mismatches.
// ─────────────────────────────────────────────────────────────────────────────

/** Seeded, deterministic PRNG. Same seed → same sequence, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function series(seed: number, count: number, base: number, spread: number, drift = 0): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 3.1) * spread * 0.4;
    const noise = (rand() - 0.5) * spread;
    out.push(Math.round((base + wave + noise + drift * i) * 100) / 100);
  }
  return out;
}

export type HealthStatus = "healthy" | "attention" | "critical" | "offline";

export interface DemoSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: HealthStatus;
  /** Composite health score, 0–100. */
  readonly health: number;
  readonly uptime: number;
  readonly responseMs: number;
  readonly updates: { readonly core: number; readonly plugins: number; readonly themes: number };
  readonly php: string;
  readonly spark: readonly number[];
  readonly lastBackup: string;
  readonly sslDaysLeft: number;
  readonly visitors7d: number;
}

export const DEMO_SITES: readonly DemoSite[] = [
  {
    id: "aurora-blog",
    name: "aurora-blog",
    url: "aurora-blog.demo.example",
    status: "healthy",
    health: 96,
    uptime: 99.99,
    responseMs: 214,
    updates: { core: 0, plugins: 1, themes: 0 },
    php: "8.3",
    spark: series(11, 24, 95, 6),
    lastBackup: "42m ago",
    sslDaysLeft: 61,
    visitors7d: 18420,
  },
  {
    id: "northwind-store",
    name: "northwind-store",
    url: "shop.northwind.demo.example",
    status: "attention",
    health: 78,
    uptime: 99.94,
    responseMs: 486,
    updates: { core: 1, plugins: 4, themes: 1 },
    php: "8.2",
    spark: series(23, 24, 80, 14),
    lastBackup: "2h ago",
    sslDaysLeft: 23,
    visitors7d: 51240,
  },
  {
    id: "helios-docs",
    name: "helios-docs",
    url: "docs.helios.demo.example",
    status: "healthy",
    health: 91,
    uptime: 99.98,
    responseMs: 176,
    updates: { core: 0, plugins: 2, themes: 0 },
    php: "8.3",
    spark: series(37, 24, 90, 8),
    lastBackup: "1h ago",
    sslDaysLeft: 88,
    visitors7d: 9310,
  },
  {
    id: "meridian-agency",
    name: "meridian-agency",
    url: "meridian.demo.example",
    status: "critical",
    health: 52,
    uptime: 99.61,
    responseMs: 912,
    updates: { core: 1, plugins: 7, themes: 2 },
    php: "8.1",
    spark: series(53, 24, 58, 22, -0.3),
    lastBackup: "9h ago",
    sslDaysLeft: 6,
    visitors7d: 27890,
  },
  {
    id: "cobalt-labs",
    name: "cobalt-labs",
    url: "cobalt-labs.demo.example",
    status: "healthy",
    health: 88,
    uptime: 99.97,
    responseMs: 232,
    updates: { core: 0, plugins: 0, themes: 0 },
    php: "8.3",
    spark: series(67, 24, 87, 9),
    lastBackup: "18m ago",
    sslDaysLeft: 44,
    visitors7d: 6120,
  },
  {
    id: "verdant-cms",
    name: "verdant-cms",
    url: "verdant.demo.example",
    status: "offline",
    health: 0,
    uptime: 97.12,
    responseMs: 0,
    updates: { core: 0, plugins: 3, themes: 0 },
    php: "8.0",
    spark: series(89, 24, 30, 30, -1.1),
    lastBackup: "1d ago",
    sslDaysLeft: 31,
    visitors7d: 3040,
  },
] as const;

export interface FleetSummary {
  readonly total: number;
  readonly healthy: number;
  readonly attention: number;
  readonly critical: number;
  readonly offline: number;
  readonly updatesPending: number;
  readonly avgUptime: number;
  readonly avgResponse: number;
  readonly backupsHealthy: number;
}

export const FLEET_SUMMARY: FleetSummary = {
  total: DEMO_SITES.length,
  healthy: DEMO_SITES.filter((s) => s.status === "healthy").length,
  attention: DEMO_SITES.filter((s) => s.status === "attention").length,
  critical: DEMO_SITES.filter((s) => s.status === "critical").length,
  offline: DEMO_SITES.filter((s) => s.status === "offline").length,
  updatesPending: DEMO_SITES.reduce((n, s) => n + s.updates.core + s.updates.plugins + s.updates.themes, 0),
  avgUptime: 99.94,
  avgResponse: 372,
  backupsHealthy: 5,
};

// ── Pending updates trend (stacked bar, last 8 weeks) ────────────────────────
export interface UpdatesPoint {
  readonly label: string;
  readonly core: number;
  readonly plugins: number;
  readonly themes: number;
}

const UPDATE_WEEK_LABELS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"] as const;
export const UPDATES_TREND: readonly UpdatesPoint[] = (() => {
  const rc = mulberry32(101);
  const rp = mulberry32(202);
  const rt = mulberry32(303);
  return UPDATE_WEEK_LABELS.map((label) => ({
    label,
    core: Math.round(rc() * 3),
    plugins: 4 + Math.round(rp() * 12),
    themes: Math.round(rt() * 3),
  }));
})();

// ── Uptime 90-day strip ──────────────────────────────────────────────────────
export type DayStatus = "up" | "degraded" | "down";
export const UPTIME_90: readonly DayStatus[] = (() => {
  const rand = mulberry32(7);
  return Array.from({ length: 90 }, () => {
    const r = rand();
    if (r > 0.965) return "down";
    if (r > 0.9) return "degraded";
    return "up";
  });
})();

export interface ResponsePoint {
  readonly t: string;
  readonly ms: number;
}
export const RESPONSE_TREND: readonly ResponsePoint[] = series(19, 24, 320, 120).map((ms, i) => ({
  t: `${String(i).padStart(2, "0")}:00`,
  ms: Math.max(90, Math.round(ms)),
}));

// ── Backups ──────────────────────────────────────────────────────────────────
export interface BackupPoint {
  readonly day: string;
  readonly sizeGb: number;
}
const BACKUP_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const BACKUP_TREND: readonly BackupPoint[] = BACKUP_DAY_LABELS.map((day, i) => ({
  day,
  sizeGb: Math.round((3.8 + Math.sin(i / 1.7) * 0.6 + i * 0.12) * 100) / 100,
}));

export interface RestorePoint {
  readonly id: string;
  readonly when: string;
  readonly size: string;
  readonly type: "automatic" | "manual";
  readonly status: "complete";
}
export const RESTORE_POINTS: readonly RestorePoint[] = [
  { id: "rp-1", when: "Today, 03:00", size: "4.6 GB", type: "automatic", status: "complete" },
  { id: "rp-2", when: "Yesterday, 03:00", size: "4.5 GB", type: "automatic", status: "complete" },
  { id: "rp-3", when: "2 days ago, 14:12", size: "4.5 GB", type: "manual", status: "complete" },
  { id: "rp-4", when: "3 days ago, 03:00", size: "4.4 GB", type: "automatic", status: "complete" },
  { id: "rp-5", when: "4 days ago, 03:00", size: "4.4 GB", type: "automatic", status: "complete" },
];

// ── Security ─────────────────────────────────────────────────────────────────
export interface WafPoint {
  readonly t: string;
  readonly blocked: number;
}
export const WAF_TREND: readonly WafPoint[] = series(43, 24, 140, 90, 1.4).map((v, i) => ({
  t: `${String(i).padStart(2, "0")}:00`,
  blocked: Math.max(0, Math.round(v)),
}));

export const MALWARE_SCAN = { clean: 5, flagged: 1 } as const;

export type Severity = "critical" | "high" | "medium" | "low";
export interface Vulnerability {
  readonly id: string;
  readonly component: string;
  readonly version: string;
  readonly severity: Severity;
  readonly cve: string;
  readonly site: string;
  readonly patchAvailable: boolean;
}
export const VULNERABILITIES: readonly Vulnerability[] = [
  { id: "v1", component: "Contact Form Builder", version: "3.1.2", severity: "critical", cve: "CVE-2026-31842", site: "meridian-agency", patchAvailable: true },
  { id: "v2", component: "WooCommerce", version: "9.4.0", severity: "high", cve: "CVE-2026-30117", site: "northwind-store", patchAvailable: true },
  { id: "v3", component: "SEO Toolkit", version: "5.9.1", severity: "medium", cve: "CVE-2026-29455", site: "meridian-agency", patchAvailable: true },
  { id: "v4", component: "Gallery Slider", version: "2.2.0", severity: "medium", cve: "CVE-2026-28901", site: "aurora-blog", patchAvailable: false },
  { id: "v5", component: "Cache Optimizer", version: "1.7.3", severity: "low", cve: "CVE-2026-27760", site: "helios-docs", patchAvailable: true },
];

export const SEVERITY_COUNTS: Readonly<Record<Severity, number>> = {
  critical: VULNERABILITIES.filter((v) => v.severity === "critical").length,
  high: VULNERABILITIES.filter((v) => v.severity === "high").length,
  medium: VULNERABILITIES.filter((v) => v.severity === "medium").length,
  low: VULNERABILITIES.filter((v) => v.severity === "low").length,
};

// ── Performance ──────────────────────────────────────────────────────────────
export const PAGESPEED = { mobile: 74, desktop: 96 } as const;

export interface CoreWebVital {
  readonly label: string;
  readonly full: string;
  readonly value: string;
  readonly score: number;
  readonly rating: "good" | "needs-improvement" | "poor";
}
export const CORE_WEB_VITALS: readonly CoreWebVital[] = [
  { label: "LCP", full: "Largest Contentful Paint", value: "1.9s", score: 88, rating: "good" },
  { label: "INP", full: "Interaction to Next Paint", value: "142ms", score: 82, rating: "good" },
  { label: "CLS", full: "Cumulative Layout Shift", value: "0.11", score: 63, rating: "needs-improvement" },
];

export interface PerfPoint {
  readonly t: string;
  readonly mobile: number;
  readonly desktop: number;
}
export const PERF_TREND: readonly PerfPoint[] = (() => {
  const m = series(71, 14, 70, 10, 0.4);
  const d = series(72, 14, 92, 5, 0.15);
  const labels = ["", "", "", "", "", "", "", "", "", "", "", "", "", ""].map((_, i) => `D${i + 1}`);
  return labels.map((t, i) => ({
    t,
    mobile: Math.min(100, Math.max(0, Math.round(m[i]))),
    desktop: Math.min(100, Math.max(0, Math.round(d[i]))),
  }));
})();

// ── PHP error monitoring ─────────────────────────────────────────────────────
export interface PhpPoint {
  readonly t: string;
  readonly errors: number;
}
export const PHP_TREND: readonly PhpPoint[] = series(83, 24, 6, 8, -0.05).map((v, i) => ({
  t: `${String(i).padStart(2, "0")}:00`,
  errors: Math.max(0, Math.round(v)),
}));

export interface PhpError {
  readonly id: string;
  readonly message: string;
  readonly count: number;
  readonly level: "fatal" | "warning" | "notice";
  readonly site: string;
}
export const PHP_ERRORS: readonly PhpError[] = [
  { id: "e1", message: "Uncaught TypeError: array_map(): Argument #2 must be of type array", count: 34, level: "fatal", site: "meridian-agency" },
  { id: "e2", message: "Trying to access array offset on value of type null", count: 128, level: "warning", site: "northwind-store" },
  { id: "e3", message: "Undefined array key \"variation_id\"", count: 71, level: "warning", site: "northwind-store" },
  { id: "e4", message: "Deprecated: strlen(): Passing null to parameter #1", count: 210, level: "notice", site: "aurora-blog" },
];

// ── Traffic analytics ────────────────────────────────────────────────────────
export interface TrafficPoint {
  readonly t: string;
  readonly visitors: number;
}
const TRAFFIC_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const TRAFFIC_TREND: readonly TrafficPoint[] = TRAFFIC_DAY_LABELS.map((t, i) => ({
  t,
  visitors: Math.round(9000 + Math.sin(i / 1.3) * 2600 + i * 420),
}));

export interface TopPage {
  readonly path: string;
  readonly views: number;
  readonly site: string;
}
export const TOP_PAGES: readonly TopPage[] = [
  { path: "/", views: 42180, site: "northwind-store" },
  { path: "/shop/new-arrivals", views: 18940, site: "northwind-store" },
  { path: "/blog/2026-roadmap", views: 12310, site: "aurora-blog" },
  { path: "/docs/getting-started", views: 8760, site: "helios-docs" },
  { path: "/pricing", views: 6420, site: "meridian-agency" },
];

// ── Attention feed ───────────────────────────────────────────────────────────
export interface AttentionItem {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly site: string;
  readonly when: string;
}
export const ATTENTION_FEED: readonly AttentionItem[] = [
  { id: "a1", severity: "critical", title: "Site unreachable — 502 from origin", site: "verdant-cms", when: "8m ago" },
  { id: "a2", severity: "critical", title: "Critical plugin vulnerability (CVE-2026-31842)", site: "meridian-agency", when: "1h ago" },
  { id: "a3", severity: "high", title: "SSL certificate expires in 6 days", site: "meridian-agency", when: "3h ago" },
  { id: "a4", severity: "high", title: "7 pending updates, 2 flagged as security", site: "meridian-agency", when: "3h ago" },
  { id: "a5", severity: "medium", title: "Response time above 480ms for 20 min", site: "northwind-store", when: "5h ago" },
  { id: "a6", severity: "low", title: "Backup size grew 12% week-over-week", site: "northwind-store", when: "Yesterday" },
];

// ── Activity / audit log ─────────────────────────────────────────────────────
export type ActivityKind = "update" | "backup" | "security" | "login" | "deploy";
export interface ActivityItem {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly when: string;
  readonly kind: ActivityKind;
}
export const ACTIVITY_LOG: readonly ActivityItem[] = [
  { id: "l1", actor: "auto-updater", action: "Applied security update", target: "WooCommerce 9.3.1 → 9.4.0", when: "12m ago", kind: "update" },
  { id: "l2", actor: "backup agent", action: "Completed scheduled backup", target: "aurora-blog (4.6 GB)", when: "42m ago", kind: "backup" },
  { id: "l3", actor: "firewall", action: "Blocked 218 malicious requests", target: "northwind-store", when: "1h ago", kind: "security" },
  { id: "l4", actor: "remon@demo", action: "Signed in from new device", target: "console", when: "2h ago", kind: "login" },
  { id: "l5", actor: "safe-update", action: "Rolled back failed update", target: "meridian-agency · Gallery Slider", when: "4h ago", kind: "deploy" },
  { id: "l6", actor: "auto-updater", action: "Applied 3 plugin updates", target: "helios-docs", when: "6h ago", kind: "update" },
];

// ── Safe / smart update check ────────────────────────────────────────────────
export interface SafeUpdateCheck {
  readonly id: string;
  readonly component: string;
  readonly site: string;
  readonly visualDiff: number;
  readonly result: "pass" | "fail" | "review";
}
export const SAFE_UPDATES: readonly SafeUpdateCheck[] = [
  { id: "s1", component: "Yoast SEO 22.4", site: "aurora-blog", visualDiff: 0.2, result: "pass" },
  { id: "s2", component: "Elementor 3.21", site: "cobalt-labs", visualDiff: 1.1, result: "pass" },
  { id: "s3", component: "Gallery Slider 2.3", site: "meridian-agency", visualDiff: 14.8, result: "fail" },
  { id: "s4", component: "WP Rocket 3.16", site: "helios-docs", visualDiff: 3.6, result: "review" },
];

// ── Bulk update runner ───────────────────────────────────────────────────────
export interface BulkUpdateRow {
  readonly id: string;
  readonly site: string;
  readonly component: string;
  readonly from: string;
  readonly to: string;
  readonly progress: number;
  readonly state: "queued" | "running" | "done" | "failed";
}
export const BULK_UPDATES: readonly BulkUpdateRow[] = [
  { id: "b1", site: "aurora-blog", component: "WordPress core", from: "6.6.1", to: "6.6.2", progress: 100, state: "done" },
  { id: "b2", site: "helios-docs", component: "WP Rocket", from: "3.15", to: "3.16", progress: 100, state: "done" },
  { id: "b3", site: "northwind-store", component: "WooCommerce", from: "9.3.1", to: "9.4.0", progress: 64, state: "running" },
  { id: "b4", site: "cobalt-labs", component: "Elementor", from: "3.20", to: "3.21", progress: 38, state: "running" },
  { id: "b5", site: "meridian-agency", component: "Gallery Slider", from: "2.2", to: "2.3", progress: 12, state: "failed" },
  { id: "b6", site: "verdant-cms", component: "Akismet", from: "5.3", to: "5.3.1", progress: 0, state: "queued" },
];

// ── White-label client report ────────────────────────────────────────────────
export interface ClientReport {
  readonly period: string;
  readonly visitors: number;
  readonly uptime: number;
  readonly updatesApplied: number;
  readonly threatsBlocked: number;
  readonly backupsTaken: number;
  readonly avgPerformance: number;
  readonly avgResponseMs: number;
}
export const CLIENT_REPORT: ClientReport = {
  period: "June 2026",
  visitors: 124030,
  uptime: 99.96,
  updatesApplied: 47,
  threatsBlocked: 5312,
  backupsTaken: 30,
  avgPerformance: 88,
  avgResponseMs: 296,
};
