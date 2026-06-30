"use client";

import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Shield } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { SubjectsPanel, type KindFilter } from "./subjects-panel";
import { SubjectDetailPanel } from "./subject-detail-panel";
import type { PlatformSubjectsResponse, SubjectBinding, SubjectKind } from "./types";

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

interface K8sRbacData {
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

export default function RbacVizPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");

  const platformQuery = useQuery({
    queryKey: ["rbac", "subjects"],
    queryFn: async () => {
      const res = await fetch("/api/rbac/subjects");
      if (!res.ok) throw new Error("Failed to load platform subjects");
      return res.json() as Promise<PlatformSubjectsResponse>;
    },
  });

  const k8sQuery = useQuery({
    queryKey: ["security", "rbac"],
    queryFn: async () => {
      const res = await fetch("/api/security/rbac");
      if (!res.ok) throw new Error("Failed to load service accounts");
      return res.json() as Promise<K8sRbacData>;
    },
  });

  const subjects = useMemo<VizSubject[]>(() => {
    const users = platformQuery.data?.users ?? [];
    const groups = platformQuery.data?.groups ?? [];
    return [...users, ...groups, ...serviceAccountSubjects(k8sQuery.data)];
  }, [platformQuery.data, k8sQuery.data]);

  const selected = useMemo(() => subjects.find((subject) => subject.id === selectedId) ?? null, [subjects, selectedId]);

  const isLoading = platformQuery.isLoading || k8sQuery.isLoading;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Shield} title="RBAC Visualizer" description="Browse effective role bindings by platform user, group, or Kubernetes service account." />

      {isLoading ? (
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
          <SubjectDetailPanel subject={selected} />
        </div>
      )}
    </motion.div>
  );
}
