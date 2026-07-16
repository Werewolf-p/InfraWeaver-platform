"use client";

import { KeyRound, Shield, Sparkles, UserX, Users } from "lucide-react";
import { TabHub, type HubTab } from "@/components/layout/tab-hub";
import { useRBAC } from "@/hooks/use-rbac";
import { UsersView } from "../users/view";
import { AccessView } from "../access/view";
import { RbacView } from "../rbac/view";
import { AccessStudioView } from "./access-studio-view";
import { RosterDriftView } from "./roster-drift-view";

/**
 * Identity hub — consolidates Users, Access Studio, RBAC, PIM (Groups/Assignments),
 * and Roster Drift into one tabbed destination. Invite and offboard remain modals
 * launched from the Users tab. Each tab lazy-mounts (TabHub) so per-tab data
 * fetching stays lazy. RBAC-sensitive tabs self-hide when the session lacks the
 * required permission; the /identity nav link itself is gated in navigation-rbac.
 */
export default function IdentityPage() {
  const { can } = useRBAC();

  const canRbac = can("rbac:admin");
  const canDrift = can("security:read") || can("rbac:admin") || can("cluster:admin");

  const tabs: HubTab[] = [
    { value: "users", label: "Users", icon: Users, Component: UsersView },
    { value: "access-studio", label: "Access Studio", icon: Sparkles, Component: AccessStudioView },
    ...(canRbac ? [{ value: "rbac", label: "RBAC", icon: Shield, Component: RbacView }] : []),
    { value: "pim", label: "PIM", icon: KeyRound, Component: AccessView },
    ...(canDrift ? [{ value: "roster-drift", label: "Roster Drift", icon: UserX, Component: RosterDriftView }] : []),
  ];

  return <TabHub basePath="/identity" tabs={tabs} />;
}
