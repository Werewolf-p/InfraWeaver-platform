import {
  Archive, LayoutDashboard, Box, Settings, Users, HardDrive,
  Network, Activity, Terminal, History, Cog,
  Package, FileText, ShieldCheck, Server,
  Sparkles, Home, Trash2, GitBranch, ArrowUpCircle,
  Globe, BellOff, Shield, AlertTriangle, HeartPulse,
  Calendar, TrendingUp, Gamepad2, Search, LayoutGrid, TestTube2, Puzzle, BookOpen, MemoryStick,
  KeyRound, Lock, Database, Boxes, MessageSquarePlus,
} from "lucide-react";
import { mergeRegisteredPages, navItemFromPage } from "@/lib/page-registry";

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

export const NAV_GROUPS: NavGroup[] = mergeRegisteredPages([
  {
    id: "overview",
    label: "Overview",
    description: "Home, dashboard, and platform status",
    icon: Home,
    defaultOpen: true,
    items: [
      { href: "/home", icon: Home, label: "Home Portal", shortcut: "G O", description: "Platform overview and quick access", pinnable: true },
      { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D", description: "Real-time cluster metrics and status", pinnable: true },
      { href: "/status", icon: Activity, label: "Platform Status", shortcut: "", description: "Live health of all platform services", pinnable: true },
      { href: "/events", icon: History, label: "Activity Log", shortcut: "G E", description: "Cluster events and audit trail" },
    ],
  },
  {
    id: "apps",
    label: "Applications",
    description: "Deploy and manage all applications",
    icon: Box,
    defaultOpen: true,
    items: [
      { href: "/apps", icon: LayoutGrid, label: "Apps", shortcut: "G A", description: "Install and manage all platform applications", pinnable: true },
    ],
  },
  {
    id: "compute",
    label: "Compute & Workloads",
    description: "Pods, nodes, and cluster resources",
    icon: Server,
    defaultOpen: false,
    items: [
      { href: "/pods", icon: Server, label: "Pods", description: "All pods with live status" },
      { href: "/cluster", icon: Boxes, label: "Cluster Nodes", shortcut: "G K", description: "Node management and cluster overview" },
      { href: "/node-top", icon: Activity, label: "Node Metrics", description: "Live node CPU and memory usage" },
      { href: "/memory", icon: MemoryStick, label: "Memory Heatmap", description: "Namespace memory reservations and top consumers" },
      { href: "/cronjobs", icon: Calendar, label: "CronJobs", description: "Scheduled Kubernetes cronjobs" },
      navItemFromPage("/quota"),
    ],
  },
  {
    id: "networking",
    label: "Networking",
    description: "Network, DNS, routes, and connectivity",
    icon: Network,
    defaultOpen: false,
    items: [
      { href: "/network", icon: Network, label: "Network", shortcut: "G N", description: "Services, ingress, and network topology", pinnable: true, keywords: ["services", "topology", "connectivity"] },
      { href: "/vpn", icon: Network, label: "VPN", description: "NetBird peer connectivity and management view", pinnable: true, keywords: ["netbird", "peers", "wireguard"] },
      { href: "/ingress", icon: Globe, label: "Ingress Routes", description: "Traefik hosts, auth, and TLS audit", keywords: ["traefik", "hosts", "tls"] },
      { href: "/routes", icon: Globe, label: "Route Manager", description: "Add, edit, and delete external routes with access tier control", pinnable: true, keywords: ["external routes", "tier"] },
      { href: "/dns", icon: Globe, label: "DNS", shortcut: "G Z", description: "Manage internal and public Cloudflare records", pinnable: true, keywords: ["cloudflare", "records", "domain"] },
      { href: "/gameservers", icon: Network, label: "Port Routing", description: "DNS-based port routing for external services", keywords: ["ports", "tcp", "udp", "external services"] },
      { href: "/network-policies", icon: Network, label: "Net Policies", description: "Kubernetes NetworkPolicy rules", keywords: ["networkpolicy", "firewall"] },
      { href: "/certificates", icon: ShieldCheck, label: "Certificates", description: "TLS certificate status and expiry", keywords: ["tls", "ssl", "cert-manager"] },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    description: "Volumes, backups, and capacity",
    icon: HardDrive,
    defaultOpen: false,
    items: [
      { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S", description: "Persistent volumes and storage classes", pinnable: true, keywords: ["pvc", "volumes", "storage classes"] },
      { href: "/backups", icon: Archive, label: "Backups", description: "Browse Longhorn volume backups and trigger restores", pinnable: true, keywords: ["longhorn", "restore", "snapshot"] },
      { href: "/pv-browser", icon: Database, label: "PV Browser", description: "Browse persistent volume contents", keywords: ["persistent volume", "files"] },
      { href: "/storage-timeline", icon: TrendingUp, label: "Storage Timeline", description: "Historical storage usage charts" },
    ],
  },
  {
    id: "security",
    label: "Security & Identity",
    description: "Secrets, PIM, users, and access control",
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
      { href: "/settings/rbac", icon: Shield, label: "RBAC", description: "Manage role assignments and permissions (RBAC)", keywords: ["roles", "permissions", "role assignments"] },
      { href: "/rbac-viz", icon: Shield, label: "RBAC Visualizer", description: "Visual RBAC permission explorer", keywords: ["roles", "permissions", "graph"] },
      { href: "/secrets", icon: KeyRound, label: "Secrets", description: "Read-only secret browser with ExternalSecret ownership", keywords: ["externalsecret", "credentials", "vault"] },
      { href: "/secret-expiry", icon: ShieldCheck, label: "Secret Expiry", description: "Track certificate and secret expiry", keywords: ["expiry", "rotation"] },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    description: "Config, jobs, GitOps, and maintenance",
    icon: Cog,
    defaultOpen: false,
    items: [
      { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C", description: "Edit Kubernetes ConfigMaps and Secrets", pinnable: true },
      { href: "/config-maps", icon: FileText, label: "Config Maps", description: "Edit ConfigMap data across namespaces" },
      { href: "/maintenance", icon: Settings, label: "Maintenance", description: "Drain, cordon, and node maintenance" },
      { href: "/gitops-diff", icon: GitBranch, label: "GitOps Diff", description: "ArgoCD app manifest diffs" },
      { href: "/pipelines", icon: GitBranch, label: "Pipelines", description: "CI/CD pipeline overview" },
      { href: "/automations", icon: Sparkles, label: "Automation Hub", description: "Track self-healing jobs and workflow automations" },
      { href: "/feedback", icon: MessageSquarePlus, label: "Feedback & Fix Flow", description: "Review reported issues and dispatch the n8n auto-fix workflow", keywords: ["feedback", "report", "bug", "feature request", "note", "n8n", "fix", "review"] },
      { href: "/scheduled-tasks", icon: Calendar, label: "Scheduled Tasks", description: "View and manage scheduled operations" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring & Logs",
    description: "Health, uptime, and log analysis",
    icon: Activity,
    defaultOpen: false,
    items: [
      { href: "/monitoring", icon: HeartPulse, label: "Monitoring", description: "Unified observability dashboard", pinnable: true },
      { href: "/health", icon: Activity, label: "Health", shortcut: "G H", description: "Node and cluster health checks", pinnable: true },
      { href: "/uptime", icon: TrendingUp, label: "Uptime History", description: "Historical uptime for all services" },
      { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L", description: "Live streaming pod logs" },
      { href: "/log-analytics", icon: FileText, label: "Log Analytics", description: "Search and analyze pod logs" },
    ],
  },
  {
    id: "gaming",
    label: "Game Hub",
    description: "Game servers and gaming infrastructure",
    icon: Gamepad2,
    defaultOpen: false,
    items: [
      { href: "/game-hub", icon: Gamepad2, label: "Game Hub", description: "Deploy and manage game servers on Kubernetes" },
    ],
  },
  {
    id: "registry",
    label: "Registry",
    description: "Container image registry",
    icon: Package,
    defaultOpen: false,
    items: [
      { href: "/registry", icon: Package, label: "Registry", shortcut: "G R", description: "Container image registry browser", keywords: ["images", "containers", "harbor"] },
    ],
  },
  {
    id: "documentation",
    label: "Documentation",
    description: "User manuals and developer guides",
    icon: BookOpen,
    defaultOpen: false,
    items: [
      navItemFromPage("/wiki"),
    ],
  },
  {
    id: "tools",
    label: "Advanced Tools",
    description: "Power-user utilities and debugging",
    icon: Terminal,
    defaultOpen: false,
    items: [
      { href: "/pod-shell", icon: Terminal, label: "Pod Shell", description: "Browser-based terminal into pods" },
      { href: "/resource-optimizer", icon: Activity, label: "Optimizer", description: "Right-size CPU and memory requests" },
      { href: "/app-graph", icon: Network, label: "App Graph", description: "Visual application dependency graph" },
      { href: "/health-tester", icon: Activity, label: "Health Tester", description: "Test endpoint reachability" },
      { href: "/webhook-tester", icon: Globe, label: "Webhook Tester", description: "Send test webhook payloads" },
      { href: "/alert-silence", icon: BellOff, label: "Alert Silence", description: "Silence Prometheus alert rules" },
      { href: "/config-drift", icon: AlertTriangle, label: "Config Drift", description: "Detect config changes vs Git" },
      { href: "/deployment-compare", icon: GitBranch, label: "Deploy Compare", description: "Diff current vs previous deployment" },
      { href: "/namespace-cleanup", icon: Trash2, label: "NS Cleanup", description: "Find and remove stale namespaces" },
      navItemFromPage("/cost"),
      { href: "/tests", icon: Activity, label: "Platform Tests", description: "Interactive platform test suite", pinnable: true },
      { href: "/self-test", icon: TestTube2, label: "Self Test", description: "Verify console SA connectivity to the Kubernetes API" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Platform administration and update tooling",
    icon: Shield,
    defaultOpen: false,
    items: [
      { href: "/admin/updates", icon: ArrowUpCircle, label: "Update Manager", description: "Review GitOps versions and commit application updates", pinnable: true },
      { href: "/settings/platform", icon: ArrowUpCircle, label: "Platform Updates", description: "Pull latest InfraWeaver platform code and scripts from Onedev", pinnable: true },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Preferences and account",
    icon: Settings,
    defaultOpen: false,
    items: [
      navItemFromPage("/settings"),
      navItemFromPage("/settings/infrastructure"),
      { href: "/settings/addons", icon: Puzzle, label: "Addons", description: "Enable/disable platform addons and features" },
      navItemFromPage("/profile"),
      { href: "/changelog", icon: Sparkles, label: "What's New", description: "Recent platform updates" },
    ],
  },
]);

// Flat list of all items for search/command palette
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap(g => g.items);

// Map href → icon (for active-state icon resolution)
export const HREF_ICON_MAP: Record<string, React.ElementType> = Object.fromEntries(
  ALL_NAV_ITEMS.map(item => [item.href, item.icon])
);

// Map href → label
export const HREF_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ALL_NAV_ITEMS.map(item => [item.href, item.label])
);

// Mobile bottom nav (4 items — 5th slot is "Menu" handled in layout.tsx)
export const MOBILE_BOTTOM_NAV: NavItem[] = [
  { href: "/home", icon: Home, label: "Home" },
  { href: "/apps", icon: LayoutGrid, label: "Apps" },
  { href: "/game-hub", icon: Gamepad2, label: "Game Hub" },
  { href: "/pods", icon: Server, label: "Pods" },
];

// Mobile drawer nav (shown in the "More" full-screen sheet)
export const MOBILE_DRAWER_NAV: NavItem[] = [
  { href: "/home", icon: Home, label: "Home Portal" },
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: LayoutGrid, label: "Apps" },
  { href: "/monitoring", icon: HeartPulse, label: "Monitoring" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/vpn", icon: Network, label: "VPN" },
  { href: "/dns", icon: Globe, label: "DNS" },
  { href: "/routes", icon: Globe, label: "External Routes" },
  { href: "/config", icon: Cog, label: "Config Editor" },
  { href: "/config-maps", icon: FileText, label: "Config Maps" },
  { href: "/secrets", icon: ShieldCheck, label: "Secrets" },
  { href: "/security", icon: ShieldCheck, label: "Security" },
  { href: "/cluster", icon: Server, label: "Cluster" },
  { href: "/users", icon: Users, label: "User Management" },
  { href: "/admin/updates", icon: ArrowUpCircle, label: "Update Manager" },
  { href: "/gameservers", icon: Gamepad2, label: "Port Routing" },
  { href: "/game-hub", icon: Gamepad2, label: "Game Hub" },
  { href: "/wiki", icon: BookOpen, label: "Wiki" },
  { href: "/uptime", icon: TrendingUp, label: "Uptime History" },
  { href: "/certificates", icon: ShieldCheck, label: "Certificates" },
  { href: "/all-services", icon: Search, label: "All Services" },
  { href: "/tests", icon: Activity, label: "Platform Tests" },
  { href: "/settings", icon: Settings, label: "Settings" },
  { href: "/settings/addons", icon: Puzzle, label: "Addons" },
];
