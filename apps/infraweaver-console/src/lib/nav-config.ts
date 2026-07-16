import {
  LayoutDashboard, Settings, Users, HardDrive,
  Network, Activity, Terminal, History, Cog,
  Package, FileText, ShieldCheck, Server,
  Sparkles, Home, Trash2, GitBranch, ArrowUpCircle,
  Globe, BellOff, Shield, HeartPulse,
  Calendar, Search, LayoutGrid, TestTube2, Puzzle, MemoryStick,
  KeyRound, Lock, Boxes, MessageSquarePlus,
} from "lucide-react";
import { mergeRegisteredPages, navItemFromPage } from "@/lib/page-registry";
import { ADDON_MANIFESTS } from "@/generated/addon-registry";
import { resolveAddonIcon } from "@/lib/addon-icons";

export interface NavItem {
  href: string;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  description?: string;
  badge?: string;
  pinnable?: boolean;
  keywords?: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  items: NavItem[];
}

// Nav items contributed by enabled-capable addons, derived from each addon
// manifest's `navItems` (group === "addons"). No hardcoded addon links — adding
// an addon manifest is enough to surface it. Runtime visibility is gated by the
// addon's enabled state via filterNavGroupsByAddons (and RBAC via NAV_REQUIREMENTS).
const ADDON_NAV_ITEMS = ADDON_MANIFESTS.flatMap((manifest) =>
  (manifest.navItems ?? [])
    .filter((nav) => nav.group === "addons")
    .map((nav) => ({
      href: nav.href,
      icon: resolveAddonIcon(nav.icon),
      label: nav.label,
      description: nav.description ?? manifest.description,
    })),
);

// ── Target IA: 7 RBAC-gated groups + a conditional Addons group ────────────────
// Groups auto-hide when RBAC grants none of their children
// (filterNavGroupsByPermissions) and the Addons group auto-hides when no addon
// is enabled (filterNavGroupsByAddons). Every legacy capability is preserved —
// relocated/merged, never deleted. See docs/ia-restructure-plan.md.
export const NAV_GROUPS: NavGroup[] = mergeRegisteredPages([
  {
    id: "overview",
    label: "Overview",
    description: "Home, dashboard, cluster, cost, and platform status",
    icon: Home,
    defaultOpen: true,
    items: [
      { href: "/home", icon: Home, label: "Home Portal", shortcut: "G O", description: "Platform overview and quick access", pinnable: true },
      { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D", description: "Real-time cluster metrics and status", pinnable: true },
      { href: "/cluster", icon: Boxes, label: "Cluster Nodes", shortcut: "G K", description: "Node management and cluster overview" },
      navItemFromPage("/cost"),
      { href: "/feedback", icon: MessageSquarePlus, label: "Feedback & Fix Flow", description: "Review reported issues, run the Claude fix pipeline, preview, and publish", keywords: ["feedback", "report", "bug", "feature request", "note", "claude", "fix", "review", "publish", "preview"] },
      navItemFromPage("/wiki"),
      { href: "/changelog", icon: Sparkles, label: "What's New", description: "Recent platform updates" },
    ],
  },
  {
    id: "workloads",
    label: "Workloads",
    description: "Pods, apps, services, and scaling",
    icon: Server,
    defaultOpen: true,
    items: [
      { href: "/apps", icon: LayoutGrid, label: "Apps", shortcut: "G A", description: "Install and manage all platform applications — drill into each app's pods and stop them", pinnable: true, keywords: ["pods", "workloads", "applications", "argocd", "stop", "scale"] },
      { href: "/all-services", icon: Search, label: "All Services", description: "Searchable index of every console page and service" },
      { href: "/app-graph", icon: Network, label: "App Graph", description: "Visual application dependency graph" },
      { href: "/cronjobs", icon: Calendar, label: "CronJobs", description: "Scheduled Kubernetes cronjobs" },
      { href: "/scheduled-tasks", icon: Calendar, label: "Scheduled Tasks", description: "View and manage scheduled operations" },
      { href: "/deployment-compare", icon: GitBranch, label: "Deploy Compare", description: "Diff current vs previous deployment" },
      { href: "/resource-optimizer", icon: Activity, label: "Optimizer", description: "Right-size CPU and memory requests" },
      { href: "/node-top", icon: Activity, label: "Node Metrics", description: "Live node CPU and memory usage" },
      { href: "/memory", icon: MemoryStick, label: "Memory Heatmap", description: "Namespace memory reservations and top consumers" },
      navItemFromPage("/quota"),
      { href: "/power-groups", icon: Boxes, label: "Power Groups", description: "Group apps and stop/start them as one unit", pinnable: true },
      { href: "/namespace-cleanup", icon: Trash2, label: "NS Cleanup", description: "Find and remove stale namespaces" },
      { href: "/pod-shell", icon: Terminal, label: "Pod Shell", description: "Browser-based terminal into pods" },
    ],
  },
  {
    id: "networking",
    label: "Networking",
    description: "Network, firewall, DNS, routes, and connectivity",
    icon: Network,
    defaultOpen: false,
    items: [
      { href: "/network", icon: Network, label: "Network", shortcut: "G N", description: "Service topology, NetworkPolicies, and Ingress", pinnable: true, keywords: ["services", "topology", "connectivity", "networkpolicy", "policies", "ingress", "traefik", "hosts"] },
      { href: "/network/firewall", icon: ShieldCheck, label: "Pod Security", description: "Recent denies per pod — allow with one click, remove allowed rules", pinnable: true, keywords: ["firewall", "cilium", "hubble", "denied", "allow", "ingress", "egress", "networkpolicy", "block"] },
      { href: "/network/wan", icon: Shield, label: "WAN Firewall", description: "All UDM port-forward rules — WAN ports opened to internal services", pinnable: true, keywords: ["firewall", "udm", "unifi", "port forward", "port-forward", "wan", "nat", "gateway", "router", "game", "expose"] },
      { href: "/routes", icon: Globe, label: "Routing & DNS", shortcut: "G Z", description: "Routes, DNS records, access modes, middleware, and port routing — view and edit in one place", pinnable: true, keywords: ["routes", "ingress", "traefik", "external routes", "port routing", "hosts", "tls", "tier", "dns", "cloudflare", "records", "domain", "middleware", "auth", "mode"] },
      { href: "/gameservers", icon: Network, label: "Port Routing", description: "DNS-based port routing for external services", keywords: ["ports", "tcp", "udp", "external services"] },
    ],
  },
  {
    id: "storage",
    label: "Storage & Config",
    description: "Volumes, backups, registry, config, and secrets",
    icon: HardDrive,
    defaultOpen: false,
    items: [
      { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S", description: "Volumes, usage timeline, PV browser, and backups", pinnable: true, keywords: ["pvc", "volumes", "storage classes", "timeline", "pv browser", "backups", "longhorn", "restore", "snapshot", "files"] },
      { href: "/registry", icon: Package, label: "Registry", shortcut: "G R", description: "Container image registry browser", keywords: ["images", "containers", "harbor"] },
      { href: "/config", icon: Cog, label: "Config", shortcut: "G C", description: "Config editor, ConfigMaps, and drift vs Git", pinnable: true, keywords: ["configmap", "config maps", "drift", "git", "secrets editor"] },
      { href: "/secrets", icon: KeyRound, label: "Secrets & Certs", description: "Secret browser, expiry tracking, and TLS certificates", keywords: ["externalsecret", "credentials", "vault", "expiry", "rotation", "tls", "ssl", "cert-manager", "certificates"] },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    description: "Monitoring, logs, events, health, and tests",
    icon: Activity,
    defaultOpen: false,
    items: [
      { href: "/monitoring", icon: HeartPulse, label: "Monitoring", shortcut: "G H", description: "Unified observability — status, health, uptime, alerts, and latency", pinnable: true, keywords: ["monitoring", "status", "platform status", "health", "uptime", "availability", "sla", "latency", "alerts"] },
      { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L", description: "Live streaming pod logs" },
      { href: "/log-analytics", icon: FileText, label: "Log Analytics", description: "Search and analyze pod logs" },
      { href: "/events", icon: History, label: "Activity Log", shortcut: "G E", description: "Cluster events and audit trail" },
      { href: "/alert-silence", icon: BellOff, label: "Alert Silence", description: "Silence Prometheus alert rules" },
      { href: "/tests", icon: TestTube2, label: "Diagnostics", description: "Platform tests, self-test, health probes, and webhook testing", pinnable: true, keywords: ["tests", "self test", "self-test", "health tester", "endpoint", "webhook", "diagnostics", "connectivity"] },
    ],
  },
  {
    id: "security",
    label: "Security & Access",
    description: "Posture, image scans, PIM, users, and RBAC",
    icon: Lock,
    defaultOpen: true,
    items: [
      { href: "/security", icon: ShieldCheck, label: "Security", shortcut: "G Y", description: "Security posture and vulnerability audit", keywords: ["posture", "audit", "compliance"] },
      { href: "/image-vulnerabilities", icon: ShieldCheck, label: "Image Scans", description: "Container image vulnerability reports", keywords: ["cve", "vulnerability", "trivy"] },
      {
        href: "/access",
        icon: KeyRound,
        label: "Privileged Identity Management (PIM)",
        shortcut: "G P",
        description: "Just-in-time privileged role elevation, eligible assignments, and activation",
        pinnable: true,
        keywords: ["pim", "privileged", "elevation", "elevate", "just-in-time", "jit", "roles", "access", "identity", "activation", "eligible", "assignments", "groups"],
      },
      { href: "/users", icon: Users, label: "User Management", shortcut: "G M", description: "Manage users, groups, and SSO", pinnable: true, keywords: ["accounts", "sso", "groups", "members"] },
      { href: "/rbac", icon: Shield, label: "RBAC", description: "Visualize access and assign rights across the platform", keywords: ["roles", "permissions", "graph", "assign", "grant", "revoke", "access", "rbac"] },
      { href: "/audit", icon: History, label: "Audit Log", description: "Searchable, durable audit trail with severity, category, and date filters", keywords: ["audit", "trail", "log", "history", "who", "changed", "mutation", "compliance", "tamper", "severity", "export"] },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    description: "GitOps, automations, maintenance, and admin",
    icon: Cog,
    defaultOpen: false,
    items: [
      { href: "/gitops-diff", icon: GitBranch, label: "GitOps Diff", description: "ArgoCD app manifest diffs" },
      { href: "/automations", icon: Sparkles, label: "Automation Hub", description: "Track self-healing jobs and workflow automations" },
      { href: "/pipelines", icon: GitBranch, label: "Pipelines", description: "CI/CD pipeline overview" },
      { href: "/maintenance", icon: Settings, label: "Maintenance", description: "Drain, cordon, and node maintenance" },
      { href: "/admin/updates", icon: ArrowUpCircle, label: "Update Manager", description: "Review GitOps versions and commit application updates", pinnable: true },
      { href: "/settings/platform", icon: ArrowUpCircle, label: "Platform Updates", description: "Pull latest InfraWeaver platform code and scripts from Onedev", pinnable: true },
      navItemFromPage("/settings"),
      { href: "/settings/addons", icon: Puzzle, label: "Addons", description: "Enable/disable platform addons and features" },
      navItemFromPage("/settings/infrastructure"),
      navItemFromPage("/profile"),
    ],
  },
  {
    id: "addons",
    label: "Addons",
    description: "Optional capabilities — visible only when enabled",
    icon: Puzzle,
    defaultOpen: true,
    items: ADDON_NAV_ITEMS,
  },
]);

// Flat list of all items for search/command palette
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap(g => g.items);

// "Go to" keyboard chords (press G, then a letter) derived from each nav item's
// `shortcut` field, so the sidebar hint, the global key handler, and the
// shortcuts modal can never drift apart. A shortcut like "G K" maps the lower-
// cased letter ("k") to the item's href. First item wins on the (currently
// non-existent) letter collision.
export interface GotoNavShortcut {
  letter: string;
  href: string;
  label: string;
}

export const GOTO_NAV_SHORTCUTS: GotoNavShortcut[] = ALL_NAV_ITEMS.reduce<GotoNavShortcut[]>((acc, item) => {
  const match = item.shortcut?.match(/^G ([A-Za-z])$/);
  if (!match) return acc;
  const letter = match[1].toLowerCase();
  if (acc.some(s => s.letter === letter)) return acc;
  acc.push({ letter, href: item.href, label: item.label });
  return acc;
}, []);

// letter → href, the shape the global keydown handler consumes.
export const GOTO_SHORTCUTS: Record<string, string> = Object.fromEntries(
  GOTO_NAV_SHORTCUTS.map(s => [s.letter, s.href])
);

// Map href → icon (for active-state icon resolution)
export const HREF_ICON_MAP: Record<string, React.ElementType> = Object.fromEntries(
  ALL_NAV_ITEMS.map(item => [item.href, item.icon])
);

// Map href → label
export const HREF_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ALL_NAV_ITEMS.map(item => [item.href, item.label])
);

// Mobile bottom nav — stable core destinations (5th slot is "Menu" in layout.tsx).
// Also seeds DEFAULT_FAVORITES. Kept addon-independent so it's always populated;
// the live bottom bar (layout.tsx) reads these hrefs from the RBAC/addon-filtered
// nav groups, and everything else lives in the "More" sheet.
export const MOBILE_BOTTOM_NAV: NavItem[] = [
  { href: "/home", icon: Home, label: "Home" },
  { href: "/apps", icon: LayoutGrid, label: "Apps" },
  { href: "/logs", icon: FileText, label: "Logs" },
  { href: "/cluster", icon: Boxes, label: "Cluster" },
];
