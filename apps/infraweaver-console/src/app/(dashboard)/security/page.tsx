"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Shield, AlertTriangle, CheckCircle2, RefreshCw, Lock, Users, Loader2,
  KeyRound, Network, FileWarning, Server, Box, Activity, Database,
  ChevronDown, ChevronRight, Clock, Cpu,
  AlertCircle, BookOpen, Layers, GitBranch, HardDrive, BarChart2, Download,
  Filter, RotateCcw,
} from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { useRouter } from "next/navigation";
import { cn, timeAgo } from "@/lib/utils";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PostureGauge } from "@/components/security/posture-gauge";
import { AuditLogTable } from "@/components/security/audit-log-table";
import { useAuditLog } from "@/hooks/use-audit-log";

// ─── Types ───────────────────────────────────────────────────────────────────

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
    hasWildcard?: boolean;
  }>;
}

interface EnhancedData {
  overview: {
    rootPodCount: number;
    privilegedCount: number;
    hostPathCount: number;
    noLimitsCount: number;
    secretCount: number;
    cmCount: number;
    argocdOutOfSync: number;
    certCount: number;
    certRenewalPending: number;
    longhornHealthy: number;
    longhornDegraded: number;
    longhornFaulted: number;
    metallbPoolUsed: number;
    metallbPoolTotal: number;
    nodePressureCount: number;
    nodeCount: number;
  };
  podSecurityIssues: Array<{ pod: string; namespace: string; severity: string; issues: string[] }>;
  unprotectedNamespaces: string[];
  pdbList: Array<{
    name: string; namespace: string; minAvailable?: number | string;
    maxUnavailable?: number | string; currentHealthy: number;
    desiredHealthy: number; disruptionsAllowed: number; expectedPods: number;
  }>;
  nodePressure: Array<{
    name: string; memoryPressure: boolean; cpuPressure: boolean;
    pidPressure: boolean; diskPressure: boolean; ready: boolean;
  }>;
  externalSecrets: Array<{
    name: string; namespace: string; ready: boolean; lastSyncTime: string | null; targetSecret: string;
  }>;
  kyvernoViolations: Array<{
    name: string; namespace: string; severity: string; category: string;
    policy: string; resource: string; message: string;
  }>;
  openbaoStatus: {
    initialized: boolean; sealed: boolean; standby: boolean; version: string;
    keyShares: number; keyThreshold: number;
  };
  runningImages: Array<{ image: string; vulnerable: boolean; cveCount: number; severity: string }>;
}

interface AuthEventsData {
  events: Array<{
    id: string; timestamp: string; action: string; user: string;
    ip: string; success: boolean; details?: string;
  }>;
  source: string;
}

interface PostureData {
  score: number;
  grade: string;
  breakdown: {
    pods: { rootPods: number; privEscPods: number; noLimitsPods: number; totalPods: number; deduction: number };
    namespaces: { unprotected: string[]; total: number; deduction: number };
    certs: { deduction: number };
  };
  trend: "improving" | "declining" | "stable";
}

interface KyvernoViolation {
  policy: string;
  namespace: string;
  resource: string;
  kind: string;
  severity: string;
  message: string;
  category: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const s = severity.toLowerCase();
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full border", {
      "bg-red-500/20 text-red-400 border-red-500/30": s === "critical" || s === "high",
      "bg-orange-500/20 text-orange-400 border-orange-500/30": s === "warning" || s === "medium",
      "bg-blue-500/20 text-blue-400 border-blue-500/30": s === "info" || s === "low",
      "bg-slate-500/20 text-slate-400 border-slate-500/30": !["critical","high","warning","medium","info","low"].includes(s),
    })}>
      {severity}
    </span>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", ok ? "bg-green-500" : "bg-red-500")} />;
}

function CertLifetimeBar({ daysLeft }: { daysLeft: number | null }) {
  if (daysLeft === null) return null;
  const assumed = 90;
  const used = Math.max(0, Math.min(100, ((assumed - daysLeft) / assumed) * 100));
  const color = daysLeft < 14 ? "bg-red-500" : daysLeft < 30 ? "bg-orange-500" : "bg-green-500";
  return (
    <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
      <motion.div
        className={cn("h-full rounded-full", color)}
        initial={{ width: 0 }}
        animate={{ width: `${used}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      />
    </div>
  );
}

function CertCountdown({ daysLeft }: { daysLeft: number | null }) {
  if (daysLeft === null) return <span className="text-xs text-slate-500">unknown</span>;
  const color = daysLeft < 14 ? "text-red-400 bg-red-500/10" : daysLeft < 30 ? "text-orange-400 bg-orange-500/10" : "text-green-400 bg-green-500/10";
  return (
    <span className={cn("text-xs font-mono font-bold px-2 py-0.5 rounded-full tabular-nums", color)}>
      {daysLeft}d
    </span>
  );
}

function SectionCard({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      className="bg-white/5 border border-white/10 rounded-xl p-3 md:p-5"
    >
      {children}
    </motion.div>
  );
}

function Shimmer({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg shimmer-bg" />
      ))}
    </div>
  );
}

interface StatCard {
  label: string;
  value: string | number;
  icon: React.ElementType;
  status: "ok" | "warn" | "crit";
  sub?: string;
}

function OverviewCard({ card, delay }: { card: StatCard; delay: number }) {
  const color = card.status === "crit" ? "border-red-500/30 bg-red-500/5"
    : card.status === "warn" ? "border-orange-500/30 bg-orange-500/5"
    : "border-white/10 bg-white/5";
  const iconColor = card.status === "crit" ? "text-red-400" : card.status === "warn" ? "text-orange-400" : "text-green-400";
  const valColor = card.status === "crit" ? "text-red-400" : card.status === "warn" ? "text-orange-400" : "text-white";
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.3 }}
      className={cn("border rounded-xl p-3 md:p-4 flex flex-col gap-2 touch-manipulation active:scale-95 transition-transform", color)}
    >
      <div className="flex items-center justify-between">
        <card.icon className={cn("w-4 h-4", iconColor)} />
        {card.status === "crit" && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
        {card.status === "warn" && <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />}
        {card.status === "ok" && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
      </div>
      <div>
        <p className={cn("text-2xl font-bold tabular-nums", valColor)}>{card.value}</p>
        <p className="text-xs text-slate-400 mt-0.5">{card.label}</p>
        {card.sub && <p className="text-xs text-slate-500 mt-0.5">{card.sub}</p>}
      </div>
    </motion.div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SecurityPage() {
  const { isAdmin } = useRBAC();
  const router = useRouter();
  const [expandedViolation, setExpandedViolation] = useState<number | null>(null);
  const [expandedKyverno, setExpandedKyverno] = useState<number | null>(null);
  const [kyvernoSevFilter, setKyvernoSevFilter] = useState("all");
  const [authTimeFilter, setAuthTimeFilter] = useState<"24h" | "7d" | "30d">("7d");
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set());
  const [renewingCert, setRenewingCert] = useState<string | null>(null);

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
    queryFn: async () => { const r = await fetch("/api/pods"); return r.json(); },
    staleTime: 30000,
  });

  const { data: certsData, isLoading: certsLoading, refetch: refetchCerts } = useQuery<{ certs: CertInfo[] }>({
    queryKey: ["security", "certs"],
    queryFn: async () => { const r = await fetch("/api/security/certs"); return r.json(); },
    staleTime: 60000,
  });

  const { data: rbacData, isLoading: rbacLoading, refetch: refetchRbac } = useQuery<RbacInfo>({
    queryKey: ["security", "rbac"],
    queryFn: async () => { const r = await fetch("/api/security/rbac"); return r.json(); },
    staleTime: 60000,
  });

  const { data: enhanced, isLoading: enhancedLoading, refetch: refetchEnhanced } = useQuery<EnhancedData>({
    queryKey: ["security", "enhanced"],
    queryFn: async () => { const r = await fetch("/api/security/enhanced"); return r.json(); },
    staleTime: 60000,
  });

  const { data: authEvents, isLoading: authEventsLoading, refetch: refetchAuthEvents } = useQuery<AuthEventsData>({
    queryKey: ["security", "auth-events"],
    queryFn: async () => { const r = await fetch("/api/security/auth-events"); return r.json(); },
    staleTime: 30000,
  });

  const { data: postureData, isLoading: postureLoading, refetch: refetchPosture } = useQuery<PostureData>({
    queryKey: ["security", "posture"],
    queryFn: async () => { const r = await fetch("/api/security/posture"); return r.json(); },
    staleTime: 60000,
  });

  const { data: kyvernoData, isLoading: kyvernoLoading, refetch: refetchKyverno } = useQuery<{ violations: KyvernoViolation[] }>({
    queryKey: ["security", "kyverno"],
    queryFn: async () => { const r = await fetch("/api/security/kyverno"); return r.json(); },
    staleTime: 60000,
  });

  const { data: auditLogData, isLoading: auditLogLoading } = useAuditLog();

  // Derive pod issues from /api/pods
  const podIssues: Array<{ pod: string; namespace: string; severity: "Critical" | "Warning" | "Info"; issue: string }> = [];
  (pods ?? []).forEach(pod => {
    if (pod.hostNetwork) {
      podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Critical", issue: "Uses hostNetwork: true" });
    }
    (pod.containers ?? []).forEach(c => {
      if (c.securityContext?.privileged) podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Critical", issue: "Privileged container" });
      if (!c.resources?.limits) podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Missing resource limits" });
      if (c.securityContext?.runAsNonRoot === false) podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Container runs as root" });
    });
    if (!pod.containers || pod.containers.length === 0) {
      podIssues.push({ pod: pod.name, namespace: pod.namespace, severity: "Warning", issue: "Missing resource limits" });
    }
  });

  const isLoading = podsLoading || certsLoading || rbacLoading || enhancedLoading;

  const handleRescan = useCallback(() => {
    refetchPods(); refetchCerts(); refetchRbac(); refetchEnhanced(); refetchAuthEvents();
    refetchPosture(); refetchKyverno();
  }, [refetchPods, refetchCerts, refetchRbac, refetchEnhanced, refetchAuthEvents, refetchPosture, refetchKyverno]);

  const sortedCerts = [...(certsData?.certs ?? [])].sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
  const expiringThisMonth = sortedCerts.filter(c => c.daysLeft !== null && c.daysLeft <= 30).length;

  const ov = enhanced?.overview;
  const overviewCards: StatCard[] = ov ? [
    { label: "Pods running as root", value: ov.rootPodCount, icon: Users, status: ov.rootPodCount > 0 ? "crit" : "ok" },
    { label: "Privileged containers", value: ov.privilegedCount, icon: Shield, status: ov.privilegedCount > 0 ? "crit" : "ok" },
    { label: "hostPath mounts", value: ov.hostPathCount, icon: HardDrive, status: ov.hostPathCount > 3 ? "warn" : ov.hostPathCount > 0 ? "warn" : "ok" },
    { label: "No resource limits", value: ov.noLimitsCount, icon: Cpu, status: ov.noLimitsCount > 5 ? "crit" : ov.noLimitsCount > 0 ? "warn" : "ok" },
    { label: "Secrets / ConfigMaps", value: `${ov.secretCount} / ${ov.cmCount}`, icon: Database, status: "ok", sub: "ratio" },
    { label: "ArgoCD OutOfSync", value: ov.argocdOutOfSync, icon: GitBranch, status: ov.argocdOutOfSync > 0 ? "warn" : "ok" },
    { label: "cert-manager certs", value: ov.certCount, icon: Lock, status: ov.certRenewalPending > 0 ? "warn" : "ok", sub: `${ov.certRenewalPending} renewal pending` },
    { label: "Longhorn volumes", value: `${ov.longhornHealthy}h / ${ov.longhornDegraded}d`, icon: Database, status: ov.longhornFaulted > 0 ? "crit" : ov.longhornDegraded > 0 ? "warn" : "ok", sub: `${ov.longhornFaulted} faulted` },
    { label: "MetalLB pool", value: `${ov.metallbPoolUsed} / ${ov.metallbPoolTotal}`, icon: Network, status: ov.metallbPoolUsed / (ov.metallbPoolTotal || 1) > 0.8 ? "warn" : "ok", sub: "IPs in use" },
    { label: "Node pressure", value: ov.nodePressureCount, icon: Activity, status: ov.nodePressureCount > 0 ? "crit" : "ok", sub: `${ov.nodeCount} nodes total` },
  ] : [];

  const kyvernoBySeverity = (enhanced?.kyvernoViolations ?? []).reduce<Record<string, EnhancedData["kyvernoViolations"]>>((acc, v) => {
    const sev = v.severity.toLowerCase();
    acc[sev] = [...(acc[sev] ?? []), v];
    return acc;
  }, {});

  // Auth events time filter
  const filteredAuthEvents = useMemo(() => {
    const now = Date.now();
    const cutoffs = { "24h": now - 86400000, "7d": now - 604800000, "30d": now - 2592000000 };
    const cutoff = cutoffs[authTimeFilter];
    return (authEvents?.events ?? []).filter(e => new Date(e.timestamp).getTime() >= cutoff);
  }, [authEvents, authTimeFilter]);

  // Kyverno violations from new endpoint
  const allKyvernoViolations = kyvernoData?.violations ?? [];
  const filteredKyvernoViolations = kyvernoSevFilter === "all"
    ? allKyvernoViolations
    : allKyvernoViolations.filter(v => v.severity.toLowerCase() === kyvernoSevFilter);

  // Pod issues grouped by namespace
  const issuesByNs = useMemo(() => {
    const issues = enhanced?.podSecurityIssues ?? [];
    const map = new Map<string, typeof issues>();
    for (const issue of issues) {
      const arr = map.get(issue.namespace) ?? [];
      arr.push(issue);
      map.set(issue.namespace, arr);
    }
    return map;
  }, [enhanced]);

  const toggleNs = (ns: string) => {
    setExpandedNs(prev => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  // Severity counts for pod security
  const sevCounts = useMemo(() => {
    const issues = enhanced?.podSecurityIssues ?? podIssues.map(i => ({ ...i, issues: [i.issue] }));
    return {
      critical: issues.filter(i => i.severity.toLowerCase() === "critical").length,
      high: issues.filter(i => i.severity.toLowerCase() === "high").length,
      medium: issues.filter(i => ["medium", "warning"].includes(i.severity.toLowerCase())).length,
      low: issues.filter(i => ["low", "info"].includes(i.severity.toLowerCase())).length,
    };
  }, [enhanced, podIssues]);

  const handleRenewCert = async (cert: CertInfo) => {
    const key = `${cert.namespace}/${cert.name}`;
    setRenewingCert(key);
    try {
      await fetch("/api/security/certs/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: cert.namespace, name: cert.name, issuerName: "letsencrypt-prod" }),
      });
    } finally {
      setRenewingCert(null);
      void refetchCerts();
    }
  };

  if (!isAdmin) return null;

  return (
    <div>
      {/* Header */}
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-security pointer-events-none" />
        <div className="relative flex items-start justify-between p-5 gap-4 flex-wrap">
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
      </div>

      {isLoading && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 mb-6 px-4 py-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          <span className="text-sm text-indigo-300">Scanning cluster…</span>
        </motion.div>
      )}

      <div className="space-y-6">

        {/* ── Security Posture Score ── */}
        <SectionCard delay={0}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-indigo-400" />
            Security Posture Score
          </h3>
          {postureLoading ? (
            <div className="flex items-center justify-center py-8"><Shimmer rows={2} /></div>
          ) : postureData ? (
            <div className="flex flex-col md:flex-row items-center gap-6">
              <PostureGauge
                score={postureData.score}
                grade={postureData.grade}
                trend={postureData.trend}
                size="md"
              />
              <div className="flex-1 space-y-2 w-full">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { label: "Pods deduction", value: `-${postureData.breakdown.pods.deduction}`, sub: `${postureData.breakdown.pods.rootPods} root, ${postureData.breakdown.pods.privEscPods} privesc, ${postureData.breakdown.pods.noLimitsPods} no-limits`, icon: Box },
                    { label: "Namespace deduction", value: `-${postureData.breakdown.namespaces.deduction}`, sub: `${postureData.breakdown.namespaces.unprotected.length} of ${postureData.breakdown.namespaces.total} unprotected`, icon: Network },
                    { label: "Cert deduction", value: `-${postureData.breakdown.certs.deduction}`, sub: "from cert expiry", icon: Lock },
                  ].map((item, i) => (
                    <div key={i} className="p-3 rounded-lg bg-white/5 border border-white/5">
                      <div className="flex items-center gap-1.5 mb-1">
                        <item.icon className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-xs text-slate-400">{item.label}</span>
                      </div>
                      <p className="text-lg font-bold text-red-400 tabular-nums">{item.value}</p>
                      <p className="text-xs text-slate-500">{item.sub}</p>
                    </div>
                  ))}
                </div>
                <div className="p-3 rounded-lg bg-white/5 border border-white/5 text-xs text-slate-400">
                  <span className="font-semibold text-white">Total Score: {postureData.score}/100 · Grade {postureData.grade}</span>
                  {" — "}Scoring: -2/root pod (max -20), -3/privesc pod (max -15), -1/no-limits pod (max -10), -5/unprotected ns (max -20)
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500 text-center py-6">Posture score unavailable</p>
          )}
        </SectionCard>

        {/* ── Overview Grid ── */}
        {overviewCards.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Security Overview</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {overviewCards.map((card, i) => (
                <OverviewCard key={card.label} card={card} delay={i * 0.04} />
              ))}
            </div>
          </div>
        )}
        {enhancedLoading && !overviewCards.length && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-24 rounded-xl shimmer-bg" />)}
          </div>
        )}

        {/* ── TLS Certificate Expiry (enhanced) ── */}
        <SectionCard delay={0.05}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Lock className="w-4 h-4 text-blue-400" />
            TLS Certificate Expiry
            <span className="ml-auto text-xs text-slate-500">{sortedCerts.length} certs — sorted by urgency</span>
            {expiringThisMonth > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                {expiringThisMonth} expiring this month
              </span>
            )}
          </h3>
          {certsLoading ? <Shimmer rows={3} /> : sortedCerts.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No TLS certificates found</p>
          ) : (
            <div className="space-y-2">
              {sortedCerts.map((cert, i) => {
                const certKey = `${cert.namespace}/${cert.name}`;
                const isRenewing = renewingCert === certKey;
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border",
                      cert.daysLeft !== null && cert.daysLeft < 14
                        ? "bg-red-500/5 border-red-500/20"
                        : cert.daysLeft !== null && cert.daysLeft < 30
                        ? "bg-orange-500/5 border-orange-500/20"
                        : "bg-white/5 border-white/5"
                    )}
                  >
                    <StatusDot ok={cert.valid} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{cert.name}</p>
                      <p className="text-xs text-slate-500">
                        {cert.namespace}
                        {cert.expiry ? ` · expires ${new Date(cert.expiry).toLocaleDateString()}` : ""}
                      </p>
                      <div className="mt-1">
                        <CertLifetimeBar daysLeft={cert.daysLeft} />
                      </div>
                    </div>
                    <CertCountdown daysLeft={cert.daysLeft} />
                    <button
                      onClick={() => handleRenewCert(cert)}
                      disabled={isRenewing}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {isRenewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                      Renew
                    </button>
                  </motion.div>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* ── ExternalSecret Sync Status ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.35 }}>
          <CollapsibleSection
            title="ExternalSecret Sync Status"
            count={enhanced?.externalSecrets?.length}
            storageKey="sec-external-secrets"
            badge={<KeyRound className="w-4 h-4 text-yellow-400 flex-shrink-0" />}
          >
            {enhancedLoading ? <Shimmer rows={3} /> : (
              <div className="space-y-2">
                {(enhanced?.externalSecrets ?? []).map((es, i) => (
                  <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                    className={cn("flex items-center gap-3 p-3 rounded-lg border", es.ready ? "bg-white/5 border-white/5" : "bg-red-500/5 border-red-500/20")}
                  >
                    <StatusDot ok={es.ready} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{es.name}</p>
                      <p className="text-xs text-slate-500">{es.namespace} → {es.targetSecret}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <span className={cn("text-xs font-semibold", es.ready ? "text-green-400" : "text-red-400")}>
                        {es.ready ? "Ready" : "NotReady"}
                      </span>
                      {es.lastSyncTime && <p className="text-xs text-slate-500">{timeAgo(es.lastSyncTime)}</p>}
                    </div>
                  </motion.div>
                ))}
                {!enhanced?.externalSecrets?.length && !enhancedLoading && (
                  <p className="text-sm text-slate-500 text-center py-4">No ExternalSecrets found</p>
                )}
              </div>
            )}
          </CollapsibleSection>
        </motion.div>

        {/* ── Kyverno Violations Dashboard (new endpoint) ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.09, duration: 0.35 }}>
          <CollapsibleSection
            title="Kyverno Policy Violations"
            count={allKyvernoViolations.length}
            storageKey="sec-kyverno-new"
            badge={
              <span className={cn("w-4 h-4 flex-shrink-0", allKyvernoViolations.length > 0 ? "text-red-400" : "text-green-400")}>
                <BookOpen className="w-4 h-4" />
              </span>
            }
          >
            <div className="space-y-3">
              {/* Severity filter */}
              <div className="flex items-center gap-2 flex-wrap">
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                {["all", "high", "medium", "low"].map(sev => (
                  <button
                    key={sev}
                    onClick={() => setKyvernoSevFilter(sev)}
                    className={cn("px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-colors", kyvernoSevFilter === sev
                      ? "bg-indigo-500/30 text-indigo-300 border-indigo-500/50"
                      : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"
                    )}
                  >
                    {sev.charAt(0).toUpperCase() + sev.slice(1)}
                  </button>
                ))}
                <span className="ml-auto text-xs text-slate-500">{filteredKyvernoViolations.length} violations</span>
              </div>
              
              {kyvernoLoading ? <Shimmer rows={4} /> : filteredKyvernoViolations.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
                  <p className="text-sm text-slate-400">No policy violations detected</p>
                </div>
              ) : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-500 border-b border-white/5">
                        <th className="text-left pb-2 font-medium px-1">Policy</th>
                        <th className="text-left pb-2 font-medium px-1">Resource</th>
                        <th className="text-left pb-2 font-medium px-1 hidden sm:table-cell">Namespace</th>
                        <th className="text-left pb-2 font-medium px-1">Severity</th>
                        <th className="text-left pb-2 font-medium px-1 hidden md:table-cell">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {filteredKyvernoViolations.map((v, i) => (
                        <>
                          <tr
                            key={`row-${i}`}
                            onClick={() => setExpandedKyverno(expandedKyverno === i ? null : i)}
                            className="cursor-pointer hover:bg-white/5 transition-colors"
                          >
                            <td className="py-2 px-1 text-slate-200 font-medium font-mono truncate max-w-[120px]">{v.policy}</td>
                            <td className="py-2 px-1 text-slate-400 truncate max-w-[100px]">{v.resource}</td>
                            <td className="py-2 px-1 text-slate-400 hidden sm:table-cell">{v.namespace}</td>
                            <td className="py-2 px-1"><SeverityBadge severity={v.severity} /></td>
                            <td className="py-2 px-1 text-slate-500 truncate max-w-[200px] hidden md:table-cell">{v.message}</td>
                          </tr>
                          {expandedKyverno === i && (
                            <tr key={`exp-${i}`}>
                              <td colSpan={5} className="px-1 pb-2">
                                <div className="p-3 bg-white/5 border border-white/5 rounded-lg text-xs text-slate-400 space-y-1">
                                  <p><span className="text-slate-500">Category:</span> {v.category}</p>
                                  <p><span className="text-slate-500">Kind:</span> {v.kind}</p>
                                  <p><span className="text-slate-500">Message:</span> {v.message}</p>
                                  <p className="text-indigo-400 mt-2">💡 Remediation: Review the Kyverno policy <code className="font-mono bg-white/10 px-1 rounded">{v.policy}</code> and update the resource spec to comply.</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </CollapsibleSection>
        </motion.div>

        {/* ── Kyverno Violations (from enhanced, legacy) ── */}
        <SectionCard delay={0.1}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-purple-400" />
            Kyverno Violations (Enhanced Scan)
            {enhanced && (
              <span className="ml-auto text-xs text-slate-500">
                {enhanced.kyvernoViolations.length} violation{enhanced.kyvernoViolations.length !== 1 ? "s" : ""}
              </span>
            )}
          </h3>
          {enhancedLoading ? <Shimmer rows={4} /> : enhanced?.kyvernoViolations?.length === 0 ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No policy violations detected</p>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(kyvernoBySeverity).sort(([a], [b]) => {
                const order = ["critical", "high", "medium", "low"];
                return order.indexOf(a) - order.indexOf(b);
              }).map(([severity, violations]) => (
                <div key={severity}>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">{severity} ({violations.length})</p>
                  {violations.map((v, i) => {
                    const idx = enhanced?.kyvernoViolations?.indexOf(v) ?? i;
                    return (
                      <div key={i} className="mb-1.5">
                        <button
                          onClick={() => setExpandedViolation(expandedViolation === idx ? null : idx)}
                          className="w-full flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors text-left"
                        >
                          {expandedViolation === idx ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                          <SeverityBadge severity={v.severity} />
                          <span className="text-sm text-white font-medium flex-1 truncate">{v.name}</span>
                          <span className="text-xs text-slate-500 flex-shrink-0">{v.namespace}</span>
                        </button>
                        <AnimatePresence>
                          {expandedViolation === idx && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="mx-1 p-3 bg-white/5 border border-white/5 border-t-0 rounded-b-lg text-xs text-slate-400 space-y-1">
                                <p><span className="text-slate-500">Policy:</span> {v.policy}</p>
                                <p><span className="text-slate-500">Resource:</span> {v.resource}</p>
                                <p><span className="text-slate-500">Category:</span> {v.category}</p>
                                <p><span className="text-slate-500">Message:</span> {v.message}</p>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Pod Security Audit (enhanced with severity bars + ns grouping) ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12, duration: 0.35 }}>
          <CollapsibleSection
            title="Pod Security Audit"
            count={enhanced?.podSecurityIssues?.length ?? podIssues.length}
            storageKey="sec-pod-security"
            badge={<AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />}
          >
            {(podsLoading || enhancedLoading) ? <Shimmer rows={4} /> : (() => {
              const issues = enhanced?.podSecurityIssues ?? [];
              const totalIssues = issues.length || podIssues.length;
              return totalIssues === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
                  <p className="text-sm text-slate-400">No pod security issues detected</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Severity bars */}
                  <div className="grid grid-cols-4 gap-2 mb-2">
                    {[
                      { label: "Critical", count: sevCounts.critical, color: "bg-red-500" },
                      { label: "High", count: sevCounts.high, color: "bg-orange-500" },
                      { label: "Medium", count: sevCounts.medium, color: "bg-yellow-500" },
                      { label: "Low", count: sevCounts.low, color: "bg-blue-500" },
                    ].map(({ label, count, color }) => (
                      <div key={label} className="p-2 rounded-lg bg-white/5 border border-white/5 text-center">
                        <p className="text-lg font-bold text-white tabular-nums">{count}</p>
                        <p className="text-xs text-slate-500">{label}</p>
                        <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden">
                          <div className={cn("h-full rounded-full", color)} style={{ width: totalIssues > 0 ? `${(count / totalIssues) * 100}%` : "0%" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  {/* Grouped by namespace */}
                  {issues.length > 0 ? (
                    Array.from(issuesByNs.entries()).map(([ns, nsIssues]) => (
                      <div key={ns}>
                        <button
                          onClick={() => toggleNs(ns)}
                          className="w-full flex items-center gap-2 py-1.5 text-left text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                        >
                          {expandedNs.has(ns) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <span className="font-mono">{ns}</span>
                          <span className="ml-1 text-slate-600">({nsIssues.length} issues)</span>
                        </button>
                        {expandedNs.has(ns) && (
                          <div className="space-y-1.5 ml-4">
                            {nsIssues.map((issue, i) => (
                              <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                                className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                              >
                                <SeverityBadge severity={issue.severity} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white font-medium truncate">{issue.pod}</p>
                                  <ul className="mt-1 space-y-0.5">
                                    {issue.issues.map((iss, j) => (
                                      <li key={j} className="text-xs text-slate-400 flex items-center gap-1">
                                        <span className="text-slate-600">·</span> {iss}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </motion.div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    podIssues.map((issue, i) => (
                      <motion.div key={`basic-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                        className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                      >
                        <SeverityBadge severity={issue.severity} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium truncate">{issue.pod}</p>
                          <p className="text-xs text-slate-500">{issue.namespace} · {issue.issue}</p>
                        </div>
                      </motion.div>
                    ))
                  )}
                </div>
              );
            })()}
          </CollapsibleSection>
        </motion.div>

        {/* ── Auth Events (enhanced with time filter) ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, duration: 0.35 }}>
          <CollapsibleSection
            title="Recent Auth Events"
            count={filteredAuthEvents.length}
            storageKey="sec-auth-events"
            badge={<Clock className="w-4 h-4 text-rose-400 flex-shrink-0" />}
          >
            <div className="space-y-3">
              {/* Time filter */}
              <div className="flex items-center gap-2">
                {(["24h", "7d", "30d"] as const).map(tf => (
                  <button
                    key={tf}
                    onClick={() => setAuthTimeFilter(tf)}
                    className={cn("px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-colors", authTimeFilter === tf
                      ? "bg-rose-500/30 text-rose-300 border-rose-500/50"
                      : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"
                    )}
                  >
                    Last {tf}
                  </button>
                ))}
                <span className="ml-auto text-xs text-slate-500 italic">{authEvents?.source ?? "loading"}</span>
              </div>
              {authEventsLoading ? <Shimmer rows={4} /> : (
                <div className="space-y-2">
                  {filteredAuthEvents.map((evt, i) => {
                    const isSuspicious = evt.details?.toLowerCase().includes("brute") || evt.ip.startsWith("185.");
                    const isNewDevice = evt.details?.toLowerCase().includes("new device");
                    const rowClass = !evt.success ? "bg-red-500/5 border-red-500/20"
                      : isSuspicious ? "bg-orange-500/5 border-orange-500/20"
                      : isNewDevice ? "bg-blue-500/5 border-blue-500/20"
                      : "bg-white/5 border-white/5";
                    return (
                      <motion.div key={evt.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                        className={cn("flex items-center gap-3 p-3 rounded-lg border", rowClass)}
                      >
                        <StatusDot ok={evt.success} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium truncate">{evt.user}</p>
                          <p className="text-xs text-slate-500">{evt.action}{evt.details ? ` · ${evt.details}` : ""}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <span className={cn("text-xs font-semibold", evt.success ? "text-green-400" : "text-red-400")}>
                            {evt.success ? "OK" : "FAIL"}
                          </span>
                          <p className="text-xs text-slate-500">{evt.ip}</p>
                          <p className="text-xs text-slate-600">{timeAgo(evt.timestamp)}</p>
                        </div>
                      </motion.div>
                    );
                  })}
                  {filteredAuthEvents.length === 0 && (
                    <p className="text-sm text-slate-500 text-center py-4">No auth events in this time window</p>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
        </motion.div>

        {/* ── Audit Log Trail ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}>
          <CollapsibleSection
            title="Audit Log Trail"
            count={auditLogData?.entries?.length}
            storageKey="sec-audit-log"
            badge={<Download className="w-4 h-4 text-emerald-400 flex-shrink-0" />}
          >
            <AuditLogTable
              entries={auditLogData?.entries ?? []}
              isLoading={auditLogLoading}
            />
          </CollapsibleSection>
        </motion.div>

        {/* ── ServiceAccount RBAC Audit ── */}
        <SectionCard delay={0.16}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Users className="w-4 h-4 text-purple-400" />
            RBAC / ServiceAccount Audit
            {rbacData && (
              <span className="ml-auto text-xs text-slate-500">
                {rbacData.serviceAccounts.filter(sa => sa.isClusterAdmin || sa.hasWildcard).length} flagged
              </span>
            )}
          </h3>
          {rbacLoading ? <Shimmer rows={4} /> : (
            <div className="overflow-x-auto -mx-3 px-3 md:-mx-5 md:px-5">
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
                    <tr key={i} className={cn("transition-colors", (sa.isClusterAdmin || sa.hasWildcard) && "bg-red-500/5")}>
                      <td className="py-2 text-slate-200 font-medium">{sa.name}</td>
                      <td className="py-2 text-slate-400">{sa.namespace}</td>
                      <td className="py-2 text-slate-400 max-w-xs truncate">{sa.bindings.join(", ")}</td>
                      <td className="py-2">
                        {sa.isClusterAdmin && <SeverityBadge severity="Critical" />}
                        {!sa.isClusterAdmin && sa.hasWildcard && <SeverityBadge severity="Warning" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rbacData?.serviceAccounts?.filter(sa => sa.bindings.length > 0).length && (
                <p className="text-sm text-slate-500 text-center py-4">No bound service accounts found</p>
              )}
            </div>
          )}
        </SectionCard>

        {/* ── PodDisruptionBudgets ── */}
        <SectionCard delay={0.18}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            PodDisruptionBudgets
            {enhanced && (
              <span className="ml-auto text-xs text-slate-500">{enhanced.pdbList.length} PDBs</span>
            )}
          </h3>
          {enhancedLoading ? <Shimmer rows={3} /> : (enhanced?.pdbList ?? []).length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">No PodDisruptionBudgets found</p>
          ) : (
            <div className="overflow-x-auto -mx-3 px-3 md:-mx-5 md:px-5">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-white/5">
                    <th className="text-left pb-2 font-medium">Name</th>
                    <th className="text-left pb-2 font-medium">Namespace</th>
                    <th className="text-left pb-2 font-medium">Min/Max</th>
                    <th className="text-left pb-2 font-medium">Healthy</th>
                    <th className="text-left pb-2 font-medium">Disruptions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {(enhanced?.pdbList ?? []).map((pdb, i) => (
                    <tr key={i} className={cn("transition-colors", pdb.disruptionsAllowed === 0 && "bg-orange-500/5")}>
                      <td className="py-2 text-slate-200 font-medium">{pdb.name}</td>
                      <td className="py-2 text-slate-400">{pdb.namespace}</td>
                      <td className="py-2 text-slate-400">
                        {pdb.minAvailable !== undefined ? `min:${pdb.minAvailable}` : ""}
                        {pdb.maxUnavailable !== undefined ? `max:${pdb.maxUnavailable}` : ""}
                      </td>
                      <td className="py-2">
                        <span className={cn("font-semibold", pdb.currentHealthy >= pdb.desiredHealthy ? "text-green-400" : "text-red-400")}>
                          {pdb.currentHealthy}/{pdb.expectedPods}
                        </span>
                      </td>
                      <td className="py-2">
                        <span className={cn("font-semibold", pdb.disruptionsAllowed > 0 ? "text-green-400" : "text-orange-400")}>
                          {pdb.disruptionsAllowed}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* ── Network Policy Coverage ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.35 }}>
          <CollapsibleSection
            title="Network Policy Coverage"
            count={enhanced?.unprotectedNamespaces?.length}
            storageKey="sec-network-policy"
            badge={<Network className="w-4 h-4 text-teal-400 flex-shrink-0" />}
          >
            {enhancedLoading ? <Shimmer rows={3} /> : (
              <div className="space-y-2">
                {(enhanced?.unprotectedNamespaces ?? []).length === 0 ? (
                  <div className="text-center py-8">
                    <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
                    <p className="text-sm text-slate-400">All namespaces have NetworkPolicies</p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-slate-500 mb-2">Namespaces with no NetworkPolicies (pods open to all traffic):</p>
                    {(enhanced?.unprotectedNamespaces ?? []).map((ns, i) => (
                      <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                        className="flex items-center gap-3 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20"
                      >
                        <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />
                        <span className="text-sm text-white font-medium">{ns}</span>
                        <span className="ml-auto text-xs text-orange-400 font-semibold">Unprotected</span>
                      </motion.div>
                    ))}
                  </>
                )}
              </div>
            )}
          </CollapsibleSection>
        </motion.div>

        {/* ── Running Container Images ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22, duration: 0.35 }}>
          <CollapsibleSection
            title="Running Container Images"
            count={enhanced?.runningImages?.length}
            storageKey="sec-images"
            badge={<Box className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
          >
            {enhancedLoading ? <Shimmer rows={3} /> : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 text-xs text-blue-300">
                  <FileWarning className="w-4 h-4 flex-shrink-0" />
                  <span>Trivy not available on runner. Showing image inventory. Run <code className="font-mono bg-white/10 px-1 rounded">trivy image &lt;img&gt;</code> locally for CVE details.</span>
                </div>
                {(enhanced?.runningImages ?? []).map((img, i) => (
                  <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                    className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                  >
                    <Box className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                    <span className="text-xs text-slate-300 font-mono truncate">{img.image}</span>
                  </motion.div>
                ))}
                {!(enhanced?.runningImages?.length) && (
                  <p className="text-xs text-slate-500 text-center py-2">No image data available</p>
                )}
              </div>
            )}
          </CollapsibleSection>
        </motion.div>

        {/* ── OpenBao Seal Status ── */}
        <SectionCard delay={0.24}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Database className="w-4 h-4 text-amber-400" />
            OpenBao (Vault) Status
          </h3>
          {enhancedLoading ? <Shimmer rows={2} /> : enhanced?.openbaoStatus ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: "Initialized", value: enhanced.openbaoStatus.initialized ? "Yes" : "No", ok: enhanced.openbaoStatus.initialized },
                { label: "Sealed", value: enhanced.openbaoStatus.sealed ? "Sealed 🔒" : "Unsealed ✓", ok: !enhanced.openbaoStatus.sealed },
                { label: "Standby", value: enhanced.openbaoStatus.standby ? "Standby" : "Active", ok: !enhanced.openbaoStatus.standby },
                { label: "Version", value: enhanced.openbaoStatus.version, ok: true },
                { label: "Key Shares", value: enhanced.openbaoStatus.keyShares, ok: true },
                { label: "Threshold", value: enhanced.openbaoStatus.keyThreshold, ok: true },
              ].map((item, i) => (
                <div key={i} className={cn("p-3 rounded-lg border", item.ok ? "bg-white/5 border-white/5" : "bg-red-500/5 border-red-500/20")}>
                  <p className="text-xs text-slate-500">{item.label}</p>
                  <p className={cn("text-sm font-semibold mt-0.5", item.ok ? "text-white" : "text-red-400")}>{String(item.value)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500 text-center py-4">OpenBao status unavailable</p>
          )}
        </SectionCard>

        {/* ── Node Resource Pressure ── */}
        <SectionCard delay={0.26}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Server className="w-4 h-4 text-slate-400" />
            Node Resource Pressure
            {enhanced && (
              <span className={cn("ml-auto text-xs font-semibold", enhanced.nodePressure.some(n => n.memoryPressure || n.diskPressure || n.pidPressure) ? "text-red-400" : "text-green-400")}>
                {enhanced.nodePressure.filter(n => n.memoryPressure || n.diskPressure || n.pidPressure).length} nodes under pressure
              </span>
            )}
          </h3>
          {enhancedLoading ? <Shimmer rows={3} /> : (
            <div className="space-y-2">
              {(enhanced?.nodePressure ?? []).map((node, i) => {
                const pressures = [
                  node.memoryPressure && "Memory",
                  node.diskPressure && "Disk",
                  node.pidPressure && "PID",
                  node.cpuPressure && "CPU",
                ].filter(Boolean);
                const anyPressure = pressures.length > 0;
                return (
                  <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                    className={cn("flex items-center gap-3 p-3 rounded-lg border", anyPressure ? "bg-red-500/5 border-red-500/20" : "bg-white/5 border-white/5")}
                  >
                    <StatusDot ok={node.ready && !anyPressure} />
                    <div className="flex-1">
                      <p className="text-sm text-white font-medium">{node.name}</p>
                      {anyPressure ? (
                        <p className="text-xs text-red-400">{pressures.join(", ")} pressure</p>
                      ) : (
                        <p className="text-xs text-slate-500">No pressure conditions</p>
                      )}
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <span title="Memory" className={cn("w-2 h-2 rounded-full", node.memoryPressure ? "bg-red-500" : "bg-green-500/40")} />
                      <span title="Disk" className={cn("w-2 h-2 rounded-full", node.diskPressure ? "bg-red-500" : "bg-green-500/40")} />
                      <span title="PID" className={cn("w-2 h-2 rounded-full", node.pidPressure ? "bg-red-500" : "bg-green-500/40")} />
                    </div>
                  </motion.div>
                );
              })}
              {!enhanced?.nodePressure?.length && (
                <p className="text-sm text-slate-500 text-center py-4">No node data available</p>
              )}
            </div>
          )}
        </SectionCard>

        {/* ── Longhorn + ArgoCD + MetalLB summary ── */}
        {enhanced && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <SectionCard delay={0.28}>
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-blue-400" />
                Longhorn Health
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Healthy</span><span className="text-green-400 font-semibold">{enhanced.overview.longhornHealthy}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Degraded</span><span className={cn("font-semibold", enhanced.overview.longhornDegraded > 0 ? "text-orange-400" : "text-slate-500")}>{enhanced.overview.longhornDegraded}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Faulted</span><span className={cn("font-semibold", enhanced.overview.longhornFaulted > 0 ? "text-red-400" : "text-slate-500")}>{enhanced.overview.longhornFaulted}</span></div>
              </div>
            </SectionCard>
            <SectionCard delay={0.3}>
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-green-400" />
                ArgoCD Sync
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">OutOfSync</span><span className={cn("font-semibold", enhanced.overview.argocdOutOfSync > 0 ? "text-orange-400" : "text-green-400")}>{enhanced.overview.argocdOutOfSync}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">cert-manager</span><span className="text-white font-semibold">{enhanced.overview.certCount} certs</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Renewal pending</span><span className={cn("font-semibold", enhanced.overview.certRenewalPending > 0 ? "text-orange-400" : "text-green-400")}>{enhanced.overview.certRenewalPending}</span></div>
              </div>
            </SectionCard>
            <SectionCard delay={0.32}>
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Network className="w-4 h-4 text-teal-400" />
                MetalLB Pool
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">IPs in use</span><span className="text-white font-semibold">{enhanced.overview.metallbPoolUsed}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Pool total</span><span className="text-white font-semibold">{enhanced.overview.metallbPoolTotal}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Utilization</span>
                  <span className={cn("font-semibold", enhanced.overview.metallbPoolUsed / (enhanced.overview.metallbPoolTotal || 1) > 0.8 ? "text-orange-400" : "text-green-400")}>
                    {enhanced.overview.metallbPoolTotal > 0 ? Math.round(enhanced.overview.metallbPoolUsed / enhanced.overview.metallbPoolTotal * 100) : 0}%
                  </span>
                </div>
              </div>
            </SectionCard>
          </div>
        )}

      </div>
    </div>
  );
}
