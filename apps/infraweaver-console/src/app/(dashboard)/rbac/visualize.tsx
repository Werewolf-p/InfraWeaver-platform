"use client";

import { useMemo, useState } from "react";
import { Grid3x3, HelpCircle, MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccessMatrix } from "@/components/rbac/access-matrix";
import { ScopeAccessPanel } from "@/components/rbac/scope-access-panel";
import { ExplainWidget } from "@/components/rbac/explain-widget";
import { SubjectsPanel, type KindFilter } from "./subjects-panel";
import { SubjectDetailPanel } from "./subject-detail-panel";
import type { PlatformSubjectsResponse, SubjectBinding, SubjectKind } from "@/lib/rbac-viz-types";
import type { GrantIntent } from "./resources";

type VizTab = "matrix" | "subjects" | "resource" | "explain";

const TABS: { id: VizTab; label: string; icon: React.ElementType }[] = [
  { id: "matrix", label: "Access matrix", icon: Grid3x3 },
  { id: "subjects", label: "By subject", icon: Users },
  { id: "resource", label: "By resource", icon: MapPin },
  { id: "explain", label: "Explain access", icon: HelpCircle },
];

interface K8sBinding {
  name: string;
  role: string;
  subjects: { kind: string; name: string; namespace?: string }[];
  isClusterAdmin: boolean;
}

interface K8sServiceAccount {
  name: string;
  namespace: string;
  bindings: string[];
  isClusterAdmin: boolean;
}

export interface K8sRbacData {
  serviceAccounts: K8sServiceAccount[];
  bindings: K8sBinding[];
}

interface VizSubject {
  id: string;
  kind: SubjectKind;
  name: string;
  secondary?: string;
  related: string[];
  bindings: SubjectBinding[];
  permissions: string[];
}

function serviceAccountSubjects(data: K8sRbacData | undefined): VizSubject[] {
  if (!data) return [];
  return data.serviceAccounts.map((sa) => {
    const matched = data.bindings.filter((binding) =>
      binding.subjects.some((subject) => subject.name === sa.name && subject.namespace === sa.namespace),
    );
    const bindings: SubjectBinding[] = matched.map((binding) => ({
      roleId: binding.role,
      roleName: binding.role,
      scope: "cluster",
      scopeLabel: "Cluster (Kubernetes)",
      permissions: [],
      color: binding.isClusterAdmin ? "red" : "gray",
      sourceLabel: `ClusterRoleBinding: ${binding.name}`,
    }));
    return {
      id: `sa:${sa.namespace}/${sa.name}`,
      kind: "ServiceAccount" as const,
      name: `${sa.namespace}/${sa.name}`,
      secondary: sa.isClusterAdmin ? "cluster-admin" : "service account",
      related: [],
      bindings,
      permissions: [],
    };
  });
}

interface VisualizeProps {
  platformData?: PlatformSubjectsResponse;
  k8sData?: K8sRbacData;
  isLoading: boolean;
  onGrantHere: (intent: GrantIntent) => void;
}

/** The read-only "who can do what, where" surface — matrix, subject, resource, explain. */
export function Visualize({ platformData, k8sData, isLoading, onGrantHere }: VisualizeProps) {
  const [tab, setTab] = useState<VizTab>("matrix");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");

  const subjects = useMemo<VizSubject[]>(() => {
    const users = platformData?.users ?? [];
    const groups = platformData?.groups ?? [];
    return [...users, ...groups, ...serviceAccountSubjects(k8sData)];
  }, [platformData, k8sData]);

  const selected = useMemo(() => subjects.find((subject) => subject.id === selectedId) ?? null, [subjects, selectedId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 dark:border-white/10 dark:bg-white/5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              tab === id
                ? "bg-white text-[#0078D4] shadow-sm dark:bg-[#111] dark:text-[#4fc3f7]"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === "matrix" && <AccessMatrix />}
      {tab === "resource" && <ScopeAccessPanel onGrantHere={(scope) => onGrantHere({ scope })} />}
      {tab === "explain" && <ExplainWidget />}
      {tab === "subjects" &&
        (isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-96 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <SubjectsPanel
              subjects={subjects}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filter={filter}
              onFilterChange={setFilter}
              search={search}
              onSearchChange={setSearch}
            />
            <SubjectDetailPanel
              subject={selected}
              onGrantHere={(subject) => onGrantHere({ subject })}
            />
          </div>
        ))}
    </div>
  );
}
