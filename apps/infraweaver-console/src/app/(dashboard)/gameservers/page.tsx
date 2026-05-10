"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, X, ChevronRight, ChevronLeft, Gamepad2,
  Trash2, RefreshCw, Check, AlertTriangle, Copy,
  Loader2, Globe, Network, ChevronDown, ChevronUp, Info,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useSimpleMode } from "@/contexts/simple-mode-context";

const GAME_TYPES = [
  { id: "minecraft", icon: "⛏", label: "Minecraft", color: "green", defaultPorts: [{ port: 25565, protocol: "TCP" as const, name: "game" }] },
  { id: "valheim", icon: "🪓", label: "Valheim", color: "blue", defaultPorts: [{ port: 2456, protocol: "UDP" as const, name: "game" }, { port: 2457, protocol: "UDP" as const, name: "rcon" }] },
  { id: "cs2", icon: "🔫", label: "CS2", color: "orange", defaultPorts: [{ port: 27015, protocol: "TCP" as const, name: "game" }, { port: 27015, protocol: "UDP" as const, name: "game" }] },
  { id: "terraria", icon: "🌍", label: "Terraria", color: "purple", defaultPorts: [{ port: 7777, protocol: "TCP" as const, name: "game" }] },
  { id: "factorio", icon: "⚙", label: "Factorio", color: "yellow", defaultPorts: [{ port: 34197, protocol: "UDP" as const, name: "game" }] },
  { id: "rust", icon: "🏚", label: "Rust", color: "red", defaultPorts: [{ port: 28015, protocol: "TCP" as const, name: "game" }, { port: 28016, protocol: "TCP" as const, name: "rcon" }] },
  { id: "custom", icon: "🎮", label: "Custom", color: "gray", defaultPorts: [] },
];

interface Port { port: number; protocol: "TCP" | "UDP"; name: string; }
interface GameServer {
  name: string; displayName: string; gameType: string; targetIP: string; internalIP?: string;
  ports: Port[]; backendType: string; description: string; publicDns: boolean;
  internalDns: boolean; createdAt: string | null; serviceStatus?: string;
}

function ProtocolBadge({ protocol }: { protocol: string }) {
  return (
    <span className={cn(
      "rounded-sm px-1.5 py-0.5 text-xs font-mono font-medium",
      protocol === "TCP" ? "bg-blue-500/20 text-blue-300 border border-blue-500/30" : "bg-orange-500/20 text-orange-300 border border-orange-500/30"
    )}>
      {protocol}
    </span>
  );
}

function StatusIndicator({ server }: { server: GameServer }) {
  const { data } = useQuery({
    queryKey: ["gameserver-status", server.name],
    queryFn: async () => {
      const res = await fetch(`/api/gameservers/${server.name}/status`);
      return res.json() as Promise<{ online: boolean; latencyMs: number }>;
    },
    staleTime: 30000,
    refetchInterval: 60000,
    enabled: !!server.targetIP,
  });

  if (!server.targetIP) {
    return <span className="flex items-center gap-1.5 text-slate-500 text-xs">No IP</span>;
  }
  if (!data) {
    return <span className="flex items-center gap-1.5 text-slate-500 text-xs"><Loader2 className="w-3 h-3 animate-spin" /></span>;
  }
  if (data.online) {
    return (
      <span className="flex items-center gap-1.5 text-green-400 text-xs">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
        Online {data.latencyMs > 0 && <span className="text-green-600">{data.latencyMs}ms</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-slate-500 text-xs">
      <span className="w-2 h-2 rounded-full bg-slate-600" />
      Offline
    </span>
  );
}

function DnsStatusCell({ name, targetIP, internalIP, publicDns, internalDns }: {
  name: string; targetIP: string; internalIP?: string; publicDns: boolean; internalDns: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["gameserver-dns", name],
    queryFn: async () => {
      const res = await fetch(`/api/gameservers/${name}/dns`);
      return res.json() as Promise<{ public: { exists: boolean; ip?: string }; internal: { exists: boolean; ip?: string } }>;
    },
    enabled: publicDns || internalDns,
    staleTime: 60000,
  });

  const effectiveIntIP = internalIP || targetIP;

  return (
    <div className="space-y-1 text-xs font-mono">
      {publicDns && (
        <div className="flex items-center gap-1.5">
          <span className={data?.public?.exists ? "text-green-400" : "text-slate-600"}>
            {data?.public?.exists ? "✓" : "✗"}
          </span>
          <span className="text-slate-400">{name}.rlservers.com</span>
          <span className="text-slate-600">→ {targetIP}</span>
        </div>
      )}
      {internalDns && (
        <div className="flex items-center gap-1.5">
          <span className={data?.internal?.exists ? "text-green-400" : "text-slate-600"}>
            {data?.internal?.exists ? "✓" : "✗"}
          </span>
          <span className="text-slate-400">{name}.int.rlservers.com</span>
          <span className="text-slate-600">→ {effectiveIntIP}</span>
        </div>
      )}
      {!publicDns && !internalDns && <span className="text-slate-600">—</span>}
    </div>
  );
}

function HowItWorksPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-blue-500/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-blue-300">How DNS Routing Works</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-blue-400" /> : <ChevronDown className="w-4 h-4 text-blue-400" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4">
              <p className="text-sm text-slate-300">
                <strong className="text-white">DNS Routing</strong> — each game server gets its own hostname pointing to its own public IP. 
                Two servers can use the same port (e.g. 25565) because <code className="text-blue-300">mc1.rlservers.com</code> and <code className="text-blue-300">mc2.rlservers.com</code> resolve to different IPs.
                Your router forwards traffic based on the destination IP.
              </p>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-400 flex-wrap">
                <span className="px-2 py-1 bg-slate-800 rounded border border-white/10">Players</span>
                <span className="text-slate-600">→</span>
                <span className="px-2 py-1 bg-indigo-900/40 rounded border border-indigo-500/30 text-indigo-300">DNS lookup</span>
                <span className="text-slate-600">→</span>
                <span className="px-2 py-1 bg-slate-800 rounded border border-white/10">Your Public IP</span>
                <span className="text-slate-600">→</span>
                <span className="px-2 py-1 bg-slate-800 rounded border border-white/10">Router</span>
                <span className="text-slate-600">→</span>
                <span className="px-2 py-1 bg-green-900/40 rounded border border-green-500/30 text-green-300">Game Server</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-800/50 border border-white/5">
                  <p className="font-semibold text-white mb-1">mc1.rlservers.com :25565</p>
                  <p className="text-slate-500">→ DNS: 1.2.3.4</p>
                  <p className="text-slate-500">→ Router forwards to MC server 1</p>
                </div>
                <div className="p-3 rounded-lg bg-slate-800/50 border border-white/5">
                  <p className="font-semibold text-white mb-1">mc2.rlservers.com :25565</p>
                  <p className="text-slate-500">→ DNS: 5.6.7.8</p>
                  <p className="text-slate-500">→ Router forwards to MC server 2</p>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                ✅ No MetalLB required for external servers. Just set the Target IP to whatever public IP your router/ISP assigns for that server.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RouterConfigTable({ servers }: { servers: GameServer[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"json" | "text" | null>(null);

  const rows = servers.flatMap(s =>
    s.ports.map(p => ({
      hostname: `${s.name}.rlservers.com`,
      protocol: p.protocol,
      externalIP: s.targetIP,
      extPort: p.port,
      internalTarget: s.internalIP ? `${s.internalIP}:${p.port}` : `${s.targetIP}:${p.port}`,
    }))
  );

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setCopied("json"); setTimeout(() => setCopied(null), 2000);
    toast.success("Copied as JSON");
  };
  const copyText = () => {
    const txt = rows.map(r => `${r.hostname}\t${r.protocol}\t${r.externalIP}\t${r.extPort}\t${r.internalTarget}`).join("\n");
    navigator.clipboard.writeText(txt);
    setCopied("text"); setTimeout(() => setCopied(null), 2000);
    toast.success("Copied as text");
  };

  if (servers.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-300">Router Port-Forward Rules</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/5 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-950/50">
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase tracking-wider">Hostname</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase tracking-wider">Protocol</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase tracking-wider">External IP</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase tracking-wider">Ext. Port</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase tracking-wider">Internal IP:Port</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                      <td className="px-4 py-2 font-mono text-slate-300">{row.hostname}</td>
                      <td className="px-4 py-2"><ProtocolBadge protocol={row.protocol} /></td>
                      <td className="px-4 py-2 font-mono text-slate-300">{row.externalIP}</td>
                      <td className="px-4 py-2 font-mono text-white">{row.extPort}</td>
                      <td className="px-4 py-2 font-mono text-slate-400">{row.internalTarget}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-2 px-4 py-3 border-t border-white/5">
                <button
                  onClick={copyJson}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
                >
                  <Copy className="w-3 h-3" /> {copied === "json" ? "Copied!" : "Copy as JSON"}
                </button>
                <button
                  onClick={copyText}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
                >
                  <Copy className="w-3 h-3" /> {copied === "text" ? "Copied!" : "Copy as text"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AddServerDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { simpleMode, toggle: toggleSimpleMode } = useSimpleMode();
  const [step, setStep] = useState(1);
  const [gameType, setGameType] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [ports, setPorts] = useState<Port[]>([]);
  const [backendType, setBackendType] = useState<"external" | "in-cluster">("external");
  const [targetIP, setTargetIP] = useState("");
  const [internalIP, setInternalIP] = useState("");
  const [publicDns, setPublicDns] = useState(true);
  const [internalDns, setInternalDns] = useState(true);
  const [creating, setCreating] = useState(false);
  const [detectingIP, setDetectingIP] = useState(false);

  const { data: portsData } = useQuery({
    queryKey: ["gameserver-ports"],
    queryFn: async () => {
      const res = await fetch("/api/gameservers/ports");
      return res.json() as Promise<{ servers: Array<{ name: string; targetIP: string; ports: Port[] }>; conflicts: Array<{ ip: string; port: number; protocol: string; servers: string[] }> }>;
    },
    enabled: open,
  });

  const selectedType = GAME_TYPES.find(t => t.id === gameType);

  const handleGameTypeSelect = (id: string) => {
    setGameType(id);
    const gt = GAME_TYPES.find(t => t.id === id);
    if (gt) setPorts(gt.defaultPorts.map(p => ({ ...p })));
    // Don't auto-advance — let the user press Next so they see the button
  };

  const isPortConflict = (port: number, protocol: string) =>
    portsData?.conflicts?.some(c => c.ip === targetIP && c.port === port && c.protocol === protocol) ?? false;

  const detectMyIP = async () => {
    setDetectingIP(true);
    try {
      const res = await fetch("/api/gameservers/detect-ip");
      const { ip } = await res.json() as { ip: string };
      if (ip) { setTargetIP(ip); toast.success(`Detected IP: ${ip}`); }
    } catch {
      toast.error("Failed to detect IP");
    } finally {
      setDetectingIP(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    // In simple mode, apply defaults
    const finalPorts = ports.length > 0 ? ports : (selectedType?.defaultPorts ?? []);
    const finalBackendType = simpleMode ? "external" : backendType;
    const finalPublicDns = simpleMode ? true : publicDns;
    const finalInternalDns = simpleMode ? true : internalDns;
    try {
      const res = await fetch("/api/gameservers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, displayName, gameType, targetIP,
          internalIP: internalIP || undefined,
          ports: finalPorts,
          backendType: finalBackendType,
          publicDns: finalPublicDns,
          internalDns: finalInternalDns,
          description,
        }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast.success(`Game server "${displayName}" created!`);
      onCreated();
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setStep(1); setGameType(""); setName(""); setDisplayName(""); setDescription("");
    setPorts([]); setBackendType("external"); setTargetIP(""); setInternalIP("");
    setPublicDns(true); setInternalDns(true);
  };

  const stepLabels = ["Protocol", "Details", "Ports", "Backend", "Routing", "DNS", "Review"];
  const simpleStepLabels = ["Protocol", "Quick Setup", "Create"];
  const activeStepLabels = simpleMode ? simpleStepLabels : stepLabels;
  const totalSteps = activeStepLabels.length;
  const effectiveIntIP = internalIP || targetIP;

  const handleModeToggle = () => {
    toggleSimpleMode();
    setStep(1);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 w-full max-w-xl bg-slate-900 border-l border-white/10 z-[101] flex flex-col shadow-2xl"
            style={{ height: "100dvh" }}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-lg font-bold text-white">Add Port Route</h2>
                <p className="text-xs text-slate-500 mt-0.5">Step {step} of {totalSteps} — {activeStepLabels[step - 1]}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleModeToggle}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                    simpleMode
                      ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300"
                      : "bg-white/5 border-white/10 text-slate-400 hover:text-white"
                  )}
                >
                  <Zap className="w-3 h-3" />
                  {simpleMode ? "Simple" : "Advanced"}
                </button>
                <button onClick={() => { onClose(); resetForm(); }} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex px-6 py-3 gap-1 border-b border-white/5">
              {activeStepLabels.map((_, i) => (
                <div key={i} className={cn("flex-1 h-1 rounded-full transition-all duration-300", i + 1 <= step ? "bg-indigo-500" : "bg-white/10")} />
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {/* Step 1 — same for both modes */}
              {step === 1 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-300 mb-1">Select protocol / server type</h3>
                  <p className="text-xs text-slate-500 mb-4">Tap a card to select it, then press Next ↓</p>
                  <div className="grid grid-cols-2 gap-3">
                    {GAME_TYPES.filter(gt => gt.id !== "custom").map(gt => (
                      <button
                        key={gt.id}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleGameTypeSelect(gt.id); }}
                        className={cn(
                          "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all cursor-pointer touch-manipulation select-none",
                          gameType === gt.id
                            ? "border-indigo-500 bg-indigo-500/20 ring-2 ring-indigo-500/60 shadow-lg shadow-indigo-500/10"
                            : "border-white/10 bg-white/5 active:border-indigo-500/50 active:bg-indigo-500/10"
                        )}
                      >
                        <span className="text-3xl">{gt.icon}</span>
                        <span className={cn("text-sm font-medium", gameType === gt.id ? "text-indigo-300" : "text-slate-300")}>{gt.label}</span>
                        {gameType === gt.id && (
                          <span className="flex items-center gap-1 text-[10px] text-indigo-400 font-semibold">
                            <Check className="w-3 h-3" /> Selected
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {/* Custom — full width so it's never cut off */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleGameTypeSelect("custom"); }}
                    className={cn(
                      "mt-3 w-full flex items-center justify-center gap-3 p-4 rounded-xl border transition-all cursor-pointer touch-manipulation select-none",
                      gameType === "custom"
                        ? "border-indigo-500 bg-indigo-500/20 ring-2 ring-indigo-500/60 shadow-lg shadow-indigo-500/10"
                        : "border-white/10 bg-white/5 active:border-indigo-500/50 active:bg-indigo-500/10"
                    )}
                  >
                    <span className="text-2xl">🎮</span>
                    <span className={cn("text-sm font-medium", gameType === "custom" ? "text-indigo-300" : "text-slate-300")}>Custom — I'll enter ports manually</span>
                    {gameType === "custom" && <Check className="w-4 h-4 text-indigo-400 ml-auto" />}
                  </button>
                </div>
              )}

              {/* Simple mode — Step 2: Quick Setup */}
              {simpleMode && step === 2 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                    <Zap className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                    <p className="text-xs text-indigo-300">Quick Setup — defaults will be applied for ports, backend, and DNS</p>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                    <span className="text-2xl">{selectedType?.icon}</span>
                    <span className="text-sm font-medium text-white">{selectedType?.label}</span>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Server name <span className="text-slate-600">(subdomain)</span></label>
                    <input
                      value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      placeholder="mc1"
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    {name && <p className="text-xs text-slate-500 mt-1">→ {name}.rlservers.com</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Display name</label>
                    <input
                      value={displayName} onChange={e => setDisplayName(e.target.value)}
                      placeholder="Minecraft — Survival"
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Target IP <span className="text-red-400">*</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={targetIP} onChange={e => setTargetIP(e.target.value)}
                        placeholder="1.2.3.4"
                        className="flex-1 bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        onClick={detectMyIP} disabled={detectingIP}
                        className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-slate-400 hover:text-white hover:bg-white/10 transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {detectingIP ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Detect my IP"}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Description <span className="text-slate-600">(optional)</span></label>
                    <textarea
                      value={description} onChange={e => setDescription(e.target.value)}
                      placeholder="A survival Minecraft server..."
                      rows={2}
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
                    />
                  </div>
                </div>
              )}

              {/* Simple mode — Step 3: Review + Create */}
              {simpleMode && step === 3 && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{selectedType?.icon}</span>
                      <div>
                        <p className="text-sm font-bold text-white">{displayName}</p>
                        <p className="text-xs text-slate-500 font-mono">{name}.rlservers.com</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 rounded-lg bg-slate-800/50">
                        <p className="text-slate-500 mb-1">Target IP</p>
                        <p className="font-mono text-white">{targetIP || "—"}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-800/50">
                        <p className="text-slate-500 mb-1">Backend</p>
                        <p className="text-white">External</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-1.5">Ports <span className="text-indigo-400">(game defaults)</span></p>
                      <div className="flex flex-wrap gap-1.5">
                        {ports.map((p, i) => (
                          <span key={i} className="flex items-center gap-1 text-xs bg-slate-800 rounded-md px-2 py-1 font-mono text-slate-300">
                            <ProtocolBadge protocol={p.protocol} /> {p.port}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-1.5">DNS Records <span className="text-indigo-400">(default: both enabled)</span></p>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-mono text-green-400 bg-green-500/10 border border-green-500/20 rounded-md px-2 py-1">✓ {name}.rlservers.com → {targetIP}</span>
                        <span className="text-xs font-mono text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md px-2 py-1">✓ {name}.int.rlservers.com → {targetIP}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {/* Advanced mode — Step 2: Details */}
              {!simpleMode && step === 2 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                    <span className="text-2xl">{selectedType?.icon}</span>
                    <span className="text-sm font-medium text-white">{selectedType?.label}</span>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Server name <span className="text-slate-600">(subdomain)</span></label>
                    <input
                      value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      placeholder="mc1"
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    {name && <p className="text-xs text-slate-500 mt-1">→ {name}.rlservers.com</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Display name</label>
                    <input
                      value={displayName} onChange={e => setDisplayName(e.target.value)}
                      placeholder="Minecraft — Survival"
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Description <span className="text-slate-600">(optional)</span></label>
                    <textarea
                      value={description} onChange={e => setDescription(e.target.value)}
                      placeholder="A survival Minecraft server..."
                      rows={2}
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
                    />
                  </div>
                </div>
              )}

              {!simpleMode && step === 3 && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Configure ports for this game server.</p>
                  <div className="space-y-2">
                    {ports.map((p, i) => {
                      const conflict = isPortConflict(p.port, p.protocol);
                      return (
                        <div key={i} className={cn(
                          "flex items-center gap-2 p-3 rounded-lg border transition-colors",
                          conflict ? "border-red-500/50 bg-red-500/10" : "border-white/10 bg-white/5"
                        )}>
                          <input
                            type="number" value={p.port}
                            onChange={e => setPorts(ports.map((pp, ii) => ii === i ? { ...pp, port: parseInt(e.target.value) || 0 } : pp))}
                            className="w-24 bg-transparent text-white font-mono text-sm focus:outline-none"
                          />
                          <select
                            value={p.protocol}
                            onChange={e => setPorts(ports.map((pp, ii) => ii === i ? { ...pp, protocol: e.target.value as "TCP" | "UDP" } : pp))}
                            className="bg-slate-800 border border-white/10 rounded text-xs text-white px-2 py-1"
                          >
                            <option>TCP</option><option>UDP</option>
                          </select>
                          <input
                            value={p.name} onChange={e => setPorts(ports.map((pp, ii) => ii === i ? { ...pp, name: e.target.value } : pp))}
                            placeholder="name"
                            className="flex-1 bg-transparent text-slate-400 text-xs font-mono focus:outline-none"
                          />
                          {conflict && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                          <button onClick={() => setPorts(ports.filter((_, ii) => ii !== i))} className="text-slate-600 hover:text-red-400 transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setPorts([...ports, { port: 0, protocol: "TCP", name: "" }])}
                    className="w-full py-2 rounded-lg border border-dashed border-white/20 text-slate-500 hover:text-white hover:border-indigo-500/50 text-sm transition-colors"
                  >
                    + Add port
                  </button>
                </div>
              )}

              {!simpleMode && step === 4 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    {(["external", "in-cluster"] as const).map(bt => (
                      <button
                        key={bt}
                        onClick={() => setBackendType(bt)}
                        className={cn(
                          "p-4 rounded-xl border text-left transition-all",
                          backendType === bt ? "border-indigo-500 bg-indigo-500/10 text-white" : "border-white/10 bg-white/5 text-slate-400 hover:border-white/30"
                        )}
                      >
                        <div className="text-sm font-medium mb-1">{bt === "external" ? "External Server" : "In-Cluster Pod"}</div>
                        <div className="text-xs text-slate-500">{bt === "external" ? "VM, bare metal, or any external host" : "Deploy as K8s pod with MetalLB"}</div>
                      </button>
                    ))}
                  </div>
                  {backendType === "in-cluster" && (
                    <div className="p-3 rounded-lg bg-indigo-900/20 border border-indigo-500/20 text-xs text-indigo-300">
                      In-cluster servers create a K8s Service with MetalLB. The Target IP you set will be the LoadBalancer IP.
                    </div>
                  )}
                  {backendType === "external" && (
                    <div className="p-3 rounded-lg bg-slate-800/50 border border-white/5 text-xs text-slate-400">
                      External servers only create a ConfigMap and DNS records. No K8s Service is created.
                    </div>
                  )}
                </div>
              )}

              {!simpleMode && step === 5 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <Globe className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    <p className="text-xs text-blue-300">DNS Routing Configuration — set the IP that {name || "this server"}.rlservers.com will resolve to.</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Target IP <span className="text-slate-600">(for DNS A record)</span> <span className="text-red-400">*</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={targetIP} onChange={e => setTargetIP(e.target.value)}
                        placeholder="1.2.3.4"
                        className="flex-1 bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        onClick={detectMyIP} disabled={detectingIP}
                        className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-slate-400 hover:text-white hover:bg-white/10 transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {detectingIP ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Detect my IP"}
                      </button>
                    </div>
                    {name && targetIP && (
                      <p className="text-xs text-slate-500 mt-1 font-mono">{name}.rlservers.com → {targetIP}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Internal IP <span className="text-slate-600">(optional — for .int. record)</span>
                    </label>
                    <input
                      value={internalIP} onChange={e => setInternalIP(e.target.value)}
                      placeholder="192.168.1.50"
                      className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <p className="text-xs text-slate-600 mt-1">Leave blank to use Target IP for both records.</p>
                  </div>

                  {targetIP && (
                    <div className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3">
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">DNS Preview</p>
                      <div className="space-y-2 text-xs font-mono">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                          <span className="text-slate-300">{name || "<name>"}.rlservers.com</span>
                          <span className="text-slate-600">→</span>
                          <span className="text-green-300">{targetIP}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-500" />
                          <span className="text-slate-300">{name || "<name>"}.int.rlservers.com</span>
                          <span className="text-slate-600">→</span>
                          <span className="text-blue-300">{effectiveIntIP}</span>
                        </div>
                      </div>
                      <div className="pt-2 border-t border-white/5">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Routing Flow</p>
                        <div className="flex items-center gap-1.5 flex-wrap text-xs text-slate-500 font-mono">
                          <span>Player</span>
                          <span>→</span>
                          <span className="text-indigo-300">{name || "<name>"}.rlservers.com</span>
                          <span>→ DNS →</span>
                          <span className="text-green-300">{targetIP}</span>
                          <span>→ Router →</span>
                          <span>Game Server</span>
                          {ports[0] && <><span>:</span><span className="text-white">{ports[0].port}</span></>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!simpleMode && step === 6 && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Configure DNS records via Cloudflare API</p>
                  <div className="space-y-3">
                    {([
                      { key: "publicDns" as const, label: "Public DNS", record: `${name}.rlservers.com`, ip: targetIP, description: `Points to ${targetIP || "target IP"}`, value: publicDns, setter: setPublicDns },
                      { key: "internalDns" as const, label: "Internal DNS", record: `${name}.int.rlservers.com`, ip: effectiveIntIP, description: `Points to ${effectiveIntIP || "internal IP (or target IP)"}`, value: internalDns, setter: setInternalDns },
                    ]).map(({ key, label, record, ip, description: desc, value, setter }) => (
                      <div key={key} className="p-4 rounded-xl border border-white/10 bg-white/5">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <p className="text-sm font-medium text-white">{label}</p>
                            <p className="text-xs text-slate-500">{desc}</p>
                          </div>
                          <button
                            onClick={() => setter(!value)}
                            className={cn(
                              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                              value ? "bg-indigo-500" : "bg-slate-700"
                            )}
                          >
                            <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform", value ? "translate-x-6" : "translate-x-1")} />
                          </button>
                        </div>
                        {value && ip && (
                          <div className="mt-2 p-2 bg-slate-900/50 rounded-lg font-mono text-xs text-slate-400">
                            A {record} → {ip}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!simpleMode && step === 7 && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{selectedType?.icon}</span>
                      <div>
                        <p className="text-sm font-bold text-white">{displayName}</p>
                        <p className="text-xs text-slate-500 font-mono">{name}.rlservers.com</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 rounded-lg bg-slate-800/50">
                        <p className="text-slate-500 mb-1">Target IP</p>
                        <p className="font-mono text-white">{targetIP || "—"}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-800/50">
                        <p className="text-slate-500 mb-1">Backend</p>
                        <p className="text-white">{backendType === "external" ? "External" : "In-cluster"}</p>
                      </div>
                      {internalIP && (
                        <div className="p-2 rounded-lg bg-slate-800/50 col-span-2">
                          <p className="text-slate-500 mb-1">Internal IP</p>
                          <p className="font-mono text-white">{internalIP}</p>
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-1.5">Ports</p>
                      <div className="flex flex-wrap gap-1.5">
                        {ports.map((p, i) => (
                          <span key={i} className="flex items-center gap-1 text-xs bg-slate-800 rounded-md px-2 py-1 font-mono text-slate-300">
                            <ProtocolBadge protocol={p.protocol} /> {p.port}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-1.5">DNS Records</p>
                      <div className="flex flex-col gap-1.5">
                        {publicDns && <span className="text-xs font-mono text-green-400 bg-green-500/10 border border-green-500/20 rounded-md px-2 py-1">✓ {name}.rlservers.com → {targetIP}</span>}
                        {internalDns && <span className="text-xs font-mono text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md px-2 py-1">✓ {name}.int.rlservers.com → {effectiveIntIP}</span>}
                        {!publicDns && !internalDns && <span className="text-xs text-slate-500">No DNS records</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col items-end gap-1 border-t border-white/10 px-6 pt-4 pb-4" style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px) + 16px, 16px)" }}>
              {/* Hint text for disabled Next */}
              {((step === 1 && !gameType) || (!simpleMode && step === 2 && (!name || !displayName)) || (simpleMode && step === 2 && (!name || !targetIP)) || (!simpleMode && step === 5 && !targetIP)) && (
                <p className="text-[11px] text-amber-500/80 text-right">
                  {step === 1 && "Select a protocol type above to continue"}
                  {!simpleMode && step === 2 && (!name ? "Enter a server name to continue" : "Enter a display name to continue")}
                  {simpleMode && step === 2 && (!name ? "Enter a server name to continue" : "Enter a target IP to continue")}
                  {!simpleMode && step === 5 && "Enter a target IP address to continue"}
                </p>
              )}
              <div className="flex items-center justify-between w-full">
              <button
                type="button"
                onClick={() => step > 1 ? setStep(step - 1) : onClose()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-slate-400 hover:text-white transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                {step > 1 ? "Back" : "Cancel"}
              </button>
              {step < totalSteps ? (
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  disabled={
                    (step === 1 && !gameType) ||
                    (!simpleMode && step === 2 && (!name || !displayName)) ||
                    (simpleMode && step === 2 && (!name || !targetIP)) ||
                    (!simpleMode && step === 5 && !targetIP)
                  }
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCreate} disabled={creating || !name || !targetIP}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</> : <><Check className="w-4 h-4" /> Create Route</>}
                </button>
              )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function DeleteConfirmDialog({ server, onClose, onDeleted }: { server: GameServer; onClose: () => void; onDeleted: () => void }) {
  const [input, setInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (input !== server.name) return;
    setDeleting(true);
    try {
      await fetch(`/api/gameservers/${server.name}`, { method: "DELETE" });
      toast.success(`Game server "${server.displayName}" deleted`);
      onDeleted();
      onClose();
    } catch {
      toast.error("Failed to delete server");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-slate-900 border border-red-500/30 rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <h3 className="text-lg font-bold text-white mb-2">Delete Game Server</h3>
        <p className="text-sm text-slate-400 mb-4">This will delete the ConfigMap, K8s Service (if in-cluster), and DNS records for <strong className="text-white">{server.displayName}</strong>.</p>
        <p className="text-xs text-slate-500 mb-2">Type <strong className="font-mono text-white">{server.name}</strong> to confirm</p>
        <input
          value={input} onChange={e => setInput(e.target.value)}
          className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-red-500 mb-4"
        />
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-white/10 text-slate-400 hover:text-white text-sm transition-colors">Cancel</button>
          <button
            onClick={handleDelete} disabled={input !== server.name || deleting}
            className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete Server"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export default function GameServersPage() {
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GameServer | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  const { data: servers, isLoading, refetch } = useQuery({
    queryKey: ["gameservers"],
    queryFn: async () => {
      const res = await fetch("/api/gameservers");
      if (!res.ok) throw new Error("Failed to fetch game servers");
      return res.json() as Promise<GameServer[]>;
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const gameTypeMap = Object.fromEntries(GAME_TYPES.map(t => [t.id, t]));

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-4 duration-300 p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            Port Routing
          </h1>
          <p className="text-sm text-slate-500 mt-1">Route traffic to any server via DNS — same port, different IPs</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => refetch()} className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Route
          </button>
        </div>
      </div>

      <HowItWorksPanel />

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <h2 className="text-sm font-semibold text-white">Servers</h2>
          <span className="text-xs text-slate-500">{servers?.length ?? 0} total</span>
        </div>

        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-500">Loading game servers...</p>
          </div>
        ) : !servers?.length ? (
          <div className="p-12 text-center">
            <Gamepad2 className="w-12 h-12 text-slate-700 mx-auto mb-4" />
            <h3 className="text-sm font-medium text-slate-400 mb-2">No routes configured</h3>
            <p className="text-xs text-slate-600 mb-4">Add your first port route to start DNS-based traffic routing</p>
            <button onClick={() => setDrawerOpen(true)} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm transition-colors">
              Add Route
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5 bg-slate-950/80 backdrop-blur-sm">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Server</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Routing</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Ports</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">DNS</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {servers.map((server, idx) => {
                  const gt = gameTypeMap[server.gameType];
                  const isExpanded = expandedServer === server.name;
                  return (
                    <tr
                      key={server.name}
                      onClick={() => setExpandedServer(isExpanded ? null : server.name)}
                      className={cn(
                        "border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors",
                        idx % 2 === 0 ? "bg-transparent" : "bg-white/[0.02]",
                        isExpanded ? "border-indigo-500/30" : ""
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="text-xl">{gt?.icon ?? "🎮"}</span>
                          <div>
                            <p className="text-sm font-medium text-white">{server.displayName}</p>
                            <p className="text-xs text-slate-500 font-mono">{server.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-0.5 text-xs font-mono">
                          <div className="text-slate-300">{server.name}.rlservers.com</div>
                          <div className="text-slate-600">→ {server.targetIP || "—"}</div>
                          {server.internalIP && (
                            <>
                              <div className="text-slate-400">{server.name}.int.rlservers.com</div>
                              <div className="text-slate-600">→ {server.internalIP}</div>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {server.ports.map((p, i) => (
                            <span key={i} className="flex items-center gap-1 text-xs font-mono text-slate-400">
                              <ProtocolBadge protocol={p.protocol} /> {p.port}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <DnsStatusCell
                          name={server.name}
                          targetIP={server.targetIP}
                          internalIP={server.internalIP}
                          publicDns={server.publicDns}
                          internalDns={server.internalDns}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator server={server} />
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {server.createdAt ? new Date(server.createdAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteTarget(server); }}
                          className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* Expanded detail panel */}
            {expandedServer && (() => {
              const server = servers.find(s => s.name === expandedServer);
              if (!server) return null;
              const effectiveIntIP = server.internalIP || server.targetIP;
              return (
                <div className="border-t border-indigo-500/20 bg-slate-900/50 px-4 py-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Connection Info</p>
                      <div className="space-y-1">
                        {server.ports.map((p, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs font-mono">
                            <ProtocolBadge protocol={p.protocol} />
                            <span className="text-slate-300">{server.targetIP}:{p.port}</span>
                            <button onClick={() => { navigator.clipboard.writeText(`${server.targetIP}:${p.port}`); toast.success("Copied!"); }} className="text-slate-600 hover:text-white">
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">DNS Records</p>
                      <div className="space-y-1 text-xs font-mono text-slate-400">
                        {server.publicDns && <p>{server.name}.rlservers.com → {server.targetIP}</p>}
                        {server.internalDns && <p>{server.name}.int.rlservers.com → {effectiveIntIP}</p>}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Router Config</p>
                      <div className="space-y-1 text-xs font-mono text-slate-400">
                        {server.ports.map((p, i) => (
                          <div key={i} className="flex items-center gap-1"><ProtocolBadge protocol={p.protocol} /> {p.port} → {effectiveIntIP}:{p.port}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      <RouterConfigTable servers={servers ?? []} />

      <AddServerDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ["gameservers"] })} />
      {deleteTarget && <DeleteConfirmDialog server={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => queryClient.invalidateQueries({ queryKey: ["gameservers"] })} />}
    </div>
  );
}
