import {
  LayoutDashboard, Box, Settings, Users, HardDrive,
  Network, Activity, Terminal, History, Cog,
  Package, FileText, ShieldCheck, Server,
  Sparkles, Home, UserCircle, BarChart2, Trash2, GitBranch,
  DollarSign, Globe, BellOff, Shield, AlertTriangle,
  Calendar, TrendingUp, Gamepad2, Search, LayoutGrid, TestTube2, Puzzle, BookOpen,
} from "lucide-react";

export interface NavItem {
  href: string;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  description?: string;
  badge?: string;
  pinnable?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
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
      { href: "/events", icon: History, label: "Activity Log", shortcut: "G E", description: "Cluster events and audit trail" },
    ],
  },
  {
    id: "compute",
    label: "Compute",
    description: "Pods, nodes, and cluster resources",
    icon: Server,
    defaultOpen: false,
    items: [
      { href: "/pods", icon: Server, label: "Pods", description: "All pods with live status" },
      { href: "/cluster", icon: Server, label: "Cluster Nodes", shortcut: "G K", description: "Node management and cluster overview" },
      { href: "/quota", icon: BarChart2, label: "Resource Quotas", description: "Namespace resource limits and usage" },
      { href: "/node-top", icon: Activity, label: "Node Metrics", description: "Live node CPU and memory usage" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description: "Storage, network, and security",
    icon: HardDrive,
    defaultOpen: false,
    items: [
      { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S", description: "Persistent volumes and storage classes", pinnable: true },
      { href: "/network", icon: Network, label: "Network", shortcut: "G N", description: "Services, ingress, and network topology", pinnable: true },
      { href: "/dns", icon: Globe, label: "DNS", shortcut: "G Z", description: "Manage internal and public Cloudflare records", pinnable: true },
      { href: "/certificates", icon: ShieldCheck, label: "Certificates", description: "TLS certificate status and expiry" },
      { href: "/network-policies", icon: Network, label: "Net Policies", description: "Kubernetes NetworkPolicy rules" },
      { href: "/secret-expiry", icon: ShieldCheck, label: "Secret Expiry", description: "Track certificate and secret expiry" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    description: "Config, logs, jobs, and maintenance",
    icon: Cog,
    defaultOpen: false,
    items: [
      { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C", description: "Edit Kubernetes ConfigMaps and Secrets", pinnable: true },
      { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L", description: "Live streaming pod logs" },
      { href: "/cronjobs", icon: Calendar, label: "CronJobs", description: "Scheduled Kubernetes cronjobs" },
      { href: "/maintenance", icon: Settings, label: "Maintenance", description: "Drain, cordon, and node maintenance" },
      { href: "/gitops-diff", icon: GitBranch, label: "GitOps Diff", description: "ArgoCD app manifest diffs" },
      { href: "/pipelines", icon: GitBranch, label: "Pipelines", description: "CI/CD pipeline overview" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    description: "Health, uptime, and security",
    icon: Activity,
    defaultOpen: false,
    items: [
      { href: "/health", icon: Activity, label: "Health", shortcut: "G H", description: "Node and cluster health checks", pinnable: true },
      { href: "/security", icon: ShieldCheck, label: "Security", shortcut: "G Y", description: "Security posture and vulnerability audit" },
      { href: "/uptime", icon: TrendingUp, label: "Uptime History", description: "Historical uptime for all services" },
      { href: "/image-vulnerabilities", icon: ShieldCheck, label: "Image Scans", description: "Container image vulnerability reports" },
    ],
  },
  {
    id: "gaming",
    label: "Gaming",
    description: "Game servers and gaming infrastructure",
    icon: Gamepad2,
    defaultOpen: false,
    items: [
      { href: "/game-hub", icon: Gamepad2, label: "Game Hub", description: "Deploy and manage game servers on Kubernetes" },
    ],
  },
  {
    id: "documentation",
    label: "Documentation",
    description: "User manuals and developer guides",
    icon: BookOpen,
    defaultOpen: false,
    items: [
      { href: "/wiki", icon: BookOpen, label: "Wiki", shortcut: "G W", description: "Interactive user and developer documentation", pinnable: true },
    ],
  },
  {
    id: "services",
    label: "Services",
    description: "External services and routing",
    icon: Globe,
    defaultOpen: false,
    items: [
      { href: "/gameservers", icon: Gamepad2, label: "Port Routing", description: "DNS-based port routing for external services" },
      { href: "/all-services", icon: Search, label: "All Services", description: "Browse all platform services" },
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
      { href: "/rbac-viz", icon: Shield, label: "RBAC Visualizer", description: "Visual RBAC permission explorer" },
      { href: "/resource-optimizer", icon: Activity, label: "Optimizer", description: "Right-size CPU and memory requests" },
      { href: "/app-graph", icon: Network, label: "App Graph", description: "Visual application dependency graph" },
      { href: "/log-analytics", icon: FileText, label: "Log Analytics", description: "Search and analyze pod logs" },
      { href: "/health-tester", icon: Activity, label: "Health Tester", description: "Test endpoint reachability" },
      { href: "/webhook-tester", icon: Globe, label: "Webhook Tester", description: "Send test webhook payloads" },
      { href: "/alert-silence", icon: BellOff, label: "Alert Silence", description: "Silence Prometheus alert rules" },
      { href: "/config-drift", icon: AlertTriangle, label: "Config Drift", description: "Detect config changes vs Git" },
      { href: "/deployment-compare", icon: GitBranch, label: "Deploy Compare", description: "Diff current vs previous deployment" },
      { href: "/namespace-cleanup", icon: Trash2, label: "NS Cleanup", description: "Find and remove stale namespaces" },
      { href: "/pv-browser", icon: HardDrive, label: "PV Browser", description: "Browse persistent volume contents" },
      { href: "/cost", icon: DollarSign, label: "Cost Estimate", description: "Estimated resource cost breakdown" },
      { href: "/storage-timeline", icon: HardDrive, label: "Storage Timeline", description: "Historical storage usage charts" },
      { href: "/scheduled-tasks", icon: Calendar, label: "Scheduled Tasks", description: "View and manage scheduled operations" },
      { href: "/tests", icon: Activity, label: "Platform Tests", description: "Interactive platform test suite", pinnable: true },
      { href: "/self-test", icon: TestTube2, label: "Self Test", description: "Verify console SA connectivity to the Kubernetes API" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Users, preferences, and account",
    icon: Settings,
    defaultOpen: false,
    items: [
      { href: "/users", icon: Users, label: "User Management", shortcut: "G M", description: "Manage users, groups, and SSO", pinnable: true },
      { href: "/registry", icon: Package, label: "Registry", shortcut: "G R", description: "Container image registry browser" },
      { href: "/settings", icon: Settings, label: "Settings", description: "Console preferences and configuration" },
      { href: "/settings/infrastructure", icon: Server, label: "Infrastructure", description: "Read-only cluster configuration and infrastructure status" },
      { href: "/settings/addons", icon: Puzzle, label: "Addons", description: "Enable/disable platform addons and features" },
      { href: "/settings/rbac", icon: Shield, label: "RBAC", description: "Manage role assignments and permissions (RBAC)" },
      { href: "/profile", icon: UserCircle, label: "My Profile", description: "Your profile and session info" },
      { href: "/changelog", icon: Sparkles, label: "What's New", description: "Recent platform updates" },
    ],
  },
];

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
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/dns", icon: Globe, label: "DNS" },
  { href: "/config", icon: Cog, label: "Config Editor" },
  { href: "/security", icon: ShieldCheck, label: "Security" },
  { href: "/cluster", icon: Server, label: "Cluster" },
  { href: "/users", icon: Users, label: "User Management" },
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
