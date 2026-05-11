import {
  LayoutDashboard, Box, Settings, Users, HardDrive,
  Network, Activity, Terminal, History, Cog,
  Package, FileText, ShieldCheck, Server, PlusCircle,
  Sparkles, Home, UserCircle, BarChart2, Trash2, GitBranch,
  DollarSign, Globe, BellOff, Shield, AlertTriangle,
  Calendar, TrendingUp, Gamepad2, Search,
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
    id: "core",
    label: "Overview",
    description: "Home, dashboard, and activity",
    icon: Home,
    defaultOpen: true,
    items: [
      { href: "/home", icon: Home, label: "Home Portal", shortcut: "G O", description: "Platform overview and quick access", pinnable: true },
      { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D", description: "Real-time cluster metrics and status", pinnable: true },
      { href: "/apps", icon: Box, label: "Applications", shortcut: "G A", description: "All deployed applications", pinnable: true },
      { href: "/catalog-install", icon: PlusCircle, label: "App Installer", shortcut: "G I", description: "One-click catalog app deployment" },
      { href: "/events", icon: History, label: "Activity Log", shortcut: "G E", description: "Cluster events and audit trail" },
      { href: "/status", icon: Activity, label: "Platform Status", shortcut: "", description: "Live health of all platform services", pinnable: true },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    description: "Configuration, users, and deployments",
    icon: Cog,
    defaultOpen: true,
    items: [
      { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C", description: "Edit Kubernetes ConfigMaps and Secrets", pinnable: true },
      { href: "/users", icon: Users, label: "Users", shortcut: "G U", description: "Manage users, groups, and SSO", pinnable: true },
      { href: "/registry", icon: Package, label: "Registry", shortcut: "G R", description: "Container image registry browser" },
      { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L", description: "Live streaming pod logs" },
      { href: "/maintenance", icon: Settings, label: "Maintenance", shortcut: "", description: "Drain, cordon, and node maintenance" },
      { href: "/cronjobs", icon: Calendar, label: "CronJobs", shortcut: "", description: "Scheduled Kubernetes cronjobs" },
      { href: "/image-vulnerabilities", icon: ShieldCheck, label: "Image Scans", shortcut: "", description: "Container image vulnerability reports" },
      { href: "/resource-optimizer", icon: Activity, label: "Optimizer", shortcut: "", description: "Right-size CPU and memory requests" },
      { href: "/app-graph", icon: Network, label: "App Graph", shortcut: "", description: "Visual application dependency graph" },
      { href: "/health-tester", icon: Activity, label: "Health Tester", shortcut: "", description: "Test endpoint reachability" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description: "Nodes, storage, network, and security",
    icon: Server,
    defaultOpen: false,
    items: [
      { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S", description: "Persistent volumes and storage classes", pinnable: true },
      { href: "/network", icon: Network, label: "Network", shortcut: "G N", description: "Services, ingress, and network topology", pinnable: true },
      { href: "/health", icon: Activity, label: "Health", shortcut: "G H", description: "Node and cluster health checks", pinnable: true },
      { href: "/security", icon: ShieldCheck, label: "Security", shortcut: "G Y", description: "Security posture and vulnerability audit" },
      { href: "/cluster", icon: Server, label: "Cluster", shortcut: "G K", description: "Node management and cluster overview" },
      { href: "/storage-timeline", icon: HardDrive, label: "Storage Timeline", description: "Historical storage usage charts" },
      { href: "/network-policies", icon: Network, label: "Net Policies", description: "Kubernetes NetworkPolicy rules" },
      { href: "/secret-expiry", icon: ShieldCheck, label: "Secret Expiry", description: "Track certificate and secret expiry" },
      { href: "/pv-browser", icon: HardDrive, label: "PV Browser", description: "Browse persistent volume contents" },
      { href: "/pods", icon: Server, label: "Pods", description: "All pods with live status" },
      { href: "/uptime", icon: TrendingUp, label: "Uptime History", description: "Historical uptime for all services" },
      { href: "/certificates", icon: ShieldCheck, label: "Certificates", description: "TLS certificate status and expiry" },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    description: "Power-user utilities and debugging",
    icon: Terminal,
    defaultOpen: false,
    items: [
      { href: "/quota", icon: BarChart2, label: "Resource Quotas", description: "Namespace resource limits and usage" },
      { href: "/namespace-cleanup", icon: Trash2, label: "NS Cleanup", description: "Find and remove stale namespaces" },
      { href: "/deployment-compare", icon: GitBranch, label: "Deploy Compare", description: "Diff current vs. previous deployment" },
      { href: "/cost", icon: DollarSign, label: "Cost Estimate", description: "Estimated resource cost breakdown" },
      { href: "/scheduled-tasks", icon: Calendar, label: "Scheduled Tasks", description: "View and manage scheduled operations" },
      { href: "/webhook-tester", icon: Globe, label: "Webhook Tester", description: "Send test webhook payloads" },
      { href: "/alert-silence", icon: BellOff, label: "Alert Silence", description: "Silence Prometheus alert rules" },
      { href: "/pod-shell", icon: Terminal, label: "Pod Shell", shortcut: "", description: "Browser-based terminal into pods" },
      { href: "/rbac-viz", icon: Shield, label: "RBAC Viz", description: "Visual RBAC permission explorer" },
      { href: "/gitops-diff", icon: GitBranch, label: "GitOps Diff", description: "ArgoCD app manifest diffs" },
      { href: "/log-analytics", icon: FileText, label: "Log Analytics", description: "Search and analyze pod logs" },
      { href: "/config-drift", icon: AlertTriangle, label: "Config Drift", description: "Detect config changes vs. Git" },
    ],
  },
  {
    id: "services",
    label: "Services",
    description: "Hosted services and routing",
    icon: Globe,
    defaultOpen: false,
    items: [
      { href: "/gameservers", icon: Gamepad2, label: "Port Routing", description: "DNS-based port routing for game servers and external services" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Profile, preferences, and changelog",
    icon: Settings,
    defaultOpen: false,
    items: [
      { href: "/settings", icon: Settings, label: "Settings", description: "Console preferences and configuration" },
      { href: "/changelog", icon: Sparkles, label: "What's New", description: "Recent platform updates" },
      { href: "/profile", icon: UserCircle, label: "My Profile", description: "Your profile and session info" },
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

// Mobile bottom nav (6 items max)
export const MOBILE_BOTTOM_NAV: NavItem[] = [
  { href: "/home", icon: Home, label: "Home" },
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Apps" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config" },
];

// Mobile drawer nav (all important pages)
export const MOBILE_DRAWER_NAV: NavItem[] = [
  { href: "/home", icon: Home, label: "Home Portal" },
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Applications" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config Editor" },
  { href: "/security", icon: ShieldCheck, label: "Security" },
  { href: "/cluster", icon: Server, label: "Cluster" },
  { href: "/users", icon: Users, label: "User Management" },
  { href: "/gameservers", icon: Gamepad2, label: "Port Routing" },
  { href: "/uptime", icon: TrendingUp, label: "Uptime History" },
  { href: "/certificates", icon: ShieldCheck, label: "Certificates" },
  { href: "/all-services", icon: Search, label: "All Services" },
];
