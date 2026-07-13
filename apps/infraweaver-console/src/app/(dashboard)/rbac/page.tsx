"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Eye, Pencil } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
import type { PlatformSubjectsResponse } from "@/lib/rbac-viz-types";
import { Visualize, type K8sRbacData } from "./visualize";
import { AssignSurface } from "./assign";
import { GrantModal } from "./grant-modal";
import { useRbacCart } from "./use-rbac-cart";
import type { AssignmentRow, GrantIntent, GrantSubjectRef } from "./resources";

type Mode = "visualize" | "assign";

const MODES: { id: Mode; label: string; icon: React.ElementType }[] = [
  { id: "visualize", label: "Visualize", icon: Eye },
  { id: "assign", label: "Assign", icon: Pencil },
];

export default function RbacPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("visualize");
  const [modal, setModal] = useState<GrantIntent | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<GrantSubjectRef | null>(null);

  const platformQuery = useApiQuery<PlatformSubjectsResponse>({
    queryKey: ["rbac", "subjects"],
    path: "/api/rbac/subjects",
  });
  const k8sQuery = useApiQuery<K8sRbacData>({
    queryKey: ["security", "rbac"],
    path: "/api/security/rbac",
  });
  const assignmentsQuery = useApiQuery<{ assignments: AssignmentRow[] }>({
    queryKey: ["rbac", "assignments"],
    path: "/api/rbac/assignments",
  });
  const gameServersQuery = useApiQuery<{ servers: Array<{ name: string }> }>({
    queryKey: ["game-hub", "servers"],
    path: "/api/game-hub/servers",
    staleTime: 60_000,
  });

  // WordPress sites are only needed once the grant modal is open.
  const wordpressQuery = useQuery<{ sites: Array<{ site: string }> }>({
    queryKey: ["wordpress", "sites", "rbac-grant"],
    enabled: modal !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/wordpress/sites");
      if (!res.ok) throw new Error("Failed to load WordPress sites");
      return res.json();
    },
  });

  // Applying staged changes refreshes every RBAC read surface so both halves stay
  // in sync with the write we just made through the canonical apply route.
  const cart = useRbacCart(() => {
    for (const key of [["rbac", "assignments"], ["rbac", "subjects"], ["rbac", "access-matrix"], ["rbac", "scope-access"], ["security", "rbac"]]) {
      qc.invalidateQueries({ queryKey: key });
    }
  });

  const openGrant = (intent?: GrantIntent) => {
    setMode("assign");
    if (intent?.subject) setSelectedSubject(intent.subject);
    setModal(intent ?? {});
  };

  const users = platformQuery.data?.users ?? [];
  const groups = platformQuery.data?.groups ?? [];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={Shield}
        title="RBAC"
        description="Visualize access and assign rights across the platform — see who can do what, where, then grant or revoke a role on any resource."
      />

      <div className="flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 dark:border-white/10 dark:bg-white/5">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
              mode === id
                ? "bg-white text-[#0078D4] shadow-sm dark:bg-[#111] dark:text-[#4fc3f7]"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {mode === "visualize" ? (
        <Visualize
          platformData={platformQuery.data}
          k8sData={k8sQuery.data}
          isLoading={platformQuery.isLoading || k8sQuery.isLoading}
          onGrantHere={openGrant}
        />
      ) : (
        <AssignSurface
          users={users}
          groups={groups}
          assignments={assignmentsQuery.data?.assignments ?? []}
          assignmentsLoading={assignmentsQuery.isLoading}
          cart={cart}
          onOpenGrant={openGrant}
          selectedSubject={selectedSubject}
          onSelectSubject={setSelectedSubject}
        />
      )}

      <AnimatePresence>
        {modal !== null && (
          <GrantModal
            onClose={() => setModal(null)}
            onStage={cart.stageGrant}
            users={users}
            groups={groups}
            gameServers={(gameServersQuery.data?.servers ?? []).map((server) => server.name)}
            wordpressSites={(wordpressQuery.data?.sites ?? []).map((entry) => entry.site)}
            wordpressLoading={wordpressQuery.isLoading}
            initial={modal}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
