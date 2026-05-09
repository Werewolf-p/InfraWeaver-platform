"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Shield, AlertTriangle, CheckCircle2, RefreshCw, Lock, Users, Loader2 } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

interface PodAuditIssue {
  pod: string;
  namespace: string;
  severity: "Critical" | "Warning" | "Info";
  issue: string;
}

interface CertInfo {
  name: string;
  namespace: string;
  valid: boolean;
  expiry: string | null;
  daysLeft: number | null;
}

interface RbacInfo {
  serviceAccounts: Array<{
    name: string;
    namespace: string;
    bindings: string[];
    isClusterAdmin: boolean;
  }>;
}

function SeverityBadge({ severity }: { severity: "Critical" | "Warning" | "Info" }) {
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", {
      "bg-red-500/20 text-red-400 border border-red-500/30": severity === "Critical",
      "bg-orange-500/20 text-orange-400 border border-orange-500/30": severity === "Warning",
      "bg-blue-500/20 text-blue-400 border border-blue-500/30": severity === "Info",
    })}>
      {severity}
    </span>
  );
}

export default function SecurityPage() {
  const { isAdmin } = useRBAC();
  const router = useRouter();
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!isAdmin) router.push("/apps");
  }, [isAdmin, router]);

  const { data: pods, isLoading: podsLoading, refetch: refetchPods } = useQuery<Array<{
    name: string; namespace: string; status: string;
    securityContext?: { privileged?: boolean; runAsNonRoot?: boolean; runAsUser?: number };
    hostNetwork?: boolean;
    containers?: Array<{ resources?: { limits?: Record<string, string> }; securityContext?: { privileged?: boolean; runAsNonRoot?: boolean } }>;
  }>>({
    queryKey: ["pods", "security"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: certsData, isLoading: certsLoading, refetch: refetchCerts } = useQuery<{ certs: CertInfo[] }>({
    queryKey: ["security", "certs"],
    queryFn: async () => {
      const res = await fetch("/api/security/certs");
      return res.json();
    },
    staleTime: 60000,
  });

  const { data: rbacData, isLoading: rbacLoading, refetch: refetchRbac } = useQuery<RbacInfo>({
    queryKey: ["security", "rbac"],
    queryFn: async () => {
      const res = await fetch("/api/security/rbac");
      return res.json();
    },
    staleTime: 60000,
  });

  const podIssues: PodAuditIssue[] = [];
  (pods ?? []).forEach(pod => {
    if (pod.hostNetwork) {
      podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Critical", issue: "Uses hostNetwork: true" });
    }
    if (pod.containers && pod.containers.length > 0) {
      pod.containers.forEach(c => {
        if (c.securityContext?.privileged) {
          podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Critical", issue: "Privileged container" });
        }
        if (!c.resources?.limits) {
          podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Missing resource limits" });
        }
        if (c.securityContext?.runAsNonRoot === false) {
          podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Container runs as root" });
        }
      });
    } else {
      podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Missing resource limits" });
    }
  });

  const isLoading = podsLoading || certsLoading || rbacLoading;

  const handleRescan = () => {
    refetchPods();
    refetchCerts();
    refetchRbac();
    forceUpdate(n => n + 1);
  };

  if (!isAdmin) return null;

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
            <Shield className="w-5 h-5 text-red-400" />
            Security Audit
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Admin-only security scan of cluster resources</p>
        </div>
        <button
          onClick={handleRescan}
          disabled={isLoading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Re-scan
        </button>
      </div>

      {isLoading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-3 mb-6 px-4 py-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20"
        >
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          <span className="text-sm text-indigo-300">Scanning cluster...</span>
        </motion.div>
      )}

      <div className="space-y-6">
        {/* Pod Security Audit */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-orange-400" />
            Pod Security Audit
            <span className="ml-auto text-xs text-slate-500">{podIssues.length} issues found</span>
          </h3>
          {podsLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <div key={i} className="h-14 rounded-lg shimmer-bg" />)}
            </div>
          ) : podIssues.length === 0 ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No pod security issues detected</p>
            </div>
          ) : (
            <div className="space-y-2">
              {podIssues.map((issue, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                >
                  <SeverityBadge severity={issue.severity} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{issue.pod}</p>
                    <p className="text-xs text-slate-500">{issue.namespace} · {issue.issue}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>

        {/* TLS Certificate Status */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Lock className="w-4 h-4 text-blue-400" />
            TLS Certificate Status
          </h3>
          {certsLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => <div key={i} className="h-12 rounded-lg shimmer-bg" />)}
            </div>
          ) : (
            <div className="space-y-2">
              {(certsData?.certs ?? []).map((cert, i) => {
                const severity = cert.daysLeft !== null
                  ? cert.daysLeft < 14 ? "Critical" as const : cert.daysLeft < 30 ? "Warning" as const : null
                  : null;
                return (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5">
                    <div className={cn("w-2 h-2 rounded-full flex-shrink-0", cert.valid ? "bg-green-500" : "bg-red-500")} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{cert.name}</p>
                      <p className="text-xs text-slate-500">{cert.namespace}{cert.expiry ? ` · expires ${new Date(cert.expiry).toLocaleDateString()}` : ""}</p>
                    </div>
                    {cert.daysLeft !== null && (
                      <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", {
                        "text-red-400 bg-red-500/10": (cert.daysLeft ?? 0) < 14,
                        "text-orange-400 bg-orange-500/10": (cert.daysLeft ?? 0) >= 14 && (cert.daysLeft ?? 0) < 30,
                        "text-green-400 bg-green-500/10": (cert.daysLeft ?? 0) >= 30,
                      })}>
                        {cert.daysLeft}d left
                      </span>
                    )}
                    {severity && <SeverityBadge severity={severity} />}
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* RBAC Summary */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Users className="w-4 h-4 text-purple-400" />
            RBAC Summary
          </h3>
          {rbacLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <div key={i} className="h-10 rounded-lg shimmer-bg" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-white/5">
                    <th className="text-left pb-2 font-medium">Service Account</th>
                    <th className="text-left pb-2 font-medium">Namespace</th>
                    <th className="text-left pb-2 font-medium">Bindings</th>
                    <th className="text-left pb-2 font-medium">Risk</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {(rbacData?.serviceAccounts ?? []).filter(sa => sa.bindings.length > 0).map((sa, i) => (
                    <tr key={i} className={cn("transition-colors", sa.isClusterAdmin && "bg-red-500/5")}>
                      <td className="py-2 text-slate-200 font-medium">{sa.name}</td>
                      <td className="py-2 text-slate-400">{sa.namespace}</td>
                      <td className="py-2 text-slate-400">{sa.bindings.join(", ")}</td>
                      <td className="py-2">
                        {sa.isClusterAdmin && <SeverityBadge severity="Critical" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
