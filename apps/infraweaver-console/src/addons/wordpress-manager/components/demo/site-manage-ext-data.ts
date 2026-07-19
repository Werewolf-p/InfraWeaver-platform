// ─────────────────────────────────────────────────────────────────────────────
// ALL DATA IN THIS FILE IS FAKE / DEMO. This is the *extended* per-site manage
// dataset — the second wave of WordPress-manager surfaces that go beyond the core
// nine (staging/deploys, WooCommerce, content, uptime/incidents, email, server
// resources, forms, media, clients/care-plans, alerts, logs, audits). It layers
// on top of site-manage-data.ts and shares the same determinism guarantees:
// everything is derived from the site name via mulberry32 — no Math.random /
// Date.now — so server and client always agree.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from "./primitives";
import type { DayStatus } from "./primitives";
import { siteSeed, type CheckState } from "./site-manage-data";

function pick<T>(list: readonly T[], roll: number): T {
  return list[Math.min(list.length - 1, Math.floor(roll * list.length))];
}

function seededSeries(seed: number, count: number, base: number, spread: number, drift = 0): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 3.1) * spread * 0.4;
    const noise = (rand() - 0.5) * spread;
    out.push(Math.round((base + wave + noise + drift * i) * 100) / 100);
  }
  return out;
}

const WHEN = ["just now", "2m ago", "9m ago", "31m ago", "1h ago", "3h ago", "6h ago", "yesterday"] as const;
const NAMES = ["Ava Bakker", "Liam de Vries", "Noa Jansen", "Sofie Visser", "Daan Smit", "Emma Meijer", "Sem Mulder", "Julia Bos"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface StagingEnv {
  readonly name: "staging" | "dev";
  readonly url: string;
  readonly phpMatchesProd: boolean;
  readonly lastSynced: string;
  readonly aheadFiles: number;
  readonly aheadDbRows: number;
}
export interface DeployRow {
  readonly id: string;
  readonly when: string;
  readonly direction: "push-to-prod" | "pull-from-prod";
  readonly scope: "full" | "files" | "db";
  readonly by: string;
  readonly status: "success" | "failed" | "running";
  readonly commit: string;
}
export interface StagingData {
  readonly hasStaging: boolean;
  readonly envs: readonly StagingEnv[];
  readonly deploys: readonly DeployRow[];
}

export interface OrderRow {
  readonly id: string;
  readonly customer: string;
  readonly total: number;
  readonly status: "processing" | "completed" | "refunded" | "pending";
  readonly when: string;
}
export interface ProductRow {
  readonly name: string;
  readonly sold: number;
  readonly revenue: number;
  readonly stock: number;
}
export interface StoreData {
  readonly enabled: boolean;
  readonly revenue30d: number;
  readonly orders30d: number;
  readonly aov: number;
  readonly refunds30d: number;
  readonly conversion: number;
  readonly revenueTrend: readonly { day: string; amount: number }[];
  readonly topProducts: readonly ProductRow[];
  readonly lowStock: readonly { name: string; stock: number }[];
  readonly abandonedCarts: number;
  readonly abandonedValue: number;
  readonly recentOrders: readonly OrderRow[];
}

export interface ContentItem {
  readonly title: string;
  readonly type: "post" | "page";
  readonly status: "published" | "draft" | "scheduled" | "pending";
  readonly author: string;
  readonly when: string;
}
export interface ContentData {
  readonly posts: number;
  readonly pages: number;
  readonly drafts: number;
  readonly scheduled: number;
  readonly pending: number;
  readonly media: number;
  readonly revisionsCleanable: number;
  readonly recent: readonly ContentItem[];
  readonly upcoming: readonly { title: string; when: string }[];
}

export interface Incident {
  readonly id: string;
  readonly started: string;
  readonly duration: string;
  readonly cause: string;
  readonly impact: "major" | "minor";
  readonly resolved: boolean;
}
export interface RegionCheck {
  readonly region: string;
  readonly ms: number;
  readonly up: boolean;
}
export interface UptimeData {
  readonly slaPct: number;
  readonly status: "operational" | "degraded" | "down";
  readonly regions: readonly RegionCheck[];
  readonly incidents: readonly Incident[];
  readonly days90: readonly DayStatus[];
  readonly statusPageUrl: string;
}

export interface EmailLogRow {
  readonly to: string;
  readonly subject: string;
  readonly status: "delivered" | "bounced" | "deferred" | "spam";
  readonly when: string;
  readonly source: string;
}
export interface EmailData {
  readonly provider: string;
  readonly connected: boolean;
  readonly fromAddress: string;
  readonly spf: boolean;
  readonly dkim: boolean;
  readonly dmarc: boolean;
  readonly deliverabilityScore: number;
  readonly sent: number;
  readonly delivered: number;
  readonly bounced: number;
  readonly spam: number;
  readonly opened: number;
  readonly clicked: number;
  readonly log: readonly EmailLogRow[];
}

export interface ResourcesData {
  readonly planName: string;
  readonly cpuCores: number;
  readonly ramGb: number;
  readonly diskGb: number;
  readonly bandwidthTb: number;
  readonly cpuPct: number;
  readonly ramPct: number;
  readonly diskPct: number;
  readonly bandwidthPct: number;
  readonly phpWorkersBusy: number;
  readonly phpWorkersTotal: number;
  readonly cpuTrend: readonly { t: string; pct: number }[];
  readonly ramTrend: readonly { t: string; pct: number }[];
  readonly visitsMonth: number;
}

export interface FormEntry {
  readonly id: string;
  readonly form: string;
  readonly name: string;
  readonly email: string;
  readonly when: string;
  readonly spam: boolean;
}
export interface FormsData {
  readonly forms: readonly { name: string; entries30d: number; conversion: number }[];
  readonly totalEntries: number;
  readonly spamBlocked: number;
  readonly recentEntries: readonly FormEntry[];
}

export interface MediaData {
  readonly libraryCount: number;
  readonly librarySizeGb: number;
  readonly optimized: number;
  readonly unoptimized: number;
  readonly savedGb: number;
  readonly savingsPct: number;
  readonly webpCoverage: number;
  readonly largest: readonly { name: string; sizeMb: number; optimized: boolean }[];
}

export interface CareTask {
  readonly label: string;
  readonly cadence: "weekly" | "monthly" | "quarterly";
  readonly lastDone: string;
  readonly done: boolean;
}
export interface InvoiceRow {
  readonly id: string;
  readonly period: string;
  readonly amount: number;
  readonly status: "paid" | "due";
}
export interface ClientsData {
  readonly clientName: string;
  readonly plan: "Care Basic" | "Care Pro" | "Care Ultimate";
  readonly mrr: number;
  readonly since: string;
  readonly sitesManaged: number;
  readonly whiteLabelBranded: boolean;
  readonly brandInitials: string;
  readonly portalUrl: string;
  readonly careTasks: readonly CareTask[];
  readonly invoices: readonly InvoiceRow[];
}

export interface AlertChannel {
  readonly kind: "email" | "slack" | "sms" | "webhook";
  readonly target: string;
  readonly enabled: boolean;
}
export interface AlertRule {
  readonly event: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly channel: string;
  readonly enabled: boolean;
}
export interface AlertsData {
  readonly channels: readonly AlertChannel[];
  readonly rules: readonly AlertRule[];
  readonly recent: readonly { event: string; when: string; severity: "critical" | "high" | "medium" | "low"; channel: string }[];
}

export interface AccessLogRow {
  readonly method: "GET" | "POST" | "HEAD";
  readonly path: string;
  readonly status: 200 | 301 | 404 | 500 | 403;
  readonly ip: string;
  readonly when: string;
}
export interface ErrorLogRow {
  readonly level: "error" | "warning" | "notice";
  readonly message: string;
  readonly when: string;
}
export interface LogsData {
  readonly requests24h: number;
  readonly errors24h: number;
  readonly access: readonly AccessLogRow[];
  readonly errors: readonly ErrorLogRow[];
}

export interface AuditIssue {
  readonly rule: string;
  readonly impact: "critical" | "serious" | "moderate" | "minor";
  readonly count: number;
}
export interface AuditData {
  readonly a11yScore: number;
  readonly a11yIssues: readonly AuditIssue[];
  readonly seoScore: number;
  readonly seoChecks: readonly { label: string; state: CheckState; detail: string }[];
}

export interface SiteManageExt {
  readonly staging: StagingData;
  readonly store: StoreData;
  readonly content: ContentData;
  readonly uptime: UptimeData;
  readonly email: EmailData;
  readonly resources: ResourcesData;
  readonly forms: FormsData;
  readonly media: MediaData;
  readonly clients: ClientsData;
  readonly alerts: AlertsData;
  readonly logs: LogsData;
  readonly audit: AuditData;
}

// ── Builder (memoised per site) ──────────────────────────────────────────────

const cache = new Map<string, SiteManageExt>();

export function getSiteManageExt(site: string): SiteManageExt {
  const hit = cache.get(site);
  if (hit) return hit;
  const built = build(site);
  cache.set(site, built);
  return built;
}

function money(n: number): number {
  return Math.round(n);
}

function build(site: string): SiteManageExt {
  const seed = siteSeed(site);
  const r = mulberry32(seed ^ 0x9e3779b9);
  const roll = () => r();

  // ── Staging & deployments ──
  const hasStaging = roll() > 0.25;
  const staging: StagingData = {
    hasStaging,
    envs: hasStaging
      ? [
          {
            name: "staging",
            url: `staging.${site}.demo.example`,
            phpMatchesProd: roll() > 0.3,
            lastSynced: pick(WHEN, roll()),
            aheadFiles: Math.floor(roll() * 40),
            aheadDbRows: Math.floor(roll() * 900),
          },
        ]
      : [],
    deploys: Array.from({ length: 5 }, (_, i) => {
      const dr = mulberry32(seed + 2000 + i * 17);
      return {
        id: `dep-${i}`,
        when: pick(WHEN, dr()),
        direction: dr() > 0.35 ? "push-to-prod" : "pull-from-prod",
        scope: pick(["full", "files", "db"] as const, dr()),
        by: pick(NAMES, dr()),
        status: i === 0 && dr() > 0.7 ? "running" : dr() > 0.85 ? "failed" : "success",
        commit: Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(dr() * 16)]).join(""),
      };
    }),
  };

  // ── WooCommerce / store ──
  const storeEnabled = roll() > 0.35;
  const rev = 8000 + Math.floor(roll() * 60000);
  const orders = 60 + Math.floor(roll() * 700);
  const store: StoreData = {
    enabled: storeEnabled,
    revenue30d: money(rev),
    orders30d: orders,
    aov: money(rev / Math.max(1, orders)),
    refunds30d: money(rev * (0.01 + roll() * 0.05)),
    conversion: Math.round((1.2 + roll() * 3.5) * 100) / 100,
    revenueTrend: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => ({
      day,
      amount: money((rev / 7) * (0.7 + Math.sin(i / 1.4) * 0.25 + roll() * 0.2)),
    })),
    topProducts: [
      { name: "Signature Hoodie", sold: 40 + Math.floor(roll() * 220), revenue: money(rev * 0.24), stock: Math.floor(roll() * 60) },
      { name: "Canvas Tote", sold: 30 + Math.floor(roll() * 160), revenue: money(rev * 0.16), stock: Math.floor(roll() * 120) },
      { name: "Enamel Mug", sold: 20 + Math.floor(roll() * 120), revenue: money(rev * 0.11), stock: Math.floor(roll() * 8) },
      { name: "Sticker Pack", sold: 60 + Math.floor(roll() * 300), revenue: money(rev * 0.06), stock: 200 + Math.floor(roll() * 400) },
    ],
    lowStock: [
      { name: "Enamel Mug", stock: Math.floor(roll() * 6) },
      { name: "Limited Print", stock: Math.floor(roll() * 4) },
    ],
    abandonedCarts: 8 + Math.floor(roll() * 40),
    abandonedValue: money(rev * (0.05 + roll() * 0.15)),
    recentOrders: Array.from({ length: 6 }, (_, i) => {
      const or = mulberry32(seed + 2200 + i * 13);
      return {
        id: `#${10480 + i}`,
        customer: pick(NAMES, or()),
        total: money(20 + or() * 340),
        status: pick(["processing", "completed", "completed", "pending", "refunded"] as const, or()),
        when: pick(WHEN, or()),
      };
    }),
  };

  // ── Content ──
  const posts = 40 + Math.floor(roll() * 600);
  const content: ContentData = {
    posts,
    pages: 6 + Math.floor(roll() * 40),
    drafts: Math.floor(roll() * 14),
    scheduled: Math.floor(roll() * 6),
    pending: Math.floor(roll() * 5),
    media: 200 + Math.floor(roll() * 4000),
    revisionsCleanable: Math.floor(roll() * 800),
    recent: Array.from({ length: 6 }, (_, i) => {
      const cr = mulberry32(seed + 2400 + i * 11);
      return {
        title: pick(["Summer sale is live", "2026 product roadmap", "How we cut load time in half", "Release notes 4.2", "Meet the team", "Pricing, explained"], cr()),
        type: cr() > 0.7 ? "page" : "post",
        status: pick(["published", "published", "draft", "scheduled", "pending"] as const, cr()),
        author: pick(NAMES, cr()),
        when: pick(WHEN, cr()),
      };
    }),
    upcoming: Array.from({ length: 3 }, (_, i) => {
      const ur = mulberry32(seed + 2500 + i * 7);
      return { title: pick(["Black Friday teaser", "Case study: Northwind", "Q3 changelog", "Holiday gift guide"], ur()), when: pick(["tomorrow, 09:00", "in 2 days", "Fri, 14:00", "next Mon"], ur()) };
    }),
  };

  // ── Uptime & incidents ──
  const sla = Math.round((99.5 + roll() * 0.49) * 100) / 100;
  const uptime: UptimeData = {
    slaPct: sla,
    status: sla > 99.9 ? "operational" : roll() > 0.5 ? "degraded" : "operational",
    regions: [
      { region: "Amsterdam", ms: 40 + Math.floor(roll() * 60), up: true },
      { region: "Frankfurt", ms: 55 + Math.floor(roll() * 70), up: true },
      { region: "New York", ms: 90 + Math.floor(roll() * 90), up: roll() > 0.1 },
      { region: "Singapore", ms: 180 + Math.floor(roll() * 140), up: roll() > 0.08 },
    ],
    incidents: Array.from({ length: 4 }, (_, i) => {
      const ir = mulberry32(seed + 2600 + i * 19);
      return {
        id: `inc-${i}`,
        started: pick(["Jul 12, 03:14", "Jul 08, 21:40", "Jun 29, 11:02", "Jun 15, 07:55"], ir()),
        duration: pick(["4m", "12m", "38m", "1h 6m"], ir()),
        cause: pick(["Origin 502 — PHP-FPM saturated", "SSL renewal hiccup", "DB connection spike", "Upstream DNS timeout"], ir()),
        impact: ir() > 0.6 ? "major" : "minor",
        resolved: i > 0 || ir() > 0.3,
      };
    }),
    days90: Array.from({ length: 90 }, (_, i) => {
      const dr = mulberry32(seed + 2700 + i);
      const v = dr();
      if (v > 0.97) return "down" as DayStatus;
      if (v > 0.91) return "degraded" as DayStatus;
      return "up" as DayStatus;
    }),
    statusPageUrl: `status.${site}.demo.example`,
  };

  // ── Email & deliverability ──
  const sent = 400 + Math.floor(roll() * 6000);
  const bounced = Math.floor(sent * (0.005 + roll() * 0.03));
  const spam = Math.floor(sent * (roll() * 0.01));
  const delivered = sent - bounced - spam;
  const email: EmailData = {
    provider: pick(["Postmark", "Amazon SES", "SendGrid", "Mailgun"], roll()),
    connected: roll() > 0.12,
    fromAddress: `no-reply@${site}.demo.example`,
    spf: roll() > 0.15,
    dkim: roll() > 0.2,
    dmarc: roll() > 0.45,
    deliverabilityScore: 70 + Math.floor(roll() * 29),
    sent,
    delivered,
    bounced,
    spam,
    opened: Math.floor(delivered * (0.3 + roll() * 0.4)),
    clicked: Math.floor(delivered * (0.05 + roll() * 0.2)),
    log: Array.from({ length: 6 }, (_, i) => {
      const er = mulberry32(seed + 2800 + i * 23);
      return {
        to: `${pick(["ava", "liam", "noa", "sofie", "daan"], er())}@example.com`,
        subject: pick(["Your order has shipped", "Password reset", "Welcome to the newsletter", "Invoice #10492", "New comment on your post"], er()),
        status: pick(["delivered", "delivered", "delivered", "deferred", "bounced", "spam"] as const, er()),
        when: pick(WHEN, er()),
        source: pick(["WooCommerce", "wp-core", "Newsletter", "Contact Form 7"], er()),
      };
    }),
  };

  // ── Server resources ──
  const resources: ResourcesData = {
    planName: pick(["Scale-2", "Business-4", "Pro-8", "Startup-1"], roll()),
    cpuCores: pick([1, 2, 4, 8], roll()),
    ramGb: pick([2, 4, 8, 16], roll()),
    diskGb: pick([20, 40, 80, 160], roll()),
    bandwidthTb: pick([1, 2, 5, 10], roll()),
    cpuPct: 18 + Math.floor(roll() * 70),
    ramPct: 30 + Math.floor(roll() * 60),
    diskPct: 25 + Math.floor(roll() * 60),
    bandwidthPct: 10 + Math.floor(roll() * 75),
    phpWorkersBusy: Math.floor(roll() * 6),
    phpWorkersTotal: pick([4, 6, 8, 12], roll()),
    cpuTrend: seededSeries(seed + 2900, 24, 40, 30).map((pct, i) => ({ t: `${String(i).padStart(2, "0")}:00`, pct: Math.min(100, Math.max(2, Math.round(pct))) })),
    ramTrend: seededSeries(seed + 2950, 24, 55, 20).map((pct, i) => ({ t: `${String(i).padStart(2, "0")}:00`, pct: Math.min(100, Math.max(2, Math.round(pct))) })),
    visitsMonth: 20000 + Math.floor(roll() * 400000),
  };

  // ── Forms & leads ──
  const formList = [
    { name: "Contact", entries30d: 20 + Math.floor(roll() * 200), conversion: Math.round((10 + roll() * 40) * 10) / 10 },
    { name: "Newsletter signup", entries30d: 40 + Math.floor(roll() * 500), conversion: Math.round((20 + roll() * 50) * 10) / 10 },
    { name: "Quote request", entries30d: 5 + Math.floor(roll() * 60), conversion: Math.round((5 + roll() * 25) * 10) / 10 },
  ];
  const forms: FormsData = {
    forms: formList,
    totalEntries: formList.reduce((s, f) => s + f.entries30d, 0),
    spamBlocked: 10 + Math.floor(roll() * 400),
    recentEntries: Array.from({ length: 6 }, (_, i) => {
      const fr = mulberry32(seed + 3000 + i * 29);
      const spamE = fr() > 0.75;
      return {
        id: `ent-${i}`,
        form: pick(["Contact", "Newsletter signup", "Quote request"], fr()),
        name: spamE ? "Buy-Cheap-Now" : pick(NAMES, fr()),
        email: spamE ? "spam@bad.example" : `${pick(["ava", "liam", "noa"], fr())}@example.com`,
        when: pick(WHEN, fr()),
        spam: spamE,
      };
    }),
  };

  // ── Media & image optimization ──
  const libraryCount = 300 + Math.floor(roll() * 5000);
  const optimized = Math.floor(libraryCount * (0.4 + roll() * 0.55));
  const media: MediaData = {
    libraryCount,
    librarySizeGb: Math.round((1 + roll() * 12) * 100) / 100,
    optimized,
    unoptimized: libraryCount - optimized,
    savedGb: Math.round((0.5 + roll() * 6) * 100) / 100,
    savingsPct: 30 + Math.floor(roll() * 45),
    webpCoverage: 40 + Math.floor(roll() * 58),
    largest: Array.from({ length: 5 }, (_, i) => {
      const mr = mulberry32(seed + 3100 + i * 13);
      return {
        name: pick(["hero-banner.png", "team-photo.jpg", "product-gallery-04.jpg", "background-video-poster.png", "infographic-2026.png"], mr()),
        sizeMb: Math.round((1.2 + mr() * 6) * 100) / 100,
        optimized: mr() > 0.5,
      };
    }),
  };

  // ── Clients & care plans ──
  const plan = pick(["Care Basic", "Care Pro", "Care Ultimate"] as const, roll());
  const mrr = plan === "Care Basic" ? 49 : plan === "Care Pro" ? 99 : 199;
  const clients: ClientsData = {
    clientName: pick(["Northwind Co.", "Helios Media", "Meridian Studio", "Cobalt Labs", "Verdant Group"], roll()),
    plan,
    mrr,
    since: pick(["Jan 2024", "Sep 2024", "Mar 2025", "Nov 2025"], roll()),
    sitesManaged: 1 + Math.floor(roll() * 8),
    whiteLabelBranded: roll() > 0.3,
    brandInitials: site.slice(0, 2).toUpperCase(),
    portalUrl: `portal.${site}.demo.example`,
    careTasks: [
      { label: "Monthly maintenance report sent", cadence: "monthly", lastDone: "Jul 1", done: roll() > 0.2 },
      { label: "Backups verified restorable", cadence: "weekly", lastDone: "Mon", done: roll() > 0.15 },
      { label: "Plugin & core updates applied", cadence: "weekly", lastDone: "Tue", done: roll() > 0.2 },
      { label: "Security scan reviewed", cadence: "weekly", lastDone: "Wed", done: roll() > 0.25 },
      { label: "Performance audit", cadence: "quarterly", lastDone: "Apr 2026", done: roll() > 0.4 },
    ],
    invoices: [
      { id: "INV-0142", period: "July 2026", amount: mrr, status: roll() > 0.5 ? "paid" : "due" },
      { id: "INV-0141", period: "June 2026", amount: mrr, status: "paid" },
      { id: "INV-0140", period: "May 2026", amount: mrr, status: "paid" },
    ],
  };

  // ── Notifications & alerts ──
  const alerts: AlertsData = {
    channels: [
      { kind: "email", target: `ops@${site}.demo.example`, enabled: true },
      { kind: "slack", target: "#site-alerts", enabled: roll() > 0.3 },
      { kind: "sms", target: "+31 6 •• •• •• 42", enabled: roll() > 0.6 },
      { kind: "webhook", target: "https://hooks.demo.example/wp", enabled: roll() > 0.7 },
    ],
    rules: [
      { event: "Site down / 5xx", severity: "critical", channel: "email + sms", enabled: true },
      { event: "SSL expires < 14 days", severity: "high", channel: "email", enabled: true },
      { event: "Security vulnerability found", severity: "high", channel: "email + slack", enabled: roll() > 0.2 },
      { event: "Backup failed", severity: "medium", channel: "email", enabled: roll() > 0.15 },
      { event: "Response time > 800ms", severity: "low", channel: "slack", enabled: roll() > 0.5 },
    ],
    recent: Array.from({ length: 5 }, (_, i) => {
      const ar = mulberry32(seed + 3300 + i * 17);
      return {
        event: pick(["SSL renewed automatically", "Backup completed", "Blocked 240 login attempts", "Response time spike resolved", "Plugin update applied"], ar()),
        when: pick(WHEN, ar()),
        severity: pick(["critical", "high", "medium", "low"] as const, ar()),
        channel: pick(["email", "slack", "email + sms"], ar()),
      };
    }),
  };

  // ── Logs ──
  const logs: LogsData = {
    requests24h: 20000 + Math.floor(roll() * 400000),
    errors24h: Math.floor(roll() * 240),
    access: Array.from({ length: 8 }, (_, i) => {
      const lr = mulberry32(seed + 3400 + i * 13);
      return {
        method: pick(["GET", "GET", "GET", "POST", "HEAD"] as const, lr()),
        path: pick(["/", "/shop", "/wp-login.php", "/wp-json/wp/v2/posts", "/cart", "/wp-admin/admin-ajax.php", "/feed"], lr()),
        status: pick([200, 200, 200, 301, 404, 403, 500] as const, lr()),
        ip: `${45 + Math.floor(lr() * 200)}.${Math.floor(lr() * 255)}.${Math.floor(lr() * 255)}.${Math.floor(lr() * 255)}`,
        when: pick(WHEN, lr()),
      };
    }),
    errors: Array.from({ length: 5 }, (_, i) => {
      const lr = mulberry32(seed + 3500 + i * 19);
      return {
        level: pick(["error", "warning", "warning", "notice"] as const, lr()),
        message: pick([
          "PHP Fatal error: Allowed memory size exhausted in plugin.php",
          "PHP Warning: Undefined array key \"variation_id\"",
          "WordPress database error: Deadlock found when trying to get lock",
          "cURL error 28: Operation timed out after 10000ms",
          "PHP Deprecated: strlen(): Passing null to parameter #1",
        ], lr()),
        when: pick(WHEN, lr()),
      };
    }),
  };

  // ── Accessibility & SEO audit ──
  const audit: AuditData = {
    a11yScore: 62 + Math.floor(roll() * 36),
    a11yIssues: [
      { rule: "Images missing alt text", impact: "serious", count: Math.floor(roll() * 24) },
      { rule: "Insufficient color contrast", impact: "serious", count: Math.floor(roll() * 18) },
      { rule: "Links without discernible text", impact: "moderate", count: Math.floor(roll() * 10) },
      { rule: "Form inputs missing labels", impact: "critical", count: Math.floor(roll() * 5) },
      { rule: "Heading levels skipped", impact: "minor", count: Math.floor(roll() * 8) },
    ],
    seoScore: 60 + Math.floor(roll() * 38),
    seoChecks: [
      { label: "Title tags unique & sized", state: roll() > 0.4 ? "good" : "recommended", detail: "Every page should have a unique 30–60 char title." },
      { label: "Meta descriptions present", state: roll() > 0.5 ? "good" : "recommended", detail: "Missing on some posts — auto-generate or write them." },
      { label: "XML sitemap submitted", state: roll() > 0.25 ? "good" : "critical", detail: "Submit sitemap.xml in Search Console." },
      { label: "Structured data (schema)", state: roll() > 0.6 ? "good" : "recommended", detail: "Add Article / Product schema for rich results." },
      { label: "No thin content", state: roll() > 0.5 ? "good" : "recommended", detail: "Pages under 300 words rank poorly." },
      { label: "Canonical URLs set", state: roll() > 0.35 ? "good" : "recommended", detail: "Avoid duplicate-content dilution." },
    ],
  };

  return { staging, store, content, uptime, email, resources, forms, media, clients, alerts, logs, audit };
}
