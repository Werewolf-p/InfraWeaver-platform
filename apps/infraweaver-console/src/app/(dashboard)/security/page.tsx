"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useCallback } from "react";
import {
  Shield, AlertTriangle, CheckCircle2, RefreshCw, Lock, Users, Loader2,
  KeyRound, Network, FileWarning, Server, Box, Activity, Database,
  ChevronDown, ChevronRight, Clock, Eye, EyeOff, Cpu,
  AlertCircle, BookOpen, Layers, GitBranch, HardDrive,
} from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { useRouter } from "next/navigation";
import { cn, timeAgo } from "@/lib/utils";

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

function CertCountdown({ daysLeft }: { daysLeft: number | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;
  if (daysLeft === null) return <span className="text-xs text-slate-500">unknown</span>;
  const color = daysLeft < 15 ? "text-red-400 bg-red-500/10" : daysLeft < 30 ? "text-orange-400 bg-orange-500/10" : "text-green-400 bg-green-500/10";
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
      className="bg-white/5 border border-white/10 rounded-xl p-5"
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

// ─── Overview Stat Cards (items 11-20) ───────────────────────────────────────

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
      className={cn("border rounded-xl p-4 flex flex-col gap-2", color)}
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
  const [showImages, setShowImages] = useState(false);

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

  // Derive pod issues from /api/pods (original logic kept)
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
  }, [refetchPods, refetchCerts, refetchRbac, refetchEnhanced, refetchAuthEvents]);

  // Sort certs by urgency
  const sortedCerts = [...(certsData?.certs ?? [])].sort((a, b) => {
    const da = a.daysLeft ?? 9999;
    const db = b.daysLeft ?? 9999;
    return da - db;
  });

  // Build overview stat cards
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

  // Group Kyverno violations by severity
  const kyvernoBySeverity = (enhanced?.kyvernoViolations ?? []).reduce<Record<string, EnhancedData["kyvernoViolations"]>>((acc, v) => {
    const sev = v.severity.toLowerCase();
    acc[sev] = [...(acc[sev] ?? []), v];
    return acc;
  }, {});

  if (!isAdmin) return null;

  return (
    <div>
      {/* Header */}
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
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 mb-6 px-4 py-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          <span className="text-sm text-indigo-300">Scanning cluster…</span>
        </motion.div>
      )}

      <div className="space-y-6">

        {/* ── Overview Grid (items 11-20) ── */}
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

        {/* ── TLS Certificate Expiry Countdown (item 1) ── */}
        <SectionCard delay={0.05}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Lock className="w-4 h-4 text-blue-400" />
            TLS Certificate Expiry
            <span className="ml-auto text-xs text-slate-500">{sortedCerts.length} certs — sorted by urgency</span>
          </h3>
          {certsLoading ? <Shimmer rows={3} /> : sortedCerts.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No TLS certificates found</p>
          ) : (
            <div className="space-y-2">
              {sortedCerts.map((cert, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-lg border",
                    cert.daysLeft !== null && cert.daysLeft < 15
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
                  </div>
                  <CertCountdown daysLeft={cert.daysLeft} />
                </motion.div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── ExternalSecret Sync Status (item 2) ── */}
        <SectionCard delay={0.08}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-yellow-400" />
            ExternalSecret Sync Status
            {enhanced && (
              <span className="ml-auto text-xs text-slate-500">
                {enhanced.externalSecrets.filter(e => e.ready).length}/{enhanced.externalSecrets.length} synced
              </span>
            )}
          </h3>
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
                    {es.lastSyncTime && (
                      <p className="text-xs text-slate-500">{timeAgo(es.lastSyncTime)}</p>
                    )}
                  </div>
                </motion.div>
              ))}
              {!enhanced?.externalSecrets?.length && !enhancedLoading && (
                <p className="text-sm text-slate-500 text-center py-4">No ExternalSecrets found</p>
              )}
            </div>
          )}
        </SectionCard>

        {/* ── Kyverno Policy Violations (item 3) ── */}
        <SectionCard delay={0.1}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-purple-400" />
            Kyverno Policy Violations
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
                          className="w-full flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/8 transition-colors text-left"
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
                              <div className="mx-1 p-3 bg-white/3 border border-white/5 border-t-0 rounded-b-lg text-xs text-slate-400 space-y-1">
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

        {/* ── Pod Security Audit (item 4, enhanced) ── */}
        <SectionCard delay={0.12}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-orange-400" />
            Pod Security Audit
            <span className="ml-auto text-xs text-slate-500">
              {(enhanced?.podSecurityIssues?.length ?? podIssues.length)} issues
            </span>
          </h3>
          {(podsLoading || enhancedLoading) ? <Shimmer rows={4} /> : (() => {
            const issues = enhanced?.podSecurityIssues ?? [];
            return issues.length === 0 && podIssues.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-2" />
                <p className="text-sm text-slate-400">No pod security issues detected</p>
              </div>
            ) : (
              <div className="space-y-2">
                {issues.map((issue, i) => (
                  <motion.div key={`enhanced-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                    className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                  >
                    <SeverityBadge severity={issue.severity} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{issue.pod}</p>
                      <p className="text-xs text-slate-500">{issue.namespace}</p>
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
                {issues.length === 0 && podIssues.map((issue, i) => (
                  <motion.div key={`basic-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
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
            );
          })()}
        </SectionCard>

        {/* ── Auth Events / Failed Login Attempts (item 5) ── */}
        <SectionCard delay={0.14}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-rose-400" />
            Recent Auth Events
            {authEvents && (
              <span className="ml-auto text-xs text-slate-500">
                source: {authEvents.source} · {authEvents.events.filter(e => !e.success).length} failed
              </span>
            )}
          </h3>
          {authEventsLoading ? <Shimmer rows={4} /> : (
            <div className="space-y-2">
              {(authEvents?.events ?? []).map((evt, i) => (
                <motion.div key={evt.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                  className={cn("flex items-center gap-3 p-3 rounded-lg border", evt.success ? "bg-white/5 border-white/5" : "bg-red-500/5 border-red-500/20")}
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
              ))}
              {!authEvents?.events?.length && (
                <p className="text-sm text-slate-500 text-center py-4">No auth events available</p>
              )}
            </div>
          )}
        </SectionCard>

        {/* ── ServiceAccount RBAC Audit (item 6) ── */}
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

        {/* ── PodDisruptionBudgets (item 7) ── */}
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
            <div className="overflow-x-auto">
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

        {/* ── Network Policy Coverage (item 8) ── */}
        <SectionCard delay={0.2}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Network className="w-4 h-4 text-teal-400" />
            Network Policy Coverage
            {enhanced && (
              <span className={cn("ml-auto text-xs font-semibold", enhanced.unprotectedNamespaces.length > 0 ? "text-orange-400" : "text-green-400")}>
                {enhanced.unprotectedNamespaces.length} unprotected
              </span>
            )}
          </h3>
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
        </SectionCard>

        {/* ── Image Vulnerability Summary (item 9) ── */}
        <SectionCard delay={0.22}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Box className="w-4 h-4 text-indigo-400" />
            Running Container Images
            <button onClick={() => setShowImages(!showImages)} className="ml-auto flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors">
              {showImages ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showImages ? "Hide" : "Show all"}
            </button>
          </h3>
          {enhancedLoading ? <Shimmer rows={3} /> : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 text-xs text-blue-300">
                <FileWarning className="w-4 h-4 flex-shrink-0" />
                <span>Trivy not available on runner. Showing image inventory. Run <code className="font-mono bg-white/10 px-1 rounded">trivy image &lt;img&gt;</code> locally for CVE details.</span>
              </div>
              <AnimatePresence>
                {showImages && (enhanced?.runningImages ?? []).map((img, i) => (
                  <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                  >
                    <Box className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                    <span className="text-xs text-slate-300 font-mono truncate">{img.image}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {!showImages && (
                <p className="text-xs text-slate-500 text-center py-2">
                  {enhanced?.runningImages?.length ?? 0} unique images — click Show all to inspect
                </p>
              )}
            </div>
          )}
        </SectionCard>

        {/* ── OpenBao Seal Status (item 10) ── */}
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
