"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Check, Loader2, Gamepad2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import type { GameEgg } from "@/lib/game-eggs";

type StepId = "choose" | "configure" | "preview" | "deploy";
const STEPS: StepId[] = ["choose", "configure", "preview", "deploy"];
const STEP_LABELS = ["Choose Game", "Configure", "Review", "Deploy"];
const CATEGORY_LABELS: Record<string, string> = {
  sandbox: "Sandbox",
  survival: "Survival",
  strategy: "Strategy",
  shooter: "Shooter",
  automation: "Automation",
  custom: "Custom",
  other: "Other",
};
const EGG_CATEGORIES: Record<string, string> = {
  "minecraft-java": "sandbox",
  terraria: "sandbox",
  valheim: "survival",
  satisfactory: "automation",
  "v-rising": "survival",
  palworld: "survival",
  rust: "survival",
  ark: "survival",
  cs2: "shooter",
  factorio: "automation",
  generic: "other",
};
const EGG_ICONS: Record<string, string> = {
  "minecraft-java": "⛏️",
  terraria: "🌳",
  valheim: "🛡️",
  satisfactory: "🏭",
  "v-rising": "🧛",
  palworld: "🐾",
  rust: "🔧",
  ark: "🦖",
  cs2: "🎯",
  factorio: "⚙️",
  generic: "🎮",
  custom: "🧩",
};

function eggCategory(egg: GameEgg) {
  return EGG_CATEGORIES[egg.id] ?? "other";
}

function eggIcon(egg: GameEgg) {
  return EGG_ICONS[egg.id] ?? "🎮";
}

function eggEnvDefs(egg: GameEgg) {
  return egg.environment.map((entry) => ({
    key: entry.name,
    label: entry.name,
    default: entry.defaultValue,
    required: entry.required,
    type: entry.name.toLowerCase().includes("password") ? "password" : "text",
    description: entry.description,
    options: undefined as string[] | undefined,
  }));
}

function eggPvcSuffix(egg: GameEgg) {
  return egg.mountPath.split("/").filter(Boolean).pop() ?? "data";
}

export default function NewGameServerPage() {
  const router = useRouter();
  const [step, setStep] = useState<StepId>("choose");
  const [selectedEgg, setSelectedEgg] = useState<GameEgg | null>(null);
  const [serverName, setServerName] = useState("");
  const [customImage, setCustomImage] = useState("");
  const [memory, setMemory] = useState("2Gi");
  const [cpu, setCpu] = useState("1");
  const [storage, setStorage] = useState("10Gi");
  const [storageClass, setStorageClass] = useState("longhorn");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [eggSearch, setEggSearch] = useState("");

  const { data: eggsData } = useQuery({
    queryKey: ["game-hub", "eggs"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/eggs");
      return res.json() as Promise<{ eggs: GameEgg[] }>;
    },
  });

  const { data: setupData } = useQuery({
    queryKey: ["game-hub", "setup"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/setup");
      return res.json() as Promise<{ storageClasses: Array<{ name: string; provisioner: string; isDefault: boolean }>; ready: boolean }>;
    },
  });

  const eggs = eggsData?.eggs ?? [];
  const storageClasses = setupData?.storageClasses ?? [{ name: "longhorn", provisioner: "driver.longhorn.io", isDefault: true }];
  const stepIndex = STEPS.indexOf(step);

  const filteredEggs = eggs.filter(egg => {
    if (categoryFilter !== "all" && eggCategory(egg) !== categoryFilter) return false;
    if (eggSearch) {
      const q = eggSearch.toLowerCase();
      return egg.name.toLowerCase().includes(q) || egg.description.toLowerCase().includes(q);
    }
    return true;
  });

  function selectEgg(egg: GameEgg) {
    setSelectedEgg(egg);
    if (egg.id === "custom") {
      setCustomImage("");
    }
    setMemory(egg.defaultMemory ?? "2Gi");
    setCpu(egg.defaultCpu ?? "1");
    setStorage(egg.defaultStorage ?? "10Gi");
    setEnvValues(Object.fromEntries(eggEnvDefs(egg).map((envDef) => [envDef.key, envDef.default])));
    setStep("configure");
  }

  function buildYamlPreview() {
    if (!selectedEgg) return "";
    const slug = serverName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const image = selectedEgg.id === "custom" ? customImage : selectedEgg.dockerImage;
    const env = eggEnvDefs(selectedEgg).map((envDef) => ({
      key: envDef.key,
      val: envValues[envDef.key] ?? envDef.default,
    }));
    const envLines = env.map(({ key, val }) => `    - name: ${key}\n      value: "${val}"`).join("\n");
    const portsLines = (selectedEgg.ports ?? []).map((p) => `    - containerPort: ${p.port}\n      protocol: ${p.protocol}`).join("\n");
    return `# ${selectedEgg.name} Server: ${slug}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${slug}
  namespace: game-hub
spec:
  replicas: 1
  selector: {matchLabels: {app: ${slug}}}
  template:
    metadata:
      labels:
        app: ${slug}
        infraweaver/game: "true"
        infraweaver/game-type: ${selectedEgg.id}
    spec:
      containers:
        - name: ${selectedEgg.id}
          image: ${image}
          ports:
${portsLines}
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
  name: ${slug}-${eggPvcSuffix(selectedEgg)}
  namespace: game-hub
spec:
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: ${storage}`;
  }

  async function deploy() {
    if (!selectedEgg || !serverName.trim()) return;
    setDeploying(true);
    try {
      const slug = serverName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      const image = selectedEgg.id === "custom" ? customImage : selectedEgg.dockerImage;
      const res = await fetch("/api/game-hub/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          egg: selectedEgg.id,
          game: selectedEgg.id.replace(/-java|-bedrock/, ""),
          name: slug,
          image,
          memory, cpu, storage, storageClass,
          env: envValues,
          ports: selectedEgg.ports,
          mountPath: selectedEgg.mountPath,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error);
      }
      setDeployed(true);
      toast.success(`${serverName} deployed!`);
      setTimeout(() => router.push("/game-hub"), 2000);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeploying(false);
    }
  }

  const categories = ["all", ...Array.from(new Set(eggs.map((egg) => eggCategory(egg))))];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-[#666] hover:text-[#9e9e9e] p-1">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <PageHeader title="New Game Server" subtitle="Deploy a game server on Kubernetes" icon={Gamepad2} />
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center flex-1">
            <div className="flex items-center gap-2">
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 border transition-colors",
                i < stepIndex ? "bg-green-500 border-green-500 text-white"
                  : i === stepIndex ? "bg-[#0078D4] border-[#0078D4] text-white"
                  : "bg-transparent border-[#333] text-[#555]"
              )}>
                {i < stepIndex ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={cn(
                "text-xs font-medium hidden sm:block",
                i === stepIndex ? "text-[#f2f2f2]" : "text-[#555]"
              )}>{STEP_LABELS[i]}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("flex-1 h-px mx-3 transition-colors", i < stepIndex ? "bg-green-500" : "bg-[#2a2a2a]")} />
            )}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
        >
          {/* Step 1: Choose Game */}
          {step === "choose" && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex items-center gap-2 flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2">
                  <Search className="w-4 h-4 text-[#555]" />
                  <input
                    value={eggSearch}
                    onChange={e => setEggSearch(e.target.value)}
                    placeholder="Search games..."
                    className="flex-1 bg-transparent text-sm text-[#f2f2f2] outline-none placeholder:text-[#555]"
                  />
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {categories.map(cat => (
                    <button
                      key={cat}
                      onClick={() => setCategoryFilter(cat)}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize",
                        categoryFilter === cat
                          ? "bg-[#0078D4] text-white"
                          : "bg-[#1a1a1a] border border-[#2a2a2a] text-[#666] hover:text-[#9e9e9e]"
                      )}
                    >
                      {cat === "all" ? "All" : CATEGORY_LABELS[cat] ?? cat}
                    </button>
                  ))}
                </div>
              </div>

              {filteredEggs.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-[#555] text-sm">
                  No games match your search
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredEggs.map((egg, i) => (
                    <motion.button
                      key={egg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      onClick={() => selectEgg(egg)}
                      className="flex items-start gap-3 p-4 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] hover:border-[#0078D4]/50 hover:bg-[rgba(0,120,212,0.05)] text-left transition-colors group"
                    >
                      <div className="text-2xl flex-shrink-0">{eggIcon(egg)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-[#f2f2f2] group-hover:text-white">{egg.name}</p>
                        </div>
                        <p className="text-xs text-[#666] mt-0.5 line-clamp-2">{egg.description}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-[10px] bg-[#252525] text-[#666] rounded px-1.5 py-0.5 capitalize">
                            {CATEGORY_LABELS[eggCategory(egg)] ?? eggCategory(egg)}
                          </span>
                          <span className="text-[10px] text-[#555]">{egg.defaultMemory} RAM</span>
                        </div>
                      </div>
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Configure */}
          {step === "configure" && selectedEgg && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a]">
                <div className="text-2xl">{eggIcon(selectedEgg)}</div>
                <div>
                  <p className="font-medium text-[#f2f2f2]">{selectedEgg.name}</p>
                  <p className="text-xs text-[#666]">{selectedEgg.description}</p>
                </div>
                <button onClick={() => setStep("choose")} className="ml-auto text-xs text-[#0078D4] hover:underline">Change</button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-xs font-medium text-[#999]">Server Name *</label>
                  <input
                    value={serverName}
                    onChange={e => setServerName(e.target.value)}
                    placeholder="my-minecraft-server"
                    className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4] placeholder:text-[#555]"
                  />
                  <p className="text-[10px] text-[#555]">Lowercase letters, numbers, hyphens only</p>
                </div>

                {selectedEgg.id === "custom" && (
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-xs font-medium text-[#999]">Docker Image *</label>
                    <input
                      value={customImage}
                      onChange={e => setCustomImage(e.target.value)}
                      placeholder="your-registry/image:tag"
                      className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm font-mono text-[#f2f2f2] focus:outline-none focus:border-[#0078D4] placeholder:text-[#555]"
                    />
                  </div>
                )}

                {/* Resources */}
                {[
                  { label: "Memory Limit", value: memory, onChange: setMemory, placeholder: "2Gi" },
                  { label: "CPU Limit", value: cpu, onChange: setCpu, placeholder: "1" },
                  { label: "Storage Size", value: storage, onChange: setStorage, placeholder: "10Gi" },
                ].map(f => (
                  <div key={f.label} className="space-y-1.5">
                    <label className="text-xs font-medium text-[#999]">{f.label}</label>
                    <input
                      value={f.value}
                      onChange={e => f.onChange(e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4] placeholder:text-[#555]"
                    />
                  </div>
                ))}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[#999]">Storage Class</label>
                  <select
                    value={storageClass}
                    onChange={e => setStorageClass(e.target.value)}
                    className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                  >
                    {storageClasses.map(sc => (
                      <option key={sc.name} value={sc.name}>
                        {sc.name}{sc.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Egg-specific env vars */}
              {eggEnvDefs(selectedEgg).length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-[#999] uppercase tracking-wide">Server Configuration</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {eggEnvDefs(selectedEgg).map((envDef) => (
                      <div key={envDef.key} className="space-y-1.5">
                        <label className="text-xs font-medium text-[#999]">
                          {envDef.label}
                          {envDef.required && <span className="text-red-400 ml-1">*</span>}
                        </label>
                        {envDef.type === "select" ? (
                          <select
                            value={envValues[envDef.key] ?? envDef.default}
                            onChange={e => setEnvValues(prev => ({ ...prev, [envDef.key]: e.target.value }))}
                            className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                          >
                            {envDef.options?.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : envDef.type === "boolean" ? (
                          <select
                            value={envValues[envDef.key] ?? envDef.default}
                            onChange={e => setEnvValues(prev => ({ ...prev, [envDef.key]: e.target.value }))}
                            className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            type={envDef.type === "password" ? "password" : "text"}
                            value={envValues[envDef.key] ?? envDef.default}
                            onChange={e => setEnvValues(prev => ({ ...prev, [envDef.key]: e.target.value }))}
                            placeholder={envDef.default}
                            className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4] placeholder:text-[#555]"
                          />
                        )}
                        {envDef.description && (
                          <p className="text-[10px] text-[#555]">{envDef.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2 pb-4">
                <button onClick={() => setStep("choose")} className="flex items-center gap-1.5 px-4 py-2 bg-[#1a1a1a] border border-[#2a2a2a] text-[#9e9e9e] rounded-lg text-sm hover:bg-[#252525] transition-colors">
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={() => setStep("preview")}
                  disabled={!serverName.trim() || (selectedEgg.id === "custom" && !customImage.trim())}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm transition-colors ml-auto"
                >
                  Preview <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Preview */}
          {step === "preview" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-4 overflow-auto max-h-96">
                <pre className="text-xs font-mono text-[#d4d4d4] whitespace-pre-wrap">{buildYamlPreview()}</pre>
              </div>
              <div className="flex gap-3 pb-4">
                <button onClick={() => setStep("configure")} className="flex items-center gap-1.5 px-4 py-2 bg-[#1a1a1a] border border-[#2a2a2a] text-[#9e9e9e] rounded-lg text-sm hover:bg-[#252525] transition-colors">
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={() => { setStep("deploy"); deploy(); }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors ml-auto"
                >
                  Deploy Server <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Deploy */}
          {step === "deploy" && (
            <div className="flex flex-col items-center justify-center py-16 space-y-4">
              {deployed ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
                    <Check className="w-7 h-7 text-green-400" />
                  </div>
                  <p className="text-lg font-semibold text-[#f2f2f2]">Server Deployed!</p>
                  <p className="text-sm text-[#666]">Redirecting to game hub...</p>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-[rgba(0,120,212,0.15)] flex items-center justify-center">
                    <Loader2 className="w-7 h-7 text-[#0078D4] animate-spin" />
                  </div>
                  <p className="text-lg font-semibold text-[#f2f2f2]">Deploying...</p>
                  <p className="text-sm text-[#666]">Creating Kubernetes resources</p>
                </>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
