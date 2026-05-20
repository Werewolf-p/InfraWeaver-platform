import type { ComponentType } from "react";
import { BarChart2, BookOpen, DollarSign, LayoutGrid, Settings, Sliders, UserCircle } from "lucide-react";

export type PageIcon = ComponentType<{ className?: string }>;

const PAGE_ICONS = {
  BarChart2,
  BookOpen,
  DollarSign,
  LayoutGrid,
  Settings,
  Sliders,
  UserCircle,
} as const satisfies Record<string, PageIcon>;

export type PageIconName = keyof typeof PAGE_ICONS;

export interface RegisteredPageDefinition {
  href: string;
  groupId: string;
  label: string;
  iconName: PageIconName;
  description?: string;
  shortcut?: string;
  badge?: string;
  pinnable?: boolean;
  pageTitle?: string;
  pageDescription?: string;
  requiredPermissions?: readonly string[];
  refreshIntervalMs?: number;
  apiBase?: string;
  tags?: readonly string[];
}

export interface RegisteredPageConfig extends RegisteredPageDefinition {
  icon: PageIcon;
}

export interface NavItemLike {
  href: string;
  icon: PageIcon;
  label: string;
  shortcut?: string;
  description?: string;
  badge?: string;
  pinnable?: boolean;
}

export interface NavGroupLike {
  id: string;
  label: string;
  description: string;
  icon: PageIcon;
  defaultOpen?: boolean;
  items: NavItemLike[];
}

const REGISTERED_PAGE_DEFINITIONS: RegisteredPageDefinition[] = [
  {
    href: "/quota",
    groupId: "compute",
    label: "Resource Quotas",
    iconName: "BarChart2",
    description: "Namespace resource limits and usage",
    pageTitle: "Resource Quotas",
    pageDescription: "Namespace resource usage vs limits.",
    apiBase: "/api/cluster/quota",
    refreshIntervalMs: 60_000,
    requiredPermissions: ["cluster:read", "infra:read"],
    tags: ["compute", "quota", "namespaces"],
  },
  {
    href: "/cost",
    groupId: "tools",
    label: "Cost Estimate",
    iconName: "DollarSign",
    description: "Estimated resource cost breakdown",
    pageTitle: "Cost Estimate",
    pageDescription: "Estimated monthly cloud cost based on current resource requests.",
    apiBase: "/api/cluster/cost",
    refreshIntervalMs: 60_000,
    requiredPermissions: ["cluster:read", "infra:read"],
    tags: ["cost", "finance", "capacity"],
  },
  {
    href: "/settings",
    groupId: "settings",
    label: "Settings",
    iconName: "Settings",
    description: "Console preferences and configuration",
    pageTitle: "Settings",
    pageDescription: "Console and platform settings.",
    tags: ["preferences", "personalization"],
  },
  {
    href: "/profile",
    groupId: "settings",
    label: "My Profile",
    iconName: "UserCircle",
    description: "Your profile and session info",
    pageTitle: "My Profile",
    pageDescription: "Profile details, active sessions, and recent authentication activity.",
    apiBase: "/api/profile",
    tags: ["profile", "account", "authentik"],
  },
  {
    href: "/wiki",
    groupId: "documentation",
    label: "Wiki",
    iconName: "BookOpen",
    shortcut: "G W",
    description: "Interactive user and developer documentation",
    pinnable: true,
    pageTitle: "InfraWeaver Wiki",
    pageDescription: "User manuals, developer docs, runbooks, and reference material for the console.",
    tags: ["docs", "runbooks"],
  },
  {
    href: "/settings/infrastructure",
    groupId: "settings",
    label: "Infrastructure",
    iconName: "Sliders",
    description: "Read-only cluster configuration and infrastructure status",
    pageTitle: "Infrastructure",
    pageDescription: "Shared platform configuration, feature flags, and operator controls.",
    apiBase: "/api/config/platform",
    requiredPermissions: ["config:read"],
    tags: ["settings", "platform", "configuration"],
  },
  // __SCAFFOLD_INSERT__
];

export const REGISTERED_PAGES: RegisteredPageConfig[] = REGISTERED_PAGE_DEFINITIONS.map((definition) => ({
  ...definition,
  icon: PAGE_ICONS[definition.iconName],
}));

const PAGE_CONFIG_BY_HREF = new Map(REGISTERED_PAGES.map((page) => [page.href, page] as const));

export function getPageConfig(href: string) {
  return PAGE_CONFIG_BY_HREF.get(href);
}

export function requirePageConfig(href: string) {
  const page = getPageConfig(href);
  if (!page) {
    throw new Error(`No registered page configuration for ${href}`);
  }

  return page;
}

export function navItemFromPage(href: string): NavItemLike {
  const page = requirePageConfig(href);
  return {
    href: page.href,
    icon: page.icon,
    label: page.label,
    shortcut: page.shortcut,
    description: page.description,
    badge: page.badge,
    pinnable: page.pinnable,
  };
}

export function mergeRegisteredPages<TGroup extends NavGroupLike>(groups: readonly TGroup[]): TGroup[] {
  const nextGroups = groups.map((group) => ({
    ...group,
    items: [...group.items],
  }));
  const seenHrefs = new Set(nextGroups.flatMap((group) => group.items.map((item) => item.href)));

  for (const page of REGISTERED_PAGES) {
    if (seenHrefs.has(page.href)) {
      continue;
    }

    const targetGroup = nextGroups.find((group) => group.id === page.groupId);
    if (!targetGroup) {
      continue;
    }

    targetGroup.items.push(navItemFromPage(page.href));
    seenHrefs.add(page.href);
  }

  return nextGroups;
}

export function getAvailablePageIcons() {
  return Object.keys(PAGE_ICONS).sort() as PageIconName[];
}
