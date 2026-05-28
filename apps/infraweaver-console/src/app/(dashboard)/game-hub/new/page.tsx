"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ChevronLeft, ChevronRight, Gamepad2, Loader2, Search, ServerCrash, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { BUILT_IN_EGGS, type GameEgg, validateEggVariable, describeEggVariableRules } from "@/lib/game-eggs";
import type { CatalogCategory, CatalogEntry } from "@/lib/pelican-eggs";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";

const STEPS = [
  { id: 1, label: "Browse Eggs" },
  { id: 2, label: "Configure Variables" },
  { id: 3, label: "Resources" },
  { id: 4, label: "Review & Deploy" },
] as const;

const CATEGORY_ICONS: Record<string, string> = {
  minecraft: "⛏️",
  bots: "🤖",
  database: "🗄️",
  generic: "🧩",
  monitoring: "📈",
  software: "📦",
  storage: "💾",
  voice_servers: "🎙️",
  voice: "🎙️",
  game_eggs: "🎮",
  misc: "🎮",
};

const BUILT_IN_ICONS: Record<string, string> = {
  "minecraft-java": "⛏️",
  terraria: "🌍",
  valheim: "🪓",
  satisfactory: "🏭",
  "v-rising": "🧛",
  palworld: "🐾",
  rust: "🏚️",
  ark: "🦖",
  cs2: "🔫",
  factorio: "⚙️",
};

function normalizeServerName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function categoryIcon(path: string) {
  return CATEGORY_ICONS[path] ?? "🎮";
}

function builtInIcon(egg: GameEgg) {
  return BUILT_IN_ICONS[egg.id] ?? "🎮";
}

function parseMemoryToMi(value: string | undefined) {
  const trimmed = (value ?? "2Gi").trim().toLowerCase();
  const numeric = Number.parseFloat(trimmed.replace(/[^\d.]/g, "")) || 2048;
  if (trimmed.endsWith("gi") || trimmed.endsWith("g")) return Math.round(numeric * 1024);
  if (trimmed.endsWith("ki") || trimmed.endsWith("k")) return Math.max(512, Math.round(numeric / 1024));
  return Math.max(512, Math.round(numeric));
}

function formatMemory(mi: number) {
  return mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

function parseCpuToCores(value: string | undefined) {
  const trimmed = (value ?? "1").trim().toLowerCase();
  if (trimmed.endsWith("m")) {
    return Math.max(0.5, Number.parseInt(trimmed.slice(0, -1), 10) / 1000);
  }
  return Math.max(0.5, Number.parseFloat(trimmed) || 1);
}

function formatCpu(cores: number) {
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(1).replace(/\.0$/, "");
}

function parseStorageToGi(value: string | undefined) {
  const trimmed = (value ?? "10Gi").trim().toLowerCase();
  const numeric = Number.parseFloat(trimmed.replace(/[^\d.]/g, "")) || 10;
  if (trimmed.endsWith("ti") || trimmed.endsWith("t")) return Math.round(numeric * 1024);
  if (trimmed.endsWith("mi") || trimmed.endsWith("m")) return Math.max(5, Math.round(numeric / 1024));
  return Math.max(5, Math.round(numeric));
}

function sliderTrackStyle(value: number, min: number, max: number) {
  const percent = ((Math.min(Math.max(value, min), max) - min) / Math.max(max - min, 1)) * 100;
  return {
    background: `linear-gradient(90deg, #0078D4 0%, #0078D4 ${percent}%, #1a1a1a ${percent}%, #1a1a1a 100%)`,
  } as const;
}

type GameHubCapacityNode = {
  name: string;
  ready: boolean;
  requestMemoryPct: number;
  limitMemoryPct: number;
  usageMemoryPct: number | null;
};

type GameHubCapacity = {
  nodes: GameHubCapacityNode[];
  gameHubUsage: {
    requestedMemoryBytes: number;
    quota: {
      requestsMemoryBytes: number;
    };
  };
  summary: {
    maxRequestMemoryPct: number;
    maxLimitMemoryPct: number;
    maxUsageMemoryPct: number | null;
    projectedWorstNodeRequestMemoryPct: number;
  };
  canSafelyDeploy: boolean;
  warnings: string[];
};

function formatBytesGi(bytes: number | null | undefined) {
  if (!bytes) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} Gi`;
}

export default function NewGameServerPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [sourceTab, setSourceTab] = useState<"built-in" | "pelican">("pelican");
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedBuiltInId, setSelectedBuiltInId] = useState<string | null>(null);
  const [selectedRemoteEntry, setSelectedRemoteEntry] = useState<CatalogEntry | null>(null);
  const [serverName, setServerName] = useState("");
  const [dnsHostname, setDnsHostname] = useState("");
  const [dnsTouched, setDnsTouched] = useState(false);
  const [dnsType, setDnsType] = useState<"internal" | "public" | "custom">("internal");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [memoryMi, setMemoryMi] = useState(2048);
  const [cpuCores, setCpuCores] = useState(1);
  const [storageGi, setStorageGi] = useState(10);
  const [storageClass, setStorageClass] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployedServerName, setDeployedServerName] = useState<string | null>(null);
  const [selectedDockerImage, setSelectedDockerImage] = useState<string | null>(null);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [envErrors, setEnvErrors] = useState<Record<string, string>>({});

  const { data: catalogData, isLoading: catalogLoading, error: catalogError } = useQuery({
    queryKey: ["game-hub", "pelican-catalog"],
    queryFn: async () => {
      const response = await fetch("/api/game-hub/eggs/catalog");
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "Failed to load egg catalog" })) as { error?: string };
        throw new Error(errorPayload.error ?? "Failed to load egg catalog");
      }
      return response.json() as Promise<{ categories: CatalogCategory[]; total: number }>;
    },
    staleTime: 3_600_000,
  });

  const { data: setupData } = useQuery({
    queryKey: ["game-hub", "setup"],
    queryFn: async () => {
      const response = await fetch("/api/game-hub/setup");
      if (!response.ok) throw new Error("Failed to load storage classes");
      return response.json() as Promise<{ storageClasses: Array<{ name: string; provisioner: string; isDefault: boolean }>; ready: boolean }>;
    },
  });

  const { data: capacityData } = useQuery({
    queryKey: ["game-hub", "capacity", memoryMi, cpuCores, selectedBuiltInId, selectedRemoteEntry?.id],
    enabled: Boolean(selectedBuiltInId || selectedRemoteEntry),
    refetchInterval: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams({ memory: formatMemory(memoryMi), cpu: formatCpu(cpuCores) });
      const response = await fetch(`/api/game-hub/capacity?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to load cluster capacity");
      return response.json() as Promise<GameHubCapacity>;
    },
  });

  const remoteEggPath = selectedRemoteEntry?.path ?? null;
  const { data: remoteEggData, isLoading: remoteEggLoading, error: remoteEggError } = useQuery({
    queryKey: ["game-hub", "pelican-egg", remoteEggPath],
    queryFn: async () => {
      if (!remoteEggPath) throw new Error("No Pelican egg selected");
      const response = await fetch(`/api/game-hub/eggs/catalog/${remoteEggPath}`);
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "Failed to load egg" })) as { error?: string };
        throw new Error(errorPayload.error ?? "Failed to load egg");
      }
      return response.json() as Promise<{ egg: GameEgg; path: string; id: string }>;
    },
    enabled: Boolean(remoteEggPath),
    staleTime: 3_600_000,
  });

  const storageClasses = setupData?.storageClasses ?? [{ name: "longhorn", provisioner: "driver.longhorn.io", isDefault: true }];

  // Sync storageClass default once setup data loads (avoids hardcoded "longhorn-game" which may not exist)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!storageClass && storageClasses.length > 0) {
      const preferred = storageClasses.find((sc) => sc.isDefault) ?? storageClasses[0];
      setStorageClass(preferred.name);
    }
  }, [storageClasses.map((sc) => sc.name).join(",")]); // dep on names string to avoid object ref changes
  const activeEgg = sourceTab === "built-in"
    ? BUILT_IN_EGGS.find((egg) => egg.id === selectedBuiltInId) ?? null
    : remoteEggData?.egg ?? null;
  const activeEggKey = sourceTab === "built-in" ? selectedBuiltInId : selectedRemoteEntry?.id ?? null;
  const highestPressureNode = capacityData?.nodes.reduce<GameHubCapacityNode | null>((worst, node) => {
    if (!node.ready) return worst;
    if (!worst || node.requestMemoryPct > worst.requestMemoryPct) return node;
    return worst;
  }, null) ?? null;

  // Use activeEggKey (string ID) as the sole trigger — the activeEgg object itself
  // can be a new reference on re-renders (React Query or find() returning same data),
  // which would cause an infinite setState loop (React error #185) if used as a dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeEgg || !activeEggKey) return;
    setEnvValues(Object.fromEntries(activeEgg.environment.map((entry) => [entry.name, entry.defaultValue])));
    setMemoryMi(parseMemoryToMi(activeEgg.defaultMemory));
    setCpuCores(parseCpuToCores(activeEgg.defaultCpu));
    setStorageGi(parseStorageToGi(activeEgg.defaultStorage));
    // Auto-select the recommended (first) docker image when egg has multiple options
    if (activeEgg.dockerImages && Object.keys(activeEgg.dockerImages).length > 0) {
      setSelectedDockerImage(Object.values(activeEgg.dockerImages)[0]);
    } else {
      setSelectedDockerImage(null);
    }
    setEulaAccepted(false);
    setEnvErrors({});
  }, [activeEggKey]); // intentionally omitting activeEgg — key change implies egg change

  useEffect(() => {
    if (dnsType === "custom") return; // let the user type freely
    const normalized = normalizeServerName(serverName);
    if (dnsType === "internal") {
      setDnsHostname(normalized ? `${normalized}.games.int.rlservers.com` : "");
    } else {
      setDnsHostname(normalized ? `${normalized}.games.rlservers.com` : "");
    }
  }, [dnsType, serverName]);

  const remoteCategories = catalogData?.categories ?? [];
  const remoteEggs = useMemo(() => remoteCategories.flatMap((category) =>
    category.eggs.map((egg) => ({ ...egg, categoryPath: category.path, categoryName: category.name }))
  ), [remoteCategories]);

  const filteredBuiltInEggs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return BUILT_IN_EGGS.filter((egg) => {
      if (!query) return true;
      return [egg.name, egg.description, egg.dockerImage, egg.id].some((value) => value.toLowerCase().includes(query));
    });
  }, [search]);

  const filteredRemoteEggs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return remoteEggs.filter((egg) => {
      if (selectedCategory !== "all" && egg.categoryPath !== selectedCategory) return false;
      if (!query) return true;
      return [egg.name, egg.description, egg.dockerImage, egg.author, egg.id, egg.categoryName].some((value) => value.toLowerCase().includes(query));
    });
  }, [remoteEggs, search, selectedCategory]);

  const needsEula = Boolean(activeEgg?.features?.includes("eula"));
  const requiredEnvMissing = activeEgg?.environment
    .filter((entry) => entry.userViewable !== false)
    .some((entry) => entry.required && !(envValues[entry.name] ?? "").trim());
  const canContinueFromConfigure = Boolean(
    activeEgg && serverName.trim() && !requiredEnvMissing && (!needsEula || eulaAccepted)
  );

  function selectBuiltInEgg(egg: GameEgg) {
    setSourceTab("built-in");
    setSelectedBuiltInId(egg.id);
    setSelectedRemoteEntry(null);
    // Auto-suggest a name only if the user hasn't typed one yet
    if (!serverName.trim()) {
      setServerName(egg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }
    setStep(2);
  }

  function selectRemoteEgg(entry: CatalogEntry) {
    setSourceTab("pelican");
    setSelectedRemoteEntry(entry);
    setSelectedBuiltInId(null);
    // Auto-suggest a name only if the user hasn't typed one yet
    if (!serverName.trim()) {
      setServerName(entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }
    setStep(2);
  }

  async function deployServer() {
    if (!activeEgg) return;
    setDeploying(true);
    try {
      const payload = {
        name: normalizeServerName(serverName),
        egg: sourceTab === "pelican" && selectedRemoteEntry ? `pelican:${selectedRemoteEntry.id}` : activeEgg.id,
        image: selectedDockerImage ?? activeEgg.dockerImage,
        // Inject EULA=TRUE when the user accepts the license agreement (required for Minecraft etc.)
        env: needsEula && eulaAccepted ? { ...envValues, EULA: "TRUE" } : envValues,
        memory: formatMemory(memoryMi),
        cpu: formatCpu(cpuCores),
        storage: `${storageGi}Gi`,
        storageClass,
        dnsHostname: dnsHostname.trim() || undefined,
      };

      if (capacityData && !capacityData.canSafelyDeploy) {
        toast.error("Cluster memory pressure is high — deploying this server may cause service disruption");
      }

      const response = await fetch("/api/game-hub/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "Deployment failed" })) as { error?: string };
        throw new Error(errorPayload.error ?? "Deployment failed");
      }

      const result = await response.json() as { name: string };
      setDeployedServerName(result.name);
      toast.success(`${result.name} deployment started`);
      router.push(`/game-hub/${result.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeploying(false);
    }
  }

  const summaryRows = [
    { label: "Egg Source", value: sourceTab === "built-in" ? "Built-in library" : "Pelican catalog" },
    { label: "Selected Egg", value: activeEgg?.name ?? "—" },
    { label: "Docker Image", value: selectedDockerImage ?? activeEgg?.dockerImage ?? "—" },
    { label: "Server Name", value: normalizeServerName(serverName) || "—" },
    { label: "DNS Hostname", value: dnsHostname || "Auto-generated" },
    { label: "Memory", value: formatMemory(memoryMi) },
    { label: "CPU", value: `${formatCpu(cpuCores)} cores` },
    { label: "Storage", value: `${storageGi}Gi (${storageClass})` },
    { label: "Pod resources", value: `${formatMemory(memoryMi)} request/limit • ${formatCpu(cpuCores)} CPU request/limit` },
    { label: "Priority Class", value: "game-server" },
    { label: "Rollout Strategy", value: "Recreate" },
    { label: "Game Port", value: activeEgg ? `${activeEgg.gamePort}/${activeEgg.protocol ?? "TCP"}` : "—" },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="New Game Server"
        subtitle="Browse built-in and Pelican eggs, then deploy with a guided wizard"
        icon={Gamepad2}
        actions={
          <button
            onClick={() => router.push("/game-hub")}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Game Hub
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        {STEPS.map((entry) => (
          <div
            key={entry.id}
            className={cn(
              "rounded-xl border px-4 py-3 transition-colors",
              step === entry.id
                ? "border-[#0078D4]/40 bg-[#0078D4]/10"
                : step > entry.id
                  ? "border-green-500/30 bg-green-500/10"
                  : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]"
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold",
                step === entry.id
                  ? "border-[#0078D4] bg-[#0078D4] text-white"
                  : step > entry.id
                    ? "border-green-500 bg-green-500 text-white"
                    : "border-gray-200 dark:border-[#333] text-gray-400 dark:text-[#666]"
              )}>
                {step > entry.id ? <CheckCircle2 className="h-4 w-4" /> : entry.id}
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Step {entry.id}</p>
                <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{entry.label}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.18 }}
          className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0f0f0f] p-6"
        >
          {step === 1 && (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Choose an egg</h2>
                  <p className="text-sm text-gray-500 dark:text-[#777]">Browse the live Pelican catalog or pick a quick-start built-in egg.</p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-1">
                    {([
                      { id: "pelican", label: `🎮 Pelican${catalogData ? ` (${catalogData.total})` : ""}` },
                      { id: "built-in", label: "⚡ Quick Start" },
                    ] as const).map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setSourceTab(tab.id)}
                        className={cn(
                          "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          sourceTab === tab.id ? "bg-[#0078D4] text-white" : "text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white"
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex min-w-[260px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2">
                    <Search className="h-4 w-4 text-gray-400 dark:text-[#555]" />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={sourceTab === "built-in" ? "Search quick-start eggs..." : "Search Pelican catalog..."}
                      className="w-full bg-transparent text-sm text-gray-900 dark:text-[#f2f2f2] outline-none placeholder:text-gray-400 dark:placeholder:text-[#555]"
                    />
                  </div>
                </div>
              </div>

              {sourceTab === "built-in" ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredBuiltInEggs.map((egg) => (
                    <button
                      key={egg.id}
                      onClick={() => selectBuiltInEgg(egg)}
                      className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 text-left transition-colors hover:border-[#0078D4]/50 hover:bg-[#0078D4]/5"
                    >
                      <div className="mb-4 flex items-start gap-3">
                        <div className="text-3xl">{builtInIcon(egg)}</div>
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{egg.name}</p>
                          <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-[#777]">{egg.description}</p>
                        </div>
                      </div>
                      <dl className="space-y-1.5 text-xs text-gray-500 dark:text-[#999]">
                        <div className="flex justify-between gap-3">
                          <dt>Image</dt>
                          <dd className="truncate font-mono text-gray-700 dark:text-[#cfcfcf]">{egg.dockerImage}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt>Port</dt>
                          <dd className="text-gray-700 dark:text-[#cfcfcf]">{egg.gamePort}/{egg.protocol ?? "TCP"}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt>Defaults</dt>
                          <dd className="text-gray-700 dark:text-[#cfcfcf]">{egg.defaultMemory ?? "2Gi"} · {egg.defaultCpu ?? "1"} CPU</dd>
                        </div>
                      </dl>
                    </button>
                  ))}
                  {filteredBuiltInEggs.length === 0 && (
                    <div className="col-span-full rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] p-10 text-center text-sm text-gray-400 dark:text-[#666]">
                      No built-in eggs matched your search.
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setSelectedCategory("all")}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                        selectedCategory === "all"
                          ? "border-[#0078D4]/40 bg-[#0078D4]/15 text-[#7cc4ff]"
                          : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white"
                      )}
                    >
                      All Categories
                    </button>
                    {remoteCategories.map((category) => (
                      <button
                        key={category.path}
                        onClick={() => setSelectedCategory(category.path)}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                          selectedCategory === category.path
                            ? "border-[#0078D4]/40 bg-[#0078D4]/15 text-[#7cc4ff]"
                            : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white"
                        )}
                      >
                        <span className="mr-1.5">{categoryIcon(category.path)}</span>
                        {category.name}
                      </button>
                    ))}
                  </div>

                  {catalogLoading ? (
                    <div className="flex h-48 items-center justify-center gap-3 text-gray-500 dark:text-[#777]">
                      <Loader2 className="h-5 w-5 animate-spin" /> Loading Pelican egg catalog...
                    </div>
                  ) : catalogError ? (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                      {catalogError instanceof Error ? catalogError.message : "Failed to load the Pelican egg catalog."}
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {filteredRemoteEggs.map((egg) => (
                        <button
                          key={`${egg.path}-${egg.id}`}
                          onClick={() => selectRemoteEgg(egg)}
                          className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 text-left transition-colors hover:border-[#0078D4]/50 hover:bg-[#0078D4]/5"
                        >
                          <div className="mb-4 flex items-start gap-3">
                            <div className="text-3xl">{categoryIcon(egg.categoryPath)}</div>
                            <div className="min-w-0">
                              <p className="truncate text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{egg.name}</p>
                              <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-[#777]">{egg.description || "No description provided."}</p>
                            </div>
                          </div>
                          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-[#999]">
                            <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] px-2 py-1 text-gray-700 dark:text-[#cfcfcf]">{egg.categoryName}</span>
                            {egg.hasMultipleImages && (
                              <span className="rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-2 py-1 text-[#7cc4ff]">multi-image</span>
                            )}
                            {egg.features?.includes("eula") && (
                              <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-yellow-300">EULA</span>
                            )}
                            {egg.author ? <span>by {egg.author}</span> : null}
                          </div>
                          <p className="truncate font-mono text-xs text-gray-700 dark:text-[#cfcfcf]">{egg.dockerImage}</p>
                        </button>
                      ))}
                      {filteredRemoteEggs.length === 0 && (
                        <div className="col-span-full rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] p-10 text-center text-sm text-gray-400 dark:text-[#666]">
                          No Pelican eggs matched the current search.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5">
                <div className="flex items-start gap-3">
                  <div className="text-3xl">
                    {sourceTab === "built-in" && activeEgg ? builtInIcon(activeEgg) : categoryIcon(selectedRemoteEntry?.categoryPath ?? "misc")}
                  </div>
                  <div>
                    <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{activeEgg?.name ?? selectedRemoteEntry?.name ?? "Loading egg..."}</p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">{activeEgg?.description ?? selectedRemoteEntry?.description ?? "Fetching egg details from Pelican..."}</p>
                    <p className="mt-2 font-mono text-xs text-gray-500 dark:text-[#999]">{activeEgg?.dockerImage ?? selectedRemoteEntry?.dockerImage ?? "—"}</p>
                  </div>
                </div>
                <button onClick={() => setStep(1)} className="text-sm text-[#7cc4ff] hover:text-gray-900 dark:hover:text-white">Change egg</button>
              </div>

              {sourceTab === "pelican" && remoteEggLoading && (
                <div className="flex h-40 items-center justify-center gap-3 text-gray-500 dark:text-[#777]">
                  <Loader2 className="h-5 w-5 animate-spin" /> Loading Pelican egg variables...
                </div>
              )}

              {sourceTab === "pelican" && remoteEggError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                  {remoteEggError instanceof Error ? remoteEggError.message : "Failed to load the selected Pelican egg."}
                </div>
              )}

              {activeEgg && (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Server Name</label>
                      <input
                        value={serverName}
                        onChange={(event) => setServerName(event.target.value)}
                        placeholder="my-server"
                        className="w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-3 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                      />
                      <p className="text-xs text-gray-400 dark:text-[#666]">The deployed Kubernetes resource will use {normalizeServerName(serverName) || "your-server-name"}.</p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">DNS Hostname</label>
                      {/* DNS type toggle */}
                      <div className="flex gap-1 rounded-lg bg-white dark:bg-[#0d0d0d] p-1 w-fit">
                        {(["internal", "public", "custom"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setDnsType(t)}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                              dnsType === t
                                ? "bg-[#0078D4] text-white"
                                : "text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                            }`}
                          >
                            {t === "internal" ? "🔒 Internal" : t === "public" ? "🌐 Public" : "✏️ Custom"}
                          </button>
                        ))}
                      </div>
                      {dnsType === "custom" ? (
                        <input
                          value={dnsHostname}
                          onChange={(e) => setDnsHostname(e.target.value)}
                          placeholder="e.g. game.example.com"
                          className="w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-3 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                        />
                      ) : (
                        <p className="rounded-xl border border-gray-200 dark:border-[#1a1a1a] bg-white dark:bg-[#0a0a0a] px-4 py-3 text-sm text-gray-500 dark:text-[#888] font-mono">
                          {dnsHostname || <span className="italic">Enter a server name above</span>}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 dark:text-[#555]">
                        {dnsType === "internal"
                          ? "Only accessible via NetBird VPN (int.rlservers.com)"
                          : dnsType === "public"
                          ? "Publicly reachable on the internet"
                          : "Custom hostname — you manage the DNS record"}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Egg variables</h3>
                      <p className="text-sm text-gray-500 dark:text-[#777]">Configure environment variables from the selected egg.</p>
                    </div>

                    {/* Docker image picker (PTDL_v2 eggs with multiple images, e.g. Java 17 vs 21) */}
                    {activeEgg.dockerImages && Object.keys(activeEgg.dockerImages).length > 1 && (
                      <div className="rounded-2xl border border-[#0078D4]/20 bg-[#0078D4]/5 p-4 space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7cc4ff]">Runtime Image</label>
                        <p className="text-xs text-gray-500 dark:text-[#777]">This egg supports multiple runtime versions. Select which one to use.</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {Object.entries(activeEgg.dockerImages).map(([label, image]) => (
                            <button
                              key={image}
                              type="button"
                              onClick={() => setSelectedDockerImage(image)}
                              className={cn(
                                "rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                                (selectedDockerImage ?? activeEgg.dockerImage) === image
                                  ? "border-[#0078D4]/50 bg-[#0078D4]/15 text-[#7cc4ff]"
                                  : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:border-[#3a3a3a] hover:text-gray-700 dark:hover:text-[#ccc]"
                              )}
                            >
                              <span className="font-medium block">{label}</span>
                              <span className="font-mono opacity-60 truncate block mt-0.5">{image}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* EULA acceptance (eggs with features: ["eula"]) */}
                    {needsEula && (
                      <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-4">
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={eulaAccepted}
                            onChange={(e) => setEulaAccepted(e.target.checked)}
                            className="mt-0.5 h-4 w-4 accent-yellow-400 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-yellow-300">I accept the End User License Agreement (EULA)</span>
                            <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">
                              This server requires EULA acceptance before it can start. By checking this box you agree on behalf of all users.
                              {" "}<a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener noreferrer" className="text-yellow-400 hover:text-yellow-300 underline">Read the EULA →</a>
                            </p>
                          </div>
                        </label>
                      </div>
                    )}

                    {activeEgg.environment.filter((v) => v.userViewable !== false).length === 0 ? (
                      <div className="rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] p-6 text-sm text-gray-400 dark:text-[#666]">
                        This egg does not define any editable environment variables.
                      </div>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-2">
                        {activeEgg.environment.filter((v) => v.userViewable !== false).map((variable) => {
                          const fieldType = variable.fieldType ?? "text";
                          const label = variable.description.split(":")[0] || variable.name;
                          const helperText = variable.description;
                          const value = envValues[variable.name] ?? variable.defaultValue;
                          const rulesHint = describeEggVariableRules(variable.rules);
                          const error = envErrors[variable.name];
                          const isReadOnly = variable.userEditable === false;

                          return (
                            <div key={variable.name} className={cn("rounded-2xl border bg-white dark:bg-[#111] p-4", error ? "border-red-500/40" : "border-gray-200 dark:border-[#2a2a2a]")}>
                              <div className="mb-3 flex items-start justify-between gap-3">
                                <div>
                                  <label className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">
                                    {label}
                                    {variable.required ? <span className="ml-1 text-red-400">*</span> : null}
                                    {isReadOnly ? <span className="ml-1 text-[10px] text-gray-400 dark:text-[#666] font-normal">(read-only)</span> : null}
                                  </label>
                                  <p className="mt-1 text-xs text-gray-500 dark:text-[#777]">{helperText}</p>
                                  {rulesHint && <p className="mt-0.5 text-[10px] text-gray-400 dark:text-[#555]">{rulesHint}</p>}
                                </div>
                                <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-gray-500 dark:text-[#999] flex-shrink-0">{fieldType}</span>
                              </div>

                              {fieldType === "boolean" ? (
                                <ToggleSwitch
                                  checked={String(value).toLowerCase() === "true"}
                                  onChange={(checked) => setEnvValues((current) => ({ ...current, [variable.name]: checked ? "true" : "false" }))}
                                  label={variable.name}
                                  description="Toggle the boolean value"
                                  disabled={isReadOnly}
                                />
                              ) : (
                                <input
                                  type={fieldType === "integer" ? "number" : /password|token|secret/i.test(variable.name) ? "password" : "text"}
                                  value={value}
                                  readOnly={isReadOnly}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    setEnvValues((current) => ({ ...current, [variable.name]: next }));
                                    // clear error while typing
                                    if (envErrors[variable.name]) {
                                      setEnvErrors((prev) => { const copy = { ...prev }; delete copy[variable.name]; return copy; });
                                    }
                                  }}
                                  onBlur={() => {
                                    const err = validateEggVariable(variable, value);
                                    if (err) setEnvErrors((prev) => ({ ...prev, [variable.name]: err }));
                                  }}
                                  placeholder={variable.defaultValue}
                                  className={cn(
                                    "w-full rounded-xl border px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors",
                                    isReadOnly ? "bg-white dark:bg-[#0d0d0d] text-gray-400 dark:text-[#666] cursor-not-allowed" : "bg-white dark:bg-[#0d0d0d] focus:border-[#0078D4]/50",
                                    error ? "border-red-500/40" : "border-gray-200 dark:border-[#2a2a2a]"
                                  )}
                                />
                              )}
                              {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="flex items-center justify-between gap-3 pt-4">
                <button
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!canContinueFromConfigure || remoteEggLoading}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0078D4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#006cbe] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && activeEgg && (
            <div className="space-y-8">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Set resources</h2>
                <p className="text-sm text-gray-500 dark:text-[#777]">Tune the default memory, CPU, and storage before deployment.</p>
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Memory</p>
                      <p className="text-sm text-gray-500 dark:text-[#777]">512Mi to 16Gi</p>
                    </div>
                    <span className="rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-1 text-sm font-medium text-[#7cc4ff]">{formatMemory(memoryMi)}</span>
                  </div>
                  <input
                    type="range"
                    min={512}
                    max={16384}
                    step={512}
                    value={memoryMi}
                    onChange={(event) => setMemoryMi(Number.parseInt(event.target.value, 10))}
                    style={sliderTrackStyle(memoryMi, 512, 16384)}
                    className="mt-5 h-2 w-full cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                  />
                </div>

                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:row-span-2">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Storage</h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">5Gi to 500Gi</p>
                  <div className="mt-5 space-y-4">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Size</label>
                      <input
                        type="number"
                        min={5}
                        max={500}
                        value={storageGi}
                        onChange={(event) => setStorageGi(Math.max(5, Math.min(500, Number.parseInt(event.target.value || "10", 10))))}
                        className="w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Storage Class</label>
                      <select
                        value={storageClass}
                        onChange={(event) => setStorageClass(event.target.value)}
                        className="w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                      >
                        {storageClasses.map((entry) => (
                          <option key={entry.name} value={entry.name}>{entry.name}{entry.isDefault ? " (default)" : ""}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">CPU</p>
                      <p className="text-sm text-gray-500 dark:text-[#777]">0.5 to 8 cores</p>
                    </div>
                    <span className="rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-1 text-sm font-medium text-[#7cc4ff]">{formatCpu(cpuCores)} cores</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={8}
                    step={0.5}
                    value={cpuCores}
                    onChange={(event) => setCpuCores(Number.parseFloat(event.target.value))}
                    style={sliderTrackStyle(cpuCores, 0.5, 8)}
                    className="mt-5 h-2 w-full cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                  />
                </div>
              </div>

              {capacityData ? (
                <div className={cn(
                  "rounded-2xl border p-5",
                  capacityData.canSafelyDeploy ? "border-green-500/30 bg-green-500/5" : "border-amber-500/40 bg-amber-500/10"
                )}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Cluster capacity</h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">Live safety check before this server is deployed.</p>
                    </div>
                    <span className={cn(
                      "rounded-full px-2 py-1 text-[11px] font-medium",
                      capacityData.canSafelyDeploy ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-300"
                    )}>
                      {capacityData.canSafelyDeploy ? "Safe" : "Warning"}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-xs">
                    <div className="rounded-xl bg-black/20 p-3">
                      <p className="text-gray-500 dark:text-[#777]">Highest node requests</p>
                      <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{capacityData.summary.maxRequestMemoryPct.toFixed(1)}%</p>
                      <p className="text-gray-400 dark:text-[#666]">{highestPressureNode?.name ?? "No ready nodes"}</p>
                    </div>
                    <div className="rounded-xl bg-black/20 p-3">
                      <p className="text-gray-500 dark:text-[#777]">Highest node limits</p>
                      <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{capacityData.summary.maxLimitMemoryPct.toFixed(1)}%</p>
                      <p className="text-gray-400 dark:text-[#666]">Current overcommit</p>
                    </div>
                    <div className="rounded-xl bg-black/20 p-3">
                      <p className="text-gray-500 dark:text-[#777]">Projected worst-case requests</p>
                      <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{capacityData.summary.projectedWorstNodeRequestMemoryPct.toFixed(1)}%</p>
                      <p className="text-gray-400 dark:text-[#666]">After this deploy</p>
                    </div>
                    <div className="rounded-xl bg-black/20 p-3">
                      <p className="text-gray-500 dark:text-[#777]">Game Hub request budget</p>
                      <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{formatBytesGi(capacityData.gameHubUsage.requestedMemoryBytes)}</p>
                      <p className="text-gray-400 dark:text-[#666]">of {formatBytesGi(capacityData.gameHubUsage.quota.requestsMemoryBytes)}</p>
                    </div>
                  </div>
                  {capacityData.summary.maxUsageMemoryPct != null ? (
                    <p className="mt-3 text-xs text-gray-500 dark:text-[#777]">Observed node memory usage is {capacityData.summary.maxUsageMemoryPct.toFixed(1)}%.</p>
                  ) : null}
                  {capacityData.warnings.length > 0 ? (
                    <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-amber-200">
                      {capacityData.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => setStep(2)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
                <button
                  onClick={() => setStep(4)}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0078D4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#006cbe]"
                >
                  Review <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {step === 4 && activeEgg && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Review and deploy</h2>
                <p className="text-sm text-gray-500 dark:text-[#777]">Double-check the server settings before creating Kubernetes resources.</p>
              </div>

              {capacityData && !capacityData.canSafelyDeploy ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
                  <p className="font-medium">⚠ Cluster memory pressure is already high.</p>
                  <p className="mt-1 text-xs text-amber-200">Projected worst-case node requests: {capacityData.summary.projectedWorstNodeRequestMemoryPct.toFixed(1)}% • current node limits: {capacityData.summary.maxLimitMemoryPct.toFixed(1)}%</p>
                </div>
              ) : null}

              <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Deployment summary</h3>
                  <dl className="mt-4 space-y-3 text-sm">
                    {summaryRows.map((row) => (
                      <div key={row.label} className="flex flex-col gap-1 border-b border-[#1d1d1d] pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                        <dt className="text-gray-500 dark:text-[#777]">{row.label}</dt>
                        <dd className="font-medium text-gray-900 dark:text-[#f2f2f2] sm:text-right">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <div className="space-y-4 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Environment variables</h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">{activeEgg.environment.filter((v) => v.userViewable !== false).length} variable{activeEgg.environment.length === 1 ? "" : "s"} will be applied.</p>
                  </div>
                  <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                    {activeEgg.environment.filter((v) => v.userViewable !== false).length === 0 ? (
                      <div className="rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] p-4 text-sm text-gray-400 dark:text-[#666]">No custom environment variables.</div>
                    ) : (
                      activeEgg.environment.filter((v) => v.userViewable !== false).map((variable) => (
                        <div key={variable.name} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-mono text-xs text-[#7cc4ff]">{variable.name}</p>
                            {variable.required ? <span className="text-[10px] uppercase tracking-[0.2em] text-red-300">required</span> : null}
                          </div>
                          <p className="mt-2 break-all text-sm text-gray-900 dark:text-[#f2f2f2]">{(envValues[variable.name] ?? variable.defaultValue) || "<empty>"}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {deployedServerName ? (
                <div className="flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/10 p-4 text-green-200">
                  <CheckCircle2 className="h-5 w-5" /> Deployment started for {deployedServerName}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => setStep(3)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
                <button
                  onClick={() => void deployServer()}
                  disabled={deploying}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-gray-900 dark:text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    capacityData && !capacityData.canSafelyDeploy ? "bg-amber-600 hover:bg-amber-500" : "bg-green-600 hover:bg-green-500"
                  )}
                >
                  {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCrash className="h-4 w-4" />}
                  {capacityData && !capacityData.canSafelyDeploy ? "Deploy Anyway" : "Deploy Server"}
                </button>
              </div>
              {capacityData && !capacityData.canSafelyDeploy ? (
                <p className="text-xs text-amber-200">This does not block deployment, but it signals elevated outage risk unless node pressure is reduced first.</p>
              ) : null}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
