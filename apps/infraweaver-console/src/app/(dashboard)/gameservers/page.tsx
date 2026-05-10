"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, X, ChevronRight, ChevronLeft, Gamepad2,
  Trash2, RefreshCw, Check, AlertTriangle, Copy,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const GAME_TYPES = [
  { id: "minecraft", icon: "⛏", label: "Minecraft", color: "green", defaultPorts: [{ port: 25565, protocol: "TCP" as const, name: "game" }] },
  { id: "valheim", icon: "🪓", label: "Valheim", color: "blue", defaultPorts: [{ port: 2456, protocol: "UDP" as const, name: "game" }, { port: 2457, protocol: "UDP" as const, name: "rcon" }] },
  { id: "cs2", icon: "🔫", label: "CS2", color: "orange", defaultPorts: [{ port: 27015, protocol: "TCP" as const, name: "game" }, { port: 27015, protocol: "UDP" as const, name: "game" }] },
  { id: "terraria", icon: "🌍", label: "Terraria", color: "purple", defaultPorts: [{ port: 7777, protocol: "TCP" as const, name: "game" }] },
  { id: "factorio", icon: "⚙", label: "Factorio", color: "yellow", defaultPorts: [{ port: 34197, protocol: "UDP" as const, name: "game" }] },
  { id: "rust", icon: "🏚", label: "Rust", color: "red", defaultPorts: [{ port: 28015, protocol: "TCP" as const, name: "game" }, { port: 28016, protocol: "TCP" as const, name: "rcon" }] },
  { id: "custom", icon: "🎮", label: "Custom", color: "gray", defaultPorts: [] },
];

const POOL_IPS = ["10.10.0.206", "10.10.0.207", "10.10.0.208", "10.10.0.209", "10.10.0.210"];

interface Port { port: number; protocol: "TCP" | "UDP"; name: string; }
interface GameServer {
  name: string; displayName: string; gameType: string; allocatedIP: string | null;
  ports: Port[]; backendType: string; description: string; publicDns: boolean;
  internalDns: boolean; createdAt: string | null; status: string;
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

function StatusIndicator({ status }: { status: string }) {
  if (status === "active" || status === "online") {
    return (
      <span className="flex items-center gap-1.5 text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
        Online
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="flex items-center gap-1.5 text-yellow-400">
        <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
        Pending
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-slate-500">
      <span className="w-2 h-2 rounded-full bg-slate-600" />
      Offline
    </span>
  );
}

function DnsStatus({ name, publicDns, internalDns }: { name: string; publicDns: boolean; internalDns: boolean }) {
  const { data } = useQuery({
    queryKey: ["gameserver-dns", name],
    queryFn: async () => {
      const res = await fetch(`/api/gameservers/${name}/dns`);
      return res.json() as Promise<{ public: { exists: boolean }; internal: { exists: boolean } }>;
    },
    enabled: publicDns || internalDns,
    staleTime: 60000,
  });

  return (
    <div className="flex items-center gap-1.5">
      {publicDns && (
        <span title={`${name}.rlservers.com`} className={cn(
          "text-xs px-1.5 py-0.5 rounded-sm border font-mono",
          data?.public?.exists ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-slate-500 border-slate-700 bg-slate-800"
        )}>
          {data?.public?.exists ? "✓" : "✗"} pub
        </span>
      )}
      {internalDns && (
        <span title={`${name}.int.rlservers.com`} className={cn(
          "text-xs px-1.5 py-0.5 rounded-sm border font-mono",
          data?.internal?.exists ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-slate-500 border-slate-700 bg-slate-800"
        )}>
          {data?.internal?.exists ? "✓" : "✗"} int
        </span>
      )}
      {!publicDns && !internalDns && <span className="text-slate-600 text-xs">—</span>}
    </div>
  );
}

function AddServerDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState(1);
  const [gameType, setGameType] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [ports, setPorts] = useState<Port[]>([]);
  const [backendType, setBackendType] = useState<"external" | "in-cluster">("external");
  const [backendIP, setBackendIP] = useState("");
  const [backendPort, setBackendPort] = useState<number | undefined>();
  const [allocatedIP, setAllocatedIP] = useState("");
  const [publicDns, setPublicDns] = useState(true);
  const [internalDns, setInternalDns] = useState(true);
  const [creating, setCreating] = useState(false);

  const { data: portsData } = useQuery({
    queryKey: ["gameserver-ports"],
    queryFn: async () => {
      const res = await fetch("/api/gameservers/ports");
      return res.json() as Promise<{ availableIPs: string[]; usedPorts: Array<{ ip: string; port: number; protocol: string; serverName: string }> }>;
    },
    enabled: open,
  });

  const selectedType = GAME_TYPES.find(t => t.id === gameType);

  const handleGameTypeSelect = (id: string) => {
    setGameType(id);
    const gt = GAME_TYPES.find(t => t.id === id);
    if (gt) setPorts(gt.defaultPorts.map(p => ({ ...p })));
    setStep(2);
  };

  const isPortConflict = (port: number, protocol: string) => {
    return portsData?.usedPorts?.some(p => p.port === port && p.protocol === protocol && p.ip === allocatedIP);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/gameservers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, displayName, gameType, ports, backendType, backendIP: backendIP || undefined, backendPort: backendPort || undefined, publicDns, internalDns, allocatedIP: allocatedIP || undefined, description }),
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
    setPorts([]); setBackendType("external"); setBackendIP(""); setBackendPort(undefined);
    setAllocatedIP(""); setPublicDns(true); setInternalDns(true);
  };

  const stepLabels = ["Game Type", "Details", "Ports", "Backend", "IP", "DNS", "Review"];

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-xl bg-slate-900 border-l border-white/10 z-50 flex flex-col shadow-2xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-lg font-bold text-white">Add Game Server</h2>
                <p className="text-xs text-slate-500 mt-0.5">Step {step} of 7 — {stepLabels[step - 1]}</p>
              </div>
              <button onClick={() => { onClose(); resetForm(); }} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex px-6 py-3 gap-1 border-b border-white/5">
              {stepLabels.map((_, i) => (
                <div key={i} className={cn("flex-1 h-1 rounded-full transition-all duration-300", i + 1 <= step ? "bg-indigo-500" : "bg-white/10")} />
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {step === 1 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-300 mb-4">Select game type</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {GAME_TYPES.map(gt => (
                      <button
                        key={gt.id}
                        onClick={() => handleGameTypeSelect(gt.id)}
                        className="flex flex-col items-center gap-2 p-4 rounded-xl border border-white/10 bg-white/5 hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all group"
                      >
                        <span className="text-3xl">{gt.icon}</span>
                        <span className="text-sm font-medium text-slate-300 group-hover:text-white">{gt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {step === 2 && (
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

              {step === 3 && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Configure ports for this game server. Conflicts are highlighted in red.</p>
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

              {step === 4 && (
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
                        <div className="text-xs text-slate-500">{bt === "external" ? "VM or bare metal at a different IP" : "Deploy as K8s pod (future)"}</div>
                      </button>
                    ))}
                  </div>
                  {backendType === "external" && (
                    <div className="space-y-3 p-4 rounded-xl border border-white/10 bg-white/5">
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">Backend IP</label>
                        <input
                          value={backendIP} onChange={e => setBackendIP(e.target.value)}
                          placeholder="192.168.1.50"
                          className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">Backend port</label>
                        <input
                          type="number" value={backendPort ?? ""} onChange={e => setBackendPort(parseInt(e.target.value) || undefined)}
                          placeholder={String(ports[0]?.port ?? 25565)}
                          className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {step === 5 && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Select an IP from the game-servers MetalLB pool (10.10.0.206-210)</p>
                  <div className="grid grid-cols-1 gap-2">
                    {POOL_IPS.map(ip => {
                      const available = portsData?.availableIPs?.includes(ip) ?? true;
                      return (
                        <button
                          key={ip}
                          disabled={!available}
                          onClick={() => setAllocatedIP(ip)}
                          className={cn(
                            "flex items-center justify-between p-3 rounded-lg border text-left transition-all",
                            allocatedIP === ip ? "border-indigo-500 bg-indigo-500/10" : available ? "border-white/10 bg-white/5 hover:border-white/30" : "border-white/5 opacity-50 cursor-not-allowed"
                          )}
                        >
                          <span className="font-mono text-sm text-white">{ip}</span>
                          <span className={cn("text-xs px-2 py-0.5 rounded-full border", available ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-slate-500 border-slate-700")}>
                            {available ? "Available" : "In use"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {allocatedIP && (
                    <div className="p-3 rounded-lg bg-slate-800/50 border border-white/10">
                      <p className="text-xs font-medium text-slate-400 mb-2">Router port forward config</p>
                      <div className="space-y-1">
                        {ports.map((p, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs font-mono text-slate-300">
                            <ProtocolBadge protocol={p.protocol} />
                            <span className="text-slate-500">→</span>
                            <span>{allocatedIP}:{p.port}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {step === 6 && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Configure DNS records via Cloudflare API</p>
                  <div className="space-y-3">
                    {([
                      { key: "publicDns" as const, label: "Public DNS", record: `${name}.rlservers.com`, description: "Accessible from internet (points to MetalLB IP)", value: publicDns, setter: setPublicDns },
                      { key: "internalDns" as const, label: "Internal DNS", record: `${name}.int.rlservers.com`, description: "VPN-only access, private IP", value: internalDns, setter: setInternalDns },
                    ]).map(({ key, label, record, description: desc, value, setter }) => (
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
                        {value && allocatedIP && (
                          <div className="mt-2 p-2 bg-slate-900/50 rounded-lg font-mono text-xs text-slate-400">
                            A {record} → {allocatedIP}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {step === 7 && (
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
                        <p className="text-slate-500 mb-1">IP</p>
                        <p className="font-mono text-white">{allocatedIP || "Auto-assign"}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-800/50">
                        <p className="text-slate-500 mb-1">Backend</p>
                        <p className="text-white">{backendType === "external" ? `${backendIP}` : "In-cluster"}</p>
                      </div>
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
                      <div className="flex gap-2">
                        {publicDns && <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-md px-2 py-1">✓ {name}.rlservers.com</span>}
                        {internalDns && <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md px-2 py-1">✓ {name}.int.rlservers.com</span>}
                        {!publicDns && !internalDns && <span className="text-xs text-slate-500">No DNS records</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
              <button
                onClick={() => step > 1 ? setStep(step - 1) : onClose()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-slate-400 hover:text-white transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                {step > 1 ? "Back" : "Cancel"}
              </button>
              {step < 7 ? (
                <button
                  onClick={() => setStep(step + 1)}
                  disabled={step === 2 && (!name || !displayName)}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={handleCreate} disabled={creating || !name}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</> : <><Check className="w-4 h-4" /> Create Server</>}
                </button>
              )}
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
        <p className="text-sm text-slate-400 mb-4">This will delete the K8s Service, Endpoints, ConfigMap, and DNS records for <strong className="text-white">{server.displayName}</strong>.</p>
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
            Game Servers
          </h1>
          <p className="text-sm text-slate-500 mt-1">Manage dedicated game server networking, DNS, and port allocation</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => refetch()} className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Game Server
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {POOL_IPS.map(ip => {
          const server = servers?.find(s => s.allocatedIP === ip);
          const gt = server ? gameTypeMap[server.gameType] : null;
          return (
            <div key={ip} className={cn(
              "p-3 rounded-xl border transition-all",
              server ? "border-indigo-500/30 bg-indigo-500/10" : "border-white/5 bg-white/[0.02]"
            )}>
              <p className="text-xs font-mono text-slate-400">{ip}</p>
              {server ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="text-sm">{gt?.icon ?? "🎮"}</span>
                  <span className="text-xs text-white truncate">{server.name}</span>
                </div>
              ) : (
                <p className="text-xs text-slate-600 mt-1">Available</p>
              )}
            </div>
          );
        })}
      </div>

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
            <h3 className="text-sm font-medium text-slate-400 mb-2">No game servers</h3>
            <p className="text-xs text-slate-600 mb-4">Create your first game server to get started with dedicated IP and DNS management</p>
            <button onClick={() => setDrawerOpen(true)} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm transition-colors">
              Add Game Server
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5 bg-slate-950/80 backdrop-blur-sm">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Server</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">IP</th>
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
                        <span className="font-mono text-sm text-slate-300">{server.allocatedIP ?? "—"}</span>
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
                        <DnsStatus name={server.name} publicDns={server.publicDns} internalDns={server.internalDns} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator status={server.status} />
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
            {/* Expanded detail panel rendered below table */}
            {expandedServer && (() => {
              const server = servers.find(s => s.name === expandedServer);
              if (!server) return null;
              return (
                <div className="border-t border-indigo-500/20 bg-slate-900/50 px-4 py-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Connection Info</p>
                      <div className="space-y-1">
                        {server.ports.map((p, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs font-mono">
                            <ProtocolBadge protocol={p.protocol} />
                            <span className="text-slate-300">{server.allocatedIP}:{p.port}</span>
                            <button onClick={() => { navigator.clipboard.writeText(`${server.allocatedIP}:${p.port}`); toast.success("Copied!"); }} className="text-slate-600 hover:text-white">
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">DNS Records</p>
                      <div className="space-y-1 text-xs font-mono text-slate-400">
                        {server.publicDns && <p>{server.name}.rlservers.com → {server.allocatedIP}</p>}
                        {server.internalDns && <p>{server.name}.int.rlservers.com → {server.allocatedIP}</p>}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Router Config</p>
                      <div className="space-y-1 text-xs font-mono text-slate-400">
                        {server.ports.map((p, i) => (
                          <div key={i} className="flex items-center gap-1"><ProtocolBadge protocol={p.protocol} /> {p.port} → {server.allocatedIP}:{p.port}</div>
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

      <AddServerDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ["gameservers"] })} />
      {deleteTarget && <DeleteConfirmDialog server={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => queryClient.invalidateQueries({ queryKey: ["gameservers"] })} />}
    </div>
  );
}
