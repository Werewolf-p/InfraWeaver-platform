"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Check, Loader2, Gamepad2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";

const GAMES = [
  {
    id: "minecraft",
    name: "Minecraft Java",
    icon: "⛏",
    description: "Paper Minecraft server with plugin support",
    defaultPort: 25565,
    envFields: [
      { key: "VERSION", label: "Version", default: "LATEST", placeholder: "LATEST or 1.21.1" },
      { key: "MAX_PLAYERS", label: "Max Players", default: "20", placeholder: "20" },
      { key: "SERVER_NAME", label: "Server Name", default: "My Minecraft Server", placeholder: "Server name" },
      { key: "MOTD", label: "MOTD", default: "A Minecraft Server", placeholder: "Message of the day" },
    ],
  },
  {
    id: "terraria",
    name: "Terraria",
    icon: "🌍",
    description: "tShock Terraria server",
    defaultPort: 7777,
    envFields: [
      { key: "WORLD", label: "World Name", default: "World1", placeholder: "World1" },
      { key: "MAXPLAYERS", label: "Max Players", default: "20", placeholder: "20" },
      { key: "PASSWORD", label: "Password", default: "", placeholder: "Leave empty for no password" },
      { key: "AUTOCREATE", label: "World Size (1=Small, 2=Med, 3=Large)", default: "2", placeholder: "2" },
    ],
  },
  {
    id: "valheim",
    name: "Valheim",
    icon: "🪓",
    description: "Valheim server with BepInEx mod support",
    defaultPort: 2456,
    envFields: [
      { key: "SERVER_NAME", label: "Server Name", default: "My Valheim Server", placeholder: "Server name" },
      { key: "WORLD_NAME", label: "World Name", default: "MyWorld", placeholder: "MyWorld" },
      { key: "SERVER_PASS", label: "Password (min 5 chars)", default: "changeme", placeholder: "changeme" },
      { key: "SERVER_PUBLIC", label: "Public (true/false)", default: "false", placeholder: "false" },
    ],
  },
];

type StepId = "choose" | "configure" | "preview" | "deploy";
const STEPS: StepId[] = ["choose", "configure", "preview", "deploy"];
const STEP_LABELS = ["Choose Game", "Configure", "Review", "Deploy"];

export default function NewGameServerPage() {
  const router = useRouter();
  const [step, setStep] = useState<StepId>("choose");
  const [selectedGame, setSelectedGame] = useState<typeof GAMES[0] | null>(null);
  const [serverName, setServerName] = useState("");
  const [memory, setMemory] = useState("2Gi");
  const [cpu, setCpu] = useState("1");
  const [storage, setStorage] = useState("10Gi");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  function buildYamlPreview() {
    if (!selectedGame) return "";
    const slug = serverName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const env = { ...Object.fromEntries(selectedGame.envFields.map(f => [f.key, envValues[f.key] ?? f.default])) };
    const envLines = Object.entries(env).map(([k, v]) => `    - name: ${k}\n      value: "${v}"`).join("\n");
    return `# ${selectedGame.name} Server: ${slug}
# Namespace: game-hub
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${slug}
  namespace: game-hub
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${slug}
  template:
    spec:
      containers:
        - name: ${selectedGame.id}
          image: ${selectedGame.id === "minecraft" ? "itzg/minecraft-server:latest" : selectedGame.id === "terraria" ? "ryshe/terraria:latest" : "lloesche/valheim-server:latest"}
          ports:
            - containerPort: ${selectedGame.defaultPort}
          env:
${envLines}
          resources:
            limits:
              memory: ${memory}
              cpu: "${cpu}"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${slug}-data
  namespace: game-hub
spec:
  storageClassName: longhorn
  resources:
    requests:
      storage: ${storage}`;
  }

  async function deploy() {
    if (!selectedGame) return;
    setDeploying(true);
    try {
      const slug = serverName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      const env = Object.fromEntries(selectedGame.envFields.map(f => [f.key, envValues[f.key] ?? f.default]));
      const res = await fetch("/api/game-hub/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game: selectedGame.id, name: slug, memory, cpu, storage, env }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error);
      }
      setDeployed(true);
      toast.success(`${serverName} deployed successfully!`);
      setTimeout(() => router.push("/game-hub"), 2000);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title="New Game Server" subtitle="Deploy a game server on Kubernetes" icon={Gamepad2} />

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0",
              i < stepIndex ? "bg-green-500 text-white" : i === stepIndex ? "bg-[#0078D4] text-white" : "bg-[#252525] text-[#666]"
            )}>
              {i < stepIndex ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </div>
            <span className={cn("text-xs hidden sm:block", i === stepIndex ? "text-[#f2f2f2]" : "text-[#666]")}>{STEP_LABELS[i]}</span>
            {i < STEPS.length - 1 && <div className={cn("flex-1 h-px", i < stepIndex ? "bg-green-500/50" : "bg-[#2a2a2a]")} />}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-6">
        <AnimatePresence mode="wait">
          {step === "choose" && (
            <motion.div key="choose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
              <h2 className="text-sm font-medium text-[#f2f2f2]">Choose your game</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {GAMES.map(game => (
                  <button
                    key={game.id}
                    onClick={() => { setSelectedGame(game); setEnvValues({}); }}
                    className={cn(
                      "rounded-xl border p-4 text-left transition-colors",
                      selectedGame?.id === game.id
                        ? "border-[#0078D4] bg-[rgba(0,120,212,0.1)]"
                        : "border-[#2a2a2a] bg-[#252525] hover:border-[#333]"
                    )}
                  >
                    <div className="text-3xl mb-2">{game.icon}</div>
                    <p className="font-medium text-sm text-[#f2f2f2]">{game.name}</p>
                    <p className="text-xs text-[#666] mt-1">{game.description}</p>
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {step === "configure" && selectedGame && (
            <motion.div key="configure" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
              <h2 className="text-sm font-medium text-[#f2f2f2]">Configure {selectedGame.name}</h2>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[#9e9e9e] mb-1 block">Server Name *</label>
                  <input
                    type="text"
                    value={serverName}
                    onChange={e => setServerName(e.target.value)}
                    placeholder="my-minecraft-server"
                    className="w-full bg-[#252525] border border-[#333] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]"
                  />
                  <p className="text-xs text-[#555] mt-1">Lowercase letters, numbers, hyphens only</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-[#9e9e9e] mb-1 block">Memory Limit</label>
                    <select value={memory} onChange={e => setMemory(e.target.value)} className="w-full bg-[#252525] border border-[#333] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]">
                      <option>1Gi</option><option>2Gi</option><option>4Gi</option><option>8Gi</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#9e9e9e] mb-1 block">CPU Limit</label>
                    <select value={cpu} onChange={e => setCpu(e.target.value)} className="w-full bg-[#252525] border border-[#333] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]">
                      <option value="0.5">0.5</option><option>1</option><option>2</option><option>4</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#9e9e9e] mb-1 block">Storage</label>
                    <select value={storage} onChange={e => setStorage(e.target.value)} className="w-full bg-[#252525] border border-[#333] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]">
                      <option>5Gi</option><option>10Gi</option><option>20Gi</option><option>50Gi</option>
                    </select>
                  </div>
                </div>
                <div className="border-t border-[#2a2a2a] pt-3">
                  <p className="text-xs text-[#9e9e9e] mb-2 font-medium">Game Settings</p>
                  {selectedGame.envFields.map(field => (
                    <div key={field.key} className="mb-2">
                      <label className="text-xs text-[#666] mb-1 block">{field.label}</label>
                      <input
                        type="text"
                        value={envValues[field.key] ?? field.default}
                        onChange={e => setEnvValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="w-full bg-[#252525] border border-[#333] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {step === "preview" && (
            <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              <h2 className="text-sm font-medium text-[#f2f2f2]">YAML Preview</h2>
              <pre className="bg-[#0d0d0d] rounded-lg p-4 text-xs text-[#9e9e9e] overflow-auto max-h-80 font-mono leading-relaxed whitespace-pre-wrap border border-[#2a2a2a]">
                {buildYamlPreview()}
              </pre>
            </motion.div>
          )}

          {step === "deploy" && (
            <motion.div key="deploy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4 text-center py-4">
              {deployed ? (
                <>
                  <div className="text-5xl">🎉</div>
                  <p className="text-[#f2f2f2] font-medium">Server deployed!</p>
                  <p className="text-[#666] text-sm">Redirecting to Game Hub...</p>
                </>
              ) : (
                <>
                  <div className="text-4xl">{selectedGame?.icon ?? "🎮"}</div>
                  <p className="text-[#f2f2f2] font-medium">Ready to deploy {serverName}</p>
                  <p className="text-[#666] text-sm">This will create a Deployment, PVC, and Service in the game-hub namespace.</p>
                  <button
                    onClick={deploy}
                    disabled={deploying}
                    className="flex items-center gap-2 mx-auto px-6 py-2.5 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {deploying ? <><Loader2 className="w-4 h-4 animate-spin" />Deploying...</> : "Deploy Server"}
                  </button>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => { if (stepIndex > 0) setStep(STEPS[stepIndex - 1]); else router.push("/game-hub"); }}
          className="flex items-center gap-2 px-4 py-2 text-[#9e9e9e] hover:text-[#f2f2f2] text-sm transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          {stepIndex === 0 ? "Cancel" : "Back"}
        </button>
        {step !== "deploy" && (
          <button
            onClick={() => {
              if (step === "choose" && !selectedGame) { toast.error("Please select a game"); return; }
              if (step === "configure" && !serverName.trim()) { toast.error("Server name is required"); return; }
              setStep(STEPS[stepIndex + 1]);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
          >
            {step === "preview" ? "Proceed to Deploy" : "Next"}
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
