// ─────────────────────────────────────────────────────────────────────────────
// ALL DATA IN THIS FILE IS FAKE / DEMO. It powers the per-site "Manage" console
// preview (updates, plugins, themes, backups, security, performance, users,
// database, SEO, health, activity). Nothing here reflects a real WordPress site.
// Every surface rendered from it is labelled with a <DummyBadge/> + <DemoBanner/>.
//
// Determinism: everything is derived from the *site name* through a seeded PRNG
// (mulberry32), never Math.random() / Date.now(). The same site name always
// yields the same numbers on server and client, so there is no hydration drift
// and no two demo sites look identical.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from "./primitives";

/** FNV-1a hash of the site name → a stable 32-bit seed. */
export function siteSeed(site: string): number {
  let h = 2166136261;
  for (let i = 0; i < site.length; i += 1) {
    h ^= site.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic pick from a list, biased by a 0..1 roll. */
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

// ── Types ────────────────────────────────────────────────────────────────────

export type UpdateType = "security" | "feature" | "minor";

export interface PluginItem {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly latest: string;
  readonly active: boolean;
  readonly autoUpdate: boolean;
  readonly updateType: UpdateType | null; // null = up to date
  readonly vulnerable: boolean;
  readonly author: string;
}

export interface ThemeItem {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly latest: string;
  readonly active: boolean;
  readonly updateAvailable: boolean;
  readonly swatch: string; // tailwind bg for the fake screenshot tile
}

export interface CoreStatus {
  readonly current: string;
  readonly latest: string;
  readonly upToDate: boolean;
  readonly php: string;
  readonly channel: "stable";
  readonly autoUpdateMinor: boolean;
}

export interface BackupPlan {
  readonly frequency: "hourly" | "daily" | "weekly";
  readonly retentionDays: number;
  readonly destination: string;
  readonly nextRun: string;
  readonly lastRun: string;
  readonly lastSize: string;
  readonly encrypted: boolean;
  readonly offsite: boolean;
}

export interface RestoreRow {
  readonly id: string;
  readonly when: string;
  readonly size: string;
  readonly type: "automatic" | "manual" | "pre-update";
  readonly trigger: string;
}

export type CheckState = "good" | "recommended" | "critical";
export interface HealthCheck {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface LoginAttempt {
  readonly ip: string;
  readonly country: string;
  readonly user: string;
  readonly attempts: number;
  readonly when: string;
  readonly blocked: boolean;
}

export interface SslInfo {
  readonly issuer: string;
  readonly protocol: string;
  readonly expiresDays: number;
  readonly autoRenew: boolean;
  readonly grade: "A+" | "A" | "B";
}

export interface WpUser {
  readonly login: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: "administrator" | "editor" | "author" | "contributor" | "subscriber";
  readonly posts: number;
  readonly lastSeen: string;
  readonly twoFactor: boolean;
}

export interface CommentItem {
  readonly id: string;
  readonly author: string;
  readonly excerpt: string;
  readonly onPost: string;
  readonly status: "pending" | "spam";
  readonly when: string;
}

export interface DbTable {
  readonly name: string;
  readonly rows: number;
  readonly sizeMb: number;
  readonly overheadKb: number;
  readonly engine: "InnoDB" | "MyISAM";
}

export interface StorageSlice {
  readonly label: string;
  readonly gb: number;
  readonly color: string;
}

export interface BrokenLink {
  readonly url: string;
  readonly foundOn: string;
  readonly code: 404 | 500 | 301 | 0; // 0 = timeout
  readonly when: string;
}

export interface KeywordRank {
  readonly term: string;
  readonly position: number;
  readonly delta: number;
  readonly volume: number;
}

export interface CronEvent {
  readonly hook: string;
  readonly schedule: "hourly" | "twicedaily" | "daily" | "weekly";
  readonly nextRun: string;
}

export interface EnvInfo {
  readonly wp: string;
  readonly php: string;
  readonly mysql: string;
  readonly server: string;
  readonly memoryLimit: string;
  readonly maxUpload: string;
  readonly diskUsedPct: number;
  readonly objectCache: "Redis" | "Memcached" | "none";
}

export interface SiteManageData {
  readonly core: CoreStatus;
  readonly plugins: readonly PluginItem[];
  readonly themes: readonly ThemeItem[];
  readonly updatesTrend: readonly { label: string; core: number; plugins: number; themes: number }[];
  readonly backup: BackupPlan;
  readonly restorePoints: readonly RestoreRow[];
  readonly backupSizeTrend: readonly { day: string; sizeGb: number }[];
  readonly malware: { readonly clean: number; readonly flagged: number; readonly lastScan: string };
  readonly wafTrend: readonly { t: string; blocked: number }[];
  readonly loginAttempts: readonly LoginAttempt[];
  readonly ssl: SslInfo;
  readonly hardening: readonly HealthCheck[];
  readonly pagespeed: { readonly mobile: number; readonly desktop: number };
  readonly cwv: readonly { label: string; full: string; value: string; score: number }[];
  readonly perfTrend: readonly { t: string; mobile: number; desktop: number }[];
  readonly cache: { readonly hitRate: number; readonly engine: string; readonly cdn: string };
  readonly responseTrend: readonly { t: string; ms: number }[];
  readonly phpErrors: readonly { message: string; count: number; level: "fatal" | "warning" | "notice" }[];
  readonly users: readonly WpUser[];
  readonly comments: readonly CommentItem[];
  readonly dbTables: readonly DbTable[];
  readonly dbTotalMb: number;
  readonly dbOverheadMb: number;
  readonly storage: readonly StorageSlice[];
  readonly trafficTrend: readonly { t: string; visitors: number }[];
  readonly topPages: readonly { path: string; views: number }[];
  readonly brokenLinks: readonly BrokenLink[];
  readonly keywords: readonly KeywordRank[];
  readonly seo: { readonly indexed: number; readonly sitemapOk: boolean; readonly metaCoverage: number; readonly score: number };
  readonly siteHealth: readonly HealthCheck[];
  readonly env: EnvInfo;
  readonly cron: readonly CronEvent[];
  readonly activity: readonly { id: string; actor: string; action: string; target: string; when: string; kind: "update" | "backup" | "security" | "login" | "content" | "config" }[];
  readonly report: { readonly period: string; readonly visitors: number; readonly uptime: number; readonly updatesApplied: number; readonly threatsBlocked: number; readonly backupsTaken: number; readonly avgPerformance: number };
  readonly health: number; // composite 0-100
}

// ── Fixtures the generators draw from ────────────────────────────────────────

const PLUGIN_CATALOG: readonly { slug: string; name: string; author: string }[] = [
  { slug: "woocommerce", name: "WooCommerce", author: "Automattic" },
  { slug: "yoast-seo", name: "Yoast SEO", author: "Team Yoast" },
  { slug: "elementor", name: "Elementor", author: "Elementor.com" },
  { slug: "wp-rocket", name: "WP Rocket", author: "WP Media" },
  { slug: "contact-form-7", name: "Contact Form 7", author: "Takayuki Miyoshi" },
  { slug: "akismet", name: "Akismet Anti-Spam", author: "Automattic" },
  { slug: "wordfence", name: "Wordfence Security", author: "Defiant" },
  { slug: "advanced-custom-fields", name: "Advanced Custom Fields", author: "WP Engine" },
  { slug: "updraftplus", name: "UpdraftPlus Backups", author: "UpdraftPlus" },
  { slug: "redirection", name: "Redirection", author: "John Godley" },
  { slug: "wpforms", name: "WPForms Lite", author: "WPForms" },
  { slug: "jetpack", name: "Jetpack", author: "Automattic" },
  { slug: "gallery-slider", name: "Gallery Slider", author: "SliderLabs" },
  { slug: "smush", name: "Smush Image Optimizer", author: "WPMU DEV" },
];

const THEME_CATALOG: readonly { slug: string; name: string; swatch: string }[] = [
  { slug: "astra", name: "Astra", swatch: "from-sky-500/30 to-indigo-500/30" },
  { slug: "twentytwentyfour", name: "Twenty Twenty-Four", swatch: "from-zinc-500/30 to-zinc-700/30" },
  { slug: "kadence", name: "Kadence", swatch: "from-emerald-500/30 to-teal-500/30" },
  { slug: "generatepress", name: "GeneratePress", swatch: "from-blue-500/30 to-cyan-500/30" },
  { slug: "storefront", name: "Storefront", swatch: "from-violet-500/30 to-fuchsia-500/30" },
];

const COUNTRIES = ["RU", "CN", "BR", "IN", "US", "NL", "DE", "VN", "TR", "ID"] as const;
const FIRST = ["Ava", "Liam", "Noa", "Sofie", "Daan", "Emma", "Sem", "Julia", "Finn", "Mila", "Luuk", "Tess"] as const;
const LAST = ["Bakker", "de Vries", "Jansen", "Visser", "Smit", "Meijer", "Mulder", "Bos", "Vos", "Peters"] as const;

// ── Builder (memoised per site) ──────────────────────────────────────────────

const cache = new Map<string, SiteManageData>();

export function getSiteManageData(site: string): SiteManageData {
  const hit = cache.get(site);
  if (hit) return hit;
  const built = build(site);
  cache.set(site, built);
  return built;
}

function build(site: string): SiteManageData {
  const seed = siteSeed(site);
  const r = mulberry32(seed);
  const roll = () => r();

  // Core
  const coreUpToDate = roll() > 0.4;
  const core: CoreStatus = {
    current: coreUpToDate ? "6.7.1" : "6.6.2",
    latest: "6.7.1",
    upToDate: coreUpToDate,
    php: pick(["8.1", "8.2", "8.3", "8.4"], roll()),
    channel: "stable",
    autoUpdateMinor: roll() > 0.3,
  };

  // Plugins — deterministic subset & states
  const pluginCount = 7 + Math.floor(roll() * 6);
  const plugins: PluginItem[] = PLUGIN_CATALOG.slice(0, pluginCount).map((p, i) => {
    const pr = mulberry32(seed + i * 17);
    const hasUpdate = pr() > 0.55;
    const vulnerable = pr() > 0.88;
    const major = 3 + Math.floor(pr() * 6);
    const minor = Math.floor(pr() * 9);
    const updateType: UpdateType | null = !hasUpdate
      ? null
      : vulnerable
        ? "security"
        : pr() > 0.5
          ? "feature"
          : "minor";
    return {
      slug: p.slug,
      name: p.name,
      author: p.author,
      active: pr() > 0.2,
      autoUpdate: pr() > 0.5,
      version: `${major}.${minor}.${Math.floor(pr() * 5)}`,
      latest: hasUpdate ? `${major}.${minor + 1}.0` : `${major}.${minor}.${Math.floor(pr() * 5)}`,
      updateType,
      vulnerable,
    };
  });

  // Themes
  const themeCount = 2 + Math.floor(roll() * 3);
  const activeIdx = Math.floor(roll() * themeCount);
  const themes: ThemeItem[] = THEME_CATALOG.slice(0, themeCount).map((t, i) => {
    const tr = mulberry32(seed + 900 + i * 13);
    const upd = tr() > 0.6;
    const minor = Math.floor(tr() * 9);
    return {
      slug: t.slug,
      name: t.name,
      swatch: t.swatch,
      active: i === activeIdx,
      version: `${2 + Math.floor(tr() * 4)}.${minor}.0`,
      latest: upd ? `${2 + Math.floor(tr() * 4)}.${minor + 1}.0` : `${2 + Math.floor(tr() * 4)}.${minor}.0`,
      updateAvailable: upd,
    };
  });

  const pluginUpdates = plugins.filter((p) => p.updateType).length;
  const themeUpdates = themes.filter((t) => t.updateAvailable).length;

  const WEEK = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"];
  const updatesTrend = WEEK.map((label, i) => {
    const ur = mulberry32(seed + 400 + i);
    return { label, core: Math.round(ur() * 2), plugins: 1 + Math.round(ur() * 6), themes: Math.round(ur() * 2) };
  });

  // Backups
  const freq = pick(["hourly", "daily", "weekly"] as const, roll());
  const backup: BackupPlan = {
    frequency: freq,
    retentionDays: pick([7, 14, 30, 90], roll()),
    destination: pick(["S3 · eu-west-1", "Backblaze B2", "Google Drive", "Wasabi · eu-central"], roll()),
    nextRun: freq === "hourly" ? "in 24 min" : freq === "daily" ? "tonight, 03:00" : "Sunday, 03:00",
    lastRun: pick(["18m ago", "42m ago", "1h ago", "2h ago", "5h ago"], roll()),
    lastSize: `${(2.4 + roll() * 5).toFixed(1)} GB`,
    encrypted: roll() > 0.2,
    offsite: roll() > 0.15,
  };
  const restorePoints: RestoreRow[] = [
    { id: "rp-1", when: "Today, 03:00", size: backup.lastSize, type: "automatic", trigger: "schedule" },
    { id: "rp-2", when: "Yesterday, 03:00", size: `${(2.3 + roll() * 4).toFixed(1)} GB`, type: "automatic", trigger: "schedule" },
    { id: "rp-3", when: "2d ago, 14:02", size: `${(2.3 + roll() * 4).toFixed(1)} GB`, type: "pre-update", trigger: "WooCommerce 9.4.0" },
    { id: "rp-4", when: "3d ago, 09:11", size: `${(2.2 + roll() * 4).toFixed(1)} GB`, type: "manual", trigger: "operator" },
    { id: "rp-5", when: "4d ago, 03:00", size: `${(2.2 + roll() * 4).toFixed(1)} GB`, type: "automatic", trigger: "schedule" },
  ];
  const backupSizeTrend = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => ({
    day,
    sizeGb: Math.round((2.6 + Math.sin(i / 1.7) * 0.5 + i * 0.1 + roll() * 0.4) * 100) / 100,
  }));

  // Security
  const flagged = roll() > 0.75 ? 1 + Math.floor(roll() * 2) : 0;
  const malware = { clean: 240 + Math.floor(roll() * 60), flagged, lastScan: pick(["12m ago", "1h ago", "3h ago", "6h ago"], roll()) };
  const wafTrend = seededSeries(seed + 43, 24, 90, 70, 1.1).map((v, i) => ({ t: `${String(i).padStart(2, "0")}:00`, blocked: Math.max(0, Math.round(v)) }));
  const loginAttempts: LoginAttempt[] = Array.from({ length: 5 }, (_, i) => {
    const lr = mulberry32(seed + 700 + i * 29);
    return {
      ip: `${45 + Math.floor(lr() * 200)}.${Math.floor(lr() * 255)}.${Math.floor(lr() * 255)}.${Math.floor(lr() * 255)}`,
      country: pick(COUNTRIES, lr()),
      user: pick(["admin", "administrator", "root", "test", "wpuser"], lr()),
      attempts: 8 + Math.floor(lr() * 240),
      when: pick(["2m ago", "9m ago", "31m ago", "1h ago", "3h ago"], lr()),
      blocked: lr() > 0.1,
    };
  });
  const ssl: SslInfo = {
    issuer: pick(["Let's Encrypt R3", "Cloudflare Inc ECC", "ZeroSSL RSA"], roll()),
    protocol: "TLS 1.3",
    expiresDays: 6 + Math.floor(roll() * 84),
    autoRenew: roll() > 0.1,
    grade: pick(["A+", "A", "B"] as const, roll()),
  };
  const hardening: HealthCheck[] = [
    { id: "h-2fa", label: "Two-factor on all admins", state: roll() > 0.5 ? "good" : "recommended", detail: "Enforce 2FA for administrator and editor roles." },
    { id: "h-xmlrpc", label: "XML-RPC disabled", state: roll() > 0.4 ? "good" : "recommended", detail: "XML-RPC is a common brute-force and DDoS amplification vector." },
    { id: "h-fileedit", label: "File editor disabled", state: roll() > 0.5 ? "good" : "recommended", detail: "DISALLOW_FILE_EDIT blocks in-dashboard PHP editing." },
    { id: "h-version", label: "WP version hidden", state: roll() > 0.6 ? "good" : "recommended", detail: "Version fingerprinting helps target known CVEs." },
    { id: "h-admin", label: "No 'admin' username", state: roll() > 0.7 ? "good" : "critical", detail: "Default usernames are the first thing bots try." },
  ];

  // Performance
  const pagespeed = { mobile: 52 + Math.floor(roll() * 44), desktop: 78 + Math.floor(roll() * 21) };
  const cwv = [
    { label: "LCP", full: "Largest Contentful Paint", value: `${(1.4 + roll() * 2.2).toFixed(1)}s`, score: 55 + Math.floor(roll() * 44) },
    { label: "INP", full: "Interaction to Next Paint", value: `${80 + Math.floor(roll() * 220)}ms`, score: 60 + Math.floor(roll() * 39) },
    { label: "CLS", full: "Cumulative Layout Shift", value: `${(roll() * 0.24).toFixed(2)}`, score: 50 + Math.floor(roll() * 49) },
  ];
  const perfTrend = (() => {
    const m = seededSeries(seed + 71, 14, pagespeed.mobile, 8, 0.3);
    const d = seededSeries(seed + 72, 14, pagespeed.desktop, 4, 0.1);
    return m.map((_, i) => ({ t: `D${i + 1}`, mobile: Math.min(100, Math.max(0, Math.round(m[i]))), desktop: Math.min(100, Math.max(0, Math.round(d[i]))) }));
  })();
  const cache_ = { hitRate: 88 + Math.floor(roll() * 11), engine: pick(["WP Rocket", "LiteSpeed Cache", "W3 Total Cache"], roll()), cdn: pick(["Cloudflare", "BunnyCDN", "Fastly"], roll()) };
  const responseTrend = seededSeries(seed + 19, 24, 220 + roll() * 200, 110).map((ms, i) => ({ t: `${String(i).padStart(2, "0")}:00`, ms: Math.max(80, Math.round(ms)) }));
  const phpErrors = [
    { message: "Uncaught TypeError: array_map(): Argument #2 must be of type array", count: 8 + Math.floor(roll() * 40), level: "fatal" as const },
    { message: "Trying to access array offset on value of type null", count: 40 + Math.floor(roll() * 150), level: "warning" as const },
    { message: "Undefined array key \"variation_id\"", count: 20 + Math.floor(roll() * 80), level: "warning" as const },
    { message: "Deprecated: strlen(): Passing null to parameter #1", count: 80 + Math.floor(roll() * 200), level: "notice" as const },
  ];

  // Users & comments
  const userCount = 4 + Math.floor(roll() * 5);
  const roles: WpUser["role"][] = ["administrator", "editor", "author", "author", "contributor", "subscriber", "subscriber", "subscriber", "subscriber"];
  const users: WpUser[] = Array.from({ length: userCount }, (_, i) => {
    const ur = mulberry32(seed + 1100 + i * 31);
    const fn = pick(FIRST, ur());
    const ln = pick(LAST, ur());
    return {
      login: `${fn.toLowerCase()}.${ln.split(" ").pop()!.toLowerCase()}`,
      displayName: `${fn} ${ln}`,
      email: `${fn.toLowerCase()}@${site}.demo.example`,
      role: roles[i] ?? "subscriber",
      posts: i < 3 ? 4 + Math.floor(ur() * 120) : Math.floor(ur() * 6),
      lastSeen: pick(["just now", "12m ago", "2h ago", "yesterday", "3d ago", "2w ago"], ur()),
      twoFactor: i === 0 ? true : ur() > 0.5,
    };
  });
  const commentCount = Math.floor(roll() * 6);
  const comments: CommentItem[] = Array.from({ length: commentCount }, (_, i) => {
    const cr = mulberry32(seed + 1300 + i * 23);
    const spam = cr() > 0.5;
    return {
      id: `c-${i}`,
      author: spam ? pick(["Cheap-Meds-24", "SEO-Backlinks", "crypto_win"], cr()) : `${pick(FIRST, cr())} ${pick(LAST, cr())}`,
      excerpt: spam ? "Great article! Check out my site for the best deals on…" : "Really helped me get set up — thanks for the clear write-up.",
      onPost: pick(["/blog/getting-started", "/2026-roadmap", "/pricing", "/about"], cr()),
      status: spam ? "spam" : "pending",
      when: pick(["3m ago", "22m ago", "1h ago", "4h ago"], cr()),
    };
  });

  // Database & storage
  const dbTables: DbTable[] = [
    { name: "wp_posts", rows: 1200 + Math.floor(roll() * 40000), sizeMb: Math.round((6 + roll() * 40) * 10) / 10, overheadKb: Math.floor(roll() * 400), engine: "InnoDB" },
    { name: "wp_postmeta", rows: 8000 + Math.floor(roll() * 200000), sizeMb: Math.round((14 + roll() * 90) * 10) / 10, overheadKb: Math.floor(roll() * 900), engine: "InnoDB" },
    { name: "wp_options", rows: 300 + Math.floor(roll() * 4000), sizeMb: Math.round((1 + roll() * 22) * 10) / 10, overheadKb: Math.floor(roll() * 1400), engine: "InnoDB" },
    { name: "wp_comments", rows: 400 + Math.floor(roll() * 9000), sizeMb: Math.round((2 + roll() * 12) * 10) / 10, overheadKb: Math.floor(roll() * 200), engine: "InnoDB" },
    { name: "wp_users", rows: userCount, sizeMb: 0.1, overheadKb: 0, engine: "InnoDB" },
    { name: "wp_actionscheduler_actions", rows: 2000 + Math.floor(roll() * 60000), sizeMb: Math.round((3 + roll() * 30) * 10) / 10, overheadKb: Math.floor(roll() * 2200), engine: "InnoDB" },
  ];
  const dbTotalMb = Math.round(dbTables.reduce((s, t) => s + t.sizeMb, 0) * 10) / 10;
  const dbOverheadMb = Math.round((dbTables.reduce((s, t) => s + t.overheadKb, 0) / 1024) * 10) / 10;
  const storage: StorageSlice[] = [
    { label: "Uploads / media", gb: Math.round((1.5 + roll() * 8) * 10) / 10, color: "#0ea5e9" },
    { label: "Database", gb: Math.round((dbTotalMb / 1024) * 100) / 100, color: "#8b5cf6" },
    { label: "Plugins", gb: Math.round((0.2 + roll() * 0.9) * 100) / 100, color: "#10b981" },
    { label: "Themes", gb: Math.round((0.1 + roll() * 0.5) * 100) / 100, color: "#f59e0b" },
    { label: "Cache", gb: Math.round((0.3 + roll() * 1.6) * 100) / 100, color: "#f97316" },
  ];

  // Traffic & SEO
  const base = 4000 + Math.floor(roll() * 40000);
  const trafficTrend = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((t, i) => ({
    t,
    visitors: Math.round(base + Math.sin(i / 1.3) * base * 0.22 + i * base * 0.03),
  }));
  const topPages = [
    { path: "/", views: Math.round(base * 2.1) },
    { path: "/shop/new-arrivals", views: Math.round(base * 0.9) },
    { path: "/blog/2026-roadmap", views: Math.round(base * 0.6) },
    { path: "/pricing", views: Math.round(base * 0.4) },
    { path: "/contact", views: Math.round(base * 0.25) },
  ];
  const brokenLinks: BrokenLink[] = Array.from({ length: Math.floor(roll() * 5) }, (_, i) => {
    const br = mulberry32(seed + 1500 + i * 19);
    return {
      url: pick(["https://partner.example/old-promo", "/wp-content/uploads/2024/flyer.pdf", "https://cdn.example/img/hero.jpg", "/blog/deleted-post"], br()),
      foundOn: pick(["/", "/blog/2026-roadmap", "/about", "/pricing"], br()),
      code: pick([404, 500, 301, 0] as const, br()),
      when: pick(["scan 2h ago", "scan 2h ago", "scan 1d ago"], br()),
    };
  });
  const keywords: KeywordRank[] = Array.from({ length: 5 }, (_, i) => {
    const kr = mulberry32(seed + 1700 + i * 11);
    return {
      term: pick(["wordpress hosting", "managed wp", "ecommerce theme", "site speed", "wp security", "page builder", "seo plugin"], kr()),
      position: 1 + Math.floor(kr() * 40),
      delta: Math.floor((kr() - 0.5) * 12),
      volume: 200 + Math.floor(kr() * 18000),
    };
  });
  const seo = { indexed: 40 + Math.floor(roll() * 900), sitemapOk: roll() > 0.15, metaCoverage: 60 + Math.floor(roll() * 40), score: 62 + Math.floor(roll() * 36) };

  // Health & environment
  const siteHealth: HealthCheck[] = [
    { id: "sh-php", label: `PHP ${core.php}`, state: core.php >= "8.2" ? "good" : "recommended", detail: "Running a modern, supported PHP version." },
    { id: "sh-https", label: "HTTPS enabled", state: "good", detail: "Site is served over TLS." },
    { id: "sh-cron", label: "Scheduled events", state: roll() > 0.3 ? "good" : "recommended", detail: "WP-Cron is firing on schedule." },
    { id: "sh-rest", label: "REST API reachable", state: roll() > 0.2 ? "good" : "critical", detail: "The REST API responds to loopback requests." },
    { id: "sh-updates", label: "Background updates", state: core.autoUpdateMinor ? "good" : "recommended", detail: "Automatic minor-core updates are enabled." },
    { id: "sh-debug", label: "Debug mode off", state: roll() > 0.25 ? "good" : "critical", detail: "WP_DEBUG must be off in production." },
  ];
  const env: EnvInfo = {
    wp: core.current,
    php: core.php,
    mysql: pick(["MariaDB 10.11", "MySQL 8.0", "MariaDB 11.4"], roll()),
    server: pick(["nginx 1.27", "OpenLiteSpeed", "Apache 2.4"], roll()),
    memoryLimit: pick(["256M", "512M", "768M"], roll()),
    maxUpload: pick(["64M", "128M", "256M"], roll()),
    diskUsedPct: 30 + Math.floor(roll() * 55),
    objectCache: pick(["Redis", "Memcached", "none"] as const, roll()),
  };
  const cron: CronEvent[] = [
    { hook: "wp_scheduled_delete", schedule: "daily", nextRun: "in 6h" },
    { hook: "action_scheduler_run_queue", schedule: "hourly", nextRun: "in 24m" },
    { hook: "wp_update_plugins", schedule: "twicedaily", nextRun: "in 3h" },
    { hook: "backup_run", schedule: backup.frequency === "weekly" ? "weekly" : "daily", nextRun: backup.nextRun },
  ];

  // Activity & report
  const activity = [
    { id: "a1", actor: "auto-updater", action: "Applied security update", target: `${plugins[0]?.name ?? "WooCommerce"} → ${plugins[0]?.latest ?? "9.4.0"}`, when: "14m ago", kind: "update" as const },
    { id: "a2", actor: "backup agent", action: "Completed scheduled backup", target: `${site} (${backup.lastSize})`, when: backup.lastRun, kind: "backup" as const },
    { id: "a3", actor: "firewall", action: `Blocked ${20 + Math.floor(roll() * 300)} malicious requests`, target: "login + xmlrpc", when: "1h ago", kind: "security" as const },
    { id: "a4", actor: users[0]?.displayName ?? "operator", action: "Published a post", target: pick(["Summer sale is live", "2026 roadmap", "Release notes 4.2"], roll()), when: "3h ago", kind: "content" as const },
    { id: "a5", actor: "operator", action: "Toggled maintenance mode off", target: site, when: "5h ago", kind: "config" as const },
    { id: "a6", actor: "auto-updater", action: `Applied ${pluginUpdates + themeUpdates} updates`, target: site, when: "6h ago", kind: "update" as const },
  ];
  const report = {
    period: "June 2026",
    visitors: trafficTrend.reduce((s, d) => s + d.visitors, 0) * 4,
    uptime: Math.round((99.6 + roll() * 0.39) * 100) / 100,
    updatesApplied: 12 + Math.floor(roll() * 50),
    threatsBlocked: wafTrend.reduce((s, d) => s + d.blocked, 0),
    backupsTaken: backup.frequency === "hourly" ? 720 : 30,
    avgPerformance: Math.round((pagespeed.mobile + pagespeed.desktop) / 2),
  };

  // Composite health: penalise pending security updates, vulns, low pagespeed, expiring SSL
  const securityUpdates = plugins.filter((p) => p.updateType === "security").length + malware.flagged;
  const health = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        98 -
          securityUpdates * 9 -
          (core.upToDate ? 0 : 6) -
          Math.max(0, 90 - pagespeed.mobile) * 0.15 -
          (ssl.expiresDays < 14 ? 8 : 0),
      ),
    ),
  );

  return {
    core,
    plugins,
    themes,
    updatesTrend,
    backup,
    restorePoints,
    backupSizeTrend,
    malware,
    wafTrend,
    loginAttempts,
    ssl,
    hardening,
    pagespeed,
    cwv,
    perfTrend,
    cache: cache_,
    responseTrend,
    phpErrors,
    users,
    comments,
    dbTables,
    dbTotalMb,
    dbOverheadMb,
    storage,
    trafficTrend,
    topPages,
    brokenLinks,
    keywords,
    seo,
    siteHealth,
    env,
    cron,
    activity,
    report,
    health,
  };
}
