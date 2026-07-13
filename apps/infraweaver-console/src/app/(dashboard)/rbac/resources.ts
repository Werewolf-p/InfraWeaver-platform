import type { ElementType } from "react";
import { Building2, Server, Globe, HardDrive, Film, BookOpen } from "lucide-react";
import { BUILT_IN_ROLES, gameServerScope, type RoleAssignment, type RoleDefinition } from "@/lib/rbac";

/**
 * Resource-aware grant model for the RBAC "Assign" surface.
 *
 * Each resource type maps onto (a) the Azure-style scope subtree it lives in and
 * (b) the built-in role categories that are meaningful there. The grant modal is
 * driven entirely by this table so adding a resource type is a one-entry change.
 */
export type ResourceTypeId = "cluster" | "game-server" | "wordpress" | "storage" | "jellyfin" | "wiki";

export type RoleCategory = NonNullable<RoleDefinition["category"]>;

/** How a resource type resolves its concrete scope. */
export type InstanceKind = "none" | "game-server" | "wordpress" | "nas";

export interface ResourceType {
  id: ResourceTypeId;
  label: string;
  icon: ElementType;
  description: string;
  /** Built-in role categories offered for this resource. */
  categories: RoleCategory[];
  /** Whether (and how) a specific instance must be chosen to form the scope. */
  instance: InstanceKind;
  /** Scope covering the whole resource type ("all"); also the default scope. */
  allScope: string;
  allLabel: string;
}

export const RESOURCE_TYPES: ResourceType[] = [
  {
    id: "cluster",
    label: "Cluster-wide",
    icon: Building2,
    description: "Platform-wide roles at the root scope. Inherit down to every resource.",
    categories: ["scoped", "platform"],
    instance: "none",
    allScope: "/",
    allLabel: "Cluster-wide (/)",
  },
  {
    id: "game-server",
    label: "Game server",
    icon: Server,
    description: "Roles scoped to one game server, or all of Game Hub.",
    categories: ["game-hub"],
    instance: "game-server",
    allScope: "/game-hub/",
    allLabel: "All Game Hub servers",
  },
  {
    id: "wordpress",
    label: "WordPress site",
    icon: Globe,
    description: "Roles scoped to one WordPress site, or every site.",
    categories: ["wordpress"],
    instance: "wordpress",
    allScope: "/wordpress",
    allLabel: "All WordPress sites",
  },
  {
    id: "storage",
    label: "Storage share",
    icon: HardDrive,
    description: "NAS share / folder roles. Scoped like /nas/<provider>/<share>.",
    categories: ["storage"],
    instance: "nas",
    allScope: "/nas",
    allLabel: "All storage",
  },
  {
    id: "jellyfin",
    label: "Jellyfin",
    icon: Film,
    description: "Jellyfin account roles, provisioned automatically on grant.",
    categories: ["jellyfin"],
    instance: "none",
    allScope: "/jellyfin",
    allLabel: "Jellyfin",
  },
  {
    id: "wiki",
    label: "Wiki",
    icon: BookOpen,
    description: "Wiki read / edit roles within the assigned scope.",
    categories: ["wiki"],
    instance: "none",
    allScope: "/wiki",
    allLabel: "Wiki",
  },
];

const builtInRoles = Object.values(BUILT_IN_ROLES);

/** Built-in roles offered for a resource type, in registry order. */
export function rolesForResource(resource: ResourceType): RoleDefinition[] {
  return builtInRoles.filter((role) => role.category !== undefined && resource.categories.includes(role.category));
}

/** Canonical per-server scope, e.g. `/game-hub/servers/valheim`. */
export function gameServerInstanceScope(name: string): string {
  return gameServerScope(name);
}

/** Canonical per-site WordPress scope, e.g. `/wordpress/sites/blog`. */
export function wordpressSiteScope(site: string): string {
  return `/wordpress/sites/${site}`;
}

/** Best-effort resource type for an existing scope (used to prefill the modal). */
export function inferResourceType(scope: string): ResourceTypeId {
  if (scope === "/" || scope === "") return "cluster";
  if (scope.startsWith("/game-hub")) return "game-server";
  if (scope.startsWith("/wordpress")) return "wordpress";
  if (scope.startsWith("/nas")) return "storage";
  if (scope.startsWith("/jellyfin")) return "jellyfin";
  if (scope.startsWith("/wiki")) return "wiki";
  return "cluster";
}

export function resourceTypeById(id: ResourceTypeId): ResourceType {
  return RESOURCE_TYPES.find((entry) => entry.id === id) ?? RESOURCE_TYPES[0];
}

/** A subject the grant modal / deep-links target. */
export interface GrantSubjectRef {
  principalType: "user" | "group";
  principal: string;
  principalLabel: string;
}

/** A deep-link intent from the Visualize side into the grant modal. */
export interface GrantIntent {
  subject?: GrantSubjectRef;
  scope?: string;
}

/** An existing role assignment as returned by GET /api/rbac/assignments. */
export type AssignmentRow = RoleAssignment & { username: string; userEmail: string; userName: string };
