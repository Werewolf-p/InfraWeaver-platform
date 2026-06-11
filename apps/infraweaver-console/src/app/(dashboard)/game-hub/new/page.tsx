"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, Gamepad2, Loader2, Search, CheckCircle2,
  ChevronDown, Download, Upload, Dices, Terminal, Rocket, Save,
  XCircle, AlertCircle, Users, Bookmark, CheckCheck, Server, Cpu, MemoryStick, HardDrive,
} from "lucide-react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { InfoPopover } from "@/components/game-hub/info-popover";
import { BUILT_IN_EGGS, type GameEgg, validateEggVariable, describeEggVariableRules } from "@/lib/game-eggs";
import { INTERNAL_DNS_DOMAIN, ROOT_DNS_DOMAIN } from "@/lib/dns";
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

function parseNodeMemoryToMi(value: string | undefined | null) {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return 0;
  const numeric = Number.parseFloat(trimmed.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  if (trimmed.endsWith("ti") || trimmed.endsWith("t")) return Math.round(numeric * 1024 * 1024);
  if (trimmed.endsWith("gi") || trimmed.endsWith("g")) return Math.round(numeric * 1024);
  if (trimmed.endsWith("ki") || trimmed.endsWith("k")) return Math.round(numeric / 1024);
  return Math.round(numeric);
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

function parseNodeCpuToCores(value: string | undefined | null) {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return 0;
  if (trimmed.endsWith("m")) return (Number.parseInt(trimmed.slice(0, -1), 10) || 0) / 1000;
  return Number.parseFloat(trimmed) || 0;
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
  allocatableCpu: number;
  allocatableMemoryBytes: number;
  requestedCpu: number;
  requestedMemoryBytes: number;
  limitsCpu: number;
  limitsMemoryBytes: number;
  usageCpu: number | null;
  usageMemoryBytes: number | null;
  requestCpuPct: number;
  requestMemoryPct: number;
  limitCpuPct: number;
  limitMemoryPct: number;
  usageCpuPct: number | null;
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

type ClusterNode = {
  name: string;
  status: string;
  roles: string[];
  cpu?: string;
  memory?: string;
};

function formatBytesGi(bytes: number | null | undefined) {
  if (!bytes) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} Gi`;
}

// ─── Storage class metadata ─────────────────────────────────────────────────
// Maps storage class names to human-readable explanations shown in the wizard.
type StorageClassMeta = {
  icon: string;
  tagline: string;
  badges: string[];
  description: string;
  recommended?: boolean;
};
const STORAGE_CLASS_META: Record<string, StorageClassMeta> = {
  "local-path": {
    icon: "💾",
    tagline: "Fastest — data lives on one node's disk",
    badges: ["⚡ Fastest I/O", "1 copy", "🗑️ Deleted on removal"],
    description:
      "Stored directly on the node hosting your server — zero network overhead means the best possible disk speed. If the node goes down or you delete the server, the data is gone. Best for testing or throwaway worlds.",
  },
  "local-path-retain": {
    icon: "💾",
    tagline: "Fast local disk, data survives deletion",
    badges: ["⚡ Fastest I/O", "1 copy", "🔒 Kept on removal"],
    description:
      "Same speed as local-path but the volume is NOT deleted when you remove the server. Your world files stay until you manually clean them up — great safety net for local storage.",
  },
  longhorn: {
    icon: "📦",
    tagline: "Network storage replicated to 2 nodes",
    badges: ["🔄 Network I/O", "2 copies", "🗑️ Deleted on removal"],
    description:
      "Longhorn copies data across 2 nodes over the network. If one node goes offline your data survives. Volume is deleted when you remove the server. Good all-rounder for apps you care about but don't need to keep forever.",
  },
  "longhorn-game": {
    icon: "🎮",
    tagline: "Game-optimised: fast I/O + worlds survive deletion",
    badges: ["⚡ Local speed", "1 copy", "🔒 Kept on removal"],
    description:
      "Longhorn with strict-local placement — the replica lives on the same node as your server pod, giving you local-disk read/write speed while still using Longhorn snapshots and backups. Volume survives server deletion so your world is always safe. The best choice for most game servers.",
    recommended: true,
  },
  "longhorn-retain": {
    icon: "🛡️",
    tagline: "Max safety: redundant across nodes + persists",
    badges: ["🔄 Network I/O", "2 copies", "🔒 Kept on removal"],
    description:
      "Two network copies on different nodes AND the volume is kept after server deletion. Slowest option because of replication overhead. Use this for important application data where you need both redundancy and long-term persistence.",
  },
  "longhorn-static": {
    icon: "🔧",
    tagline: "Pre-provisioned volumes — infrastructure use",
    badges: ["🔄 Network I/O", "2 copies", "🗑️ Deleted on removal"],
    description:
      "Used for statically pre-provisioned volumes managed by ArgoCD or other infrastructure tooling. Not intended for game servers — only choose this if you already have a manually created PersistentVolume waiting.",
  },
};

function getStorageClassMeta(name: string): StorageClassMeta {
  return (
    STORAGE_CLASS_META[name] ?? {
      icon: "🗂️",
      tagline: name,
      badges: [],
      description: "No description available for this storage class.",
    }
  );
}

// ─── Game resource hints ────────────────────────────────────────────────────
type ResourceHint = { memory: string; cpu: string; storage: string };
const GAME_RESOURCE_HINTS: Record<string, ResourceHint> = {
  "minecraft-java": {
    memory: "2–4 Gi for vanilla, 4–8 Gi for modpacks or 20+ players",
    cpu: "2 cores for small servers, 4 for modded",
    storage: "10 Gi to start — worlds can grow to 20 Gi+ over time",
  },
  terraria: {
    memory: "1–2 Gi — large worlds or mods may need more",
    cpu: "1 core is usually enough",
    storage: "5–10 Gi — world files are small",
  },
  tshock: {
    memory: "1–2 Gi — large worlds or mods may need more",
    cpu: "1 core is usually enough",
    storage: "5–10 Gi — world files are small",
  },
  valheim: {
    memory: "4 Gi minimum, 6 Gi+ for many players",
    cpu: "2–4 cores recommended",
    storage: "10–20 Gi for world files and backups",
  },
  satisfactory: {
    memory: "6–12 Gi — scales with map size",
    cpu: "4 cores recommended",
    storage: "10–20 Gi",
  },
  palworld: {
    memory: "8–16 Gi — hungry game engine",
    cpu: "4 cores minimum",
    storage: "20–50 Gi for save files",
  },
  rust: {
    memory: "6–12 Gi depending on map size",
    cpu: "4+ cores for stable tick rate",
    storage: "20 Gi — maps are large",
  },
  ark: {
    memory: "8–16 Gi for a smooth experience",
    cpu: "4+ cores",
    storage: "30–50 Gi — save files are very large",
  },
  cs2: {
    memory: "2–4 Gi",
    cpu: "2–4 cores",
    storage: "15 Gi",
  },
  factorio: {
    memory: "2–4 Gi — scales with factory complexity",
    cpu: "2 cores recommended",
    storage: "5–10 Gi",
  },
};

function getResourceHint(egg: GameEgg | null): ResourceHint | null {
  if (!egg) return null;
  return GAME_RESOURCE_HINTS[egg.id] ?? null;
}

// ─── Fun server name generator ───────────────────────────────────────────────
const NAME_ADJECTIVES = [
  "emerald", "cosmic", "thunder", "jade", "iron", "silver", "blazing", "mystic",
  "nether", "golden", "crystal", "shadow", "storm", "frozen", "lunar", "ancient",
  "blazing", "cobalt", "volcanic", "obsidian", "radiant", "twilight",
];
const NAME_NOUNS = [
  "dragon", "fortress", "realm", "citadel", "haven", "bastion", "forge", "valley",
  "keep", "nexus", "peak", "grove", "hollow", "anvil", "vault", "sanctum", "hollow",
];

function generateFunName(): string {
  const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${adj}-${noun}-${num}`;
}

// ─── Resource presets ────────────────────────────────────────────────────────
type ResourcePreset = { id: string; label: string; emoji: string; memory: number; cpu: number; storage: number; description: string };
const RESOURCE_PRESETS: ResourcePreset[] = [
  { id: "lite",     label: "Lite",     emoji: "🌱", memory: 1024, cpu: 0.5, storage: 5,  description: "1–4 players, low-spec or testing" },
  { id: "standard", label: "Standard", emoji: "⚡", memory: 2048, cpu: 1,   storage: 10, description: "5–10 players, everyday use" },
  { id: "power",    label: "Power",    emoji: "🔥", memory: 4096, cpu: 2,   storage: 20, description: "10–20 players or modded" },
  { id: "beast",    label: "Beast",    emoji: "👑", memory: 8192, cpu: 4,   storage: 40, description: "20+ players or heavy modpacks" },
];

// ─── Export/import config schema version ────────────────────────────────────
const CONFIG_VERSION = 1;

type WizardConfig = {
  version: typeof CONFIG_VERSION;
  exportedAt: string;
  eggSource: "built-in" | "pelican";
  eggId: string | null;
  eggName: string | null;
  eggPath: string | null;
  serverName: string;
  dnsType: "internal" | "public" | "custom";
  dnsHostname: string;
  envValues: Record<string, string>;
  memoryMi: number;
  cpuCores: number;
  storageGi: number;
  storageClass: string;
  dockerImage: string | null;
  eulaAccepted: boolean;
  targetNode: string | null;
};

type SavedPreset = WizardConfig & { presetName: string };
const PRESETS_STORAGE_KEY = "infraweaver-game-server-presets";
const DRAFT_STORAGE_KEY  = "infraweaver-game-server-draft";

// ─── Installation log entry ──────────────────────────────────────────────────
type InstallLogEntry = { ts: string; kind: "event" | "info" | "error"; message: string };
type InstallPhase = "idle" | "deploying" | "running" | "error";

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
  const [dnsType, setDnsType] = useState<"internal" | "public" | "custom">("internal");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [memoryMi, setMemoryMi] = useState(2048);
  const [cpuCores, setCpuCores] = useState(1);
  const [storageGi, setStorageGi] = useState(10);
  const [storageClass, setStorageClass] = useState("");
  const [targetNode, setTargetNode] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployedServerName, setDeployedServerName] = useState<string | null>(null);
  const [selectedDockerImage, setSelectedDockerImage] = useState<string | null>(null);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [envErrors, setEnvErrors] = useState<Record<string, string>>({});
  const [overriddenVars, setOverriddenVars] = useState<Set<string>>(new Set());
  // Which storage class card has its description expanded (null = use selected class)
  const [expandedStorageInfo, setExpandedStorageInfo] = useState<string | null>(null);
  // Installation console
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installLog, setInstallLog] = useState<InstallLogEntry[]>([]);
  const installLogRef = useRef<HTMLDivElement>(null);
  // Import file input ref
  const importRef = useRef<HTMLInputElement>(null);
  // Server name availability (null = unchecked, true = taken)
  const [serverNameTaken, setServerNameTaken] = useState<boolean | null>(null);
  // Saved presets loaded from localStorage
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>([]);
  const [draftRestored, setDraftRestored] = useState(false);

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

  const { data: clusterNodesData } = useQuery({
    queryKey: ["cluster", "nodes"],
    enabled: step >= 3,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/cluster/nodes");
      if (!response.ok) throw new Error("Failed to load cluster nodes");
      return response.json() as Promise<{ nodes: ClusterNode[] }>;
    },
  });

  // Server list for clone feature + name availability check
  const { data: serverListData } = useQuery({
    queryKey: ["game-hub", "servers-list"],
    queryFn: async () => {
      const response = await fetch("/api/game-hub/servers");
      if (!response.ok) return { servers: [] };
      return response.json() as Promise<{ servers: Array<{ name: string; gameType: string; status: string }> }>;
    },
    staleTime: 60_000,
  });

  // Install-console polling — only active while deploying
  const [installPollData, setInstallPollData] = useState<{ status: string; podPhase: string | null } | null>(null);
  useEffect(() => {
    if (installPhase !== "deploying" || !deployedServerName) return;
    let alive = true;
    const pollStatus = async () => {
      try {
        const r = await fetch(`/api/game-hub/servers/${deployedServerName}`);
        if (!r.ok) return;
        const d = await r.json() as { status: string; podPhase: string | null };
        if (alive) setInstallPollData(d);
        if (d.status === "running") { if (alive) setInstallPhase("running"); }
        else if (d.podPhase === "Failed") { if (alive) setInstallPhase("error"); }
      } catch {}
    };
    const pollEvents = async () => {
      try {
        const r = await fetch(`/api/game-hub/servers/${deployedServerName}/events`);
        if (!r.ok) return;
        const d = await r.json() as { events: Array<{ type: string; reason: string; message: string; timestamp: string | null }> };
        if (!alive) return;
        setInstallLog((prev) => {
          const existingMsgs = new Set(prev.map((e) => e.message));
          const newEntries: InstallLogEntry[] = (d.events ?? [])
            .filter((ev) => !existingMsgs.has(ev.message))
            .map((ev) => ({
              ts: ev.timestamp ?? new Date().toISOString(),
              kind: ev.type === "Warning" ? "error" : "event",
              message: `[${ev.reason}] ${ev.message}`,
            }));
          return newEntries.length ? [...prev, ...newEntries].slice(-60) : prev;
        });
      } catch {}
    };
    // Auto-scroll install log
    if (installLogRef.current) installLogRef.current.scrollTop = installLogRef.current.scrollHeight;
    const id1 = setInterval(() => { void pollStatus(); void pollEvents(); }, 3000);
    void pollStatus();
    void pollEvents();
    return () => { alive = false; clearInterval(id1); };
  }, [installPhase, deployedServerName]);

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
      const preferred = storageClasses.find((sc) => sc.name === "longhorn-game") ?? storageClasses.find((sc) => sc.isDefault) ?? storageClasses[0];
      setStorageClass(preferred.name);
    }
  }, [storageClasses.map((sc) => sc.name).join(",")]); // dep on names string to avoid object ref changes
  const activeEgg = sourceTab === "built-in"
    ? BUILT_IN_EGGS.find((egg) => egg.id === selectedBuiltInId) ?? null
    : remoteEggData?.egg ?? null;
  const activeEggKey = sourceTab === "built-in" ? selectedBuiltInId : selectedRemoteEntry?.id ?? null;
  const clusterNodes = clusterNodesData?.nodes ?? [];
  const highestPressureNode = capacityData?.nodes.reduce<GameHubCapacityNode | null>((worst, node) => {
    if (!node.ready) return worst;
    if (!worst || node.requestMemoryPct > worst.requestMemoryPct) return node;
    return worst;
  }, null) ?? null;
  const selectedClusterNode = targetNode ? clusterNodes.find((node) => node.name === targetNode) ?? null : null;
  const selectedCapacityNode = targetNode ? capacityData?.nodes.find((node) => node.name === targetNode) ?? null : null;
  const selectedNodeMemoryMi = parseNodeMemoryToMi(selectedClusterNode?.memory);
  const selectedNodeCpuCores = parseNodeCpuToCores(selectedClusterNode?.cpu);
  const selectedNodeProjectedMemoryPct = selectedCapacityNode?.allocatableMemoryBytes
    ? ((selectedCapacityNode.requestedMemoryBytes + (memoryMi * 1024 * 1024)) / selectedCapacityNode.allocatableMemoryBytes) * 100
    : null;
  const selectedNodeProjectedCpuPct = selectedCapacityNode?.allocatableCpu
    ? ((selectedCapacityNode.requestedCpu + cpuCores) / selectedCapacityNode.allocatableCpu) * 100
    : null;

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
    setOverriddenVars(new Set());
  }, [activeEggKey]); // intentionally omitting activeEgg — key change implies egg change

  useEffect(() => {
    if (dnsType === "custom") return; // let the user type freely
    const normalized = normalizeServerName(serverName);
    if (dnsType === "internal") {
      setDnsHostname(normalized ? `${normalized}.games.${INTERNAL_DNS_DOMAIN}` : "");
    } else {
      setDnsHostname(normalized ? `${normalized}.games.${ROOT_DNS_DOMAIN}` : "");
    }
  }, [dnsType, serverName]);

  useEffect(() => {
    if (!targetNode || clusterNodes.length === 0) return;
    if (!clusterNodes.some((node) => node.name === targetNode)) {
      setTargetNode("");
    }
  }, [clusterNodes, targetNode]);

  // ─── Load saved presets from localStorage on mount ────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (raw) setSavedPresets(JSON.parse(raw) as SavedPreset[]);
    } catch {}
    // Also restore draft if nothing has been configured yet
    try {
      const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (draft && !draftRestored) {
        const d = JSON.parse(draft) as Partial<WizardConfig>;
        if (d.serverName) setServerName(d.serverName);
        if (d.dnsType) setDnsType(d.dnsType);
        if (d.dnsHostname) setDnsHostname(d.dnsHostname);
        if (d.envValues) setEnvValues(d.envValues);
        if (d.memoryMi) setMemoryMi(d.memoryMi);
        if (d.cpuCores) setCpuCores(d.cpuCores);
        if (d.storageGi) setStorageGi(d.storageGi);
        if (d.storageClass) setStorageClass(d.storageClass);
        setTargetNode(d.targetNode ?? "");
        if (d.dockerImage) setSelectedDockerImage(d.dockerImage);
        setDraftRestored(true);
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Auto-save wizard draft to localStorage ──────────────────────────────
  useEffect(() => {
    if (!serverName && !activeEgg) return;
    const draft: Partial<WizardConfig> = {
      serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores, storageGi,
      storageClass, dockerImage: selectedDockerImage, eulaAccepted, targetNode: targetNode || null,
    };
    try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch {}
  }, [serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores, storageGi, storageClass, selectedDockerImage, eulaAccepted, targetNode, activeEgg]);

  // ─── Debounced server name availability check ────────────────────────────
  const normalizedName = normalizeServerName(serverName);
  useEffect(() => {
    if (!normalizedName || !serverListData?.servers) { setServerNameTaken(null); return; }
    const id = setTimeout(() => {
      const taken = serverListData.servers.some((s) => s.name === normalizedName);
      setServerNameTaken(taken);
    }, 500);
    return () => clearTimeout(id);
  }, [normalizedName, serverListData]);

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
  // A required field is "missing" when it has no value AND no default to fall back on.
  // Read-only fields that have a default are never considered missing — they will deploy
  // with their default (or overridden) value even if the user didn't touch them.
  const requiredEnvMissing = activeEgg?.environment
    .filter((entry) => entry.userViewable !== false)
    .some((entry) => {
      if (!entry.required) return false;
      const currentValue = (envValues[entry.name] ?? entry.defaultValue ?? "").trim();
      if (currentValue) return false; // has a value — fine
      // Field has no value. Read-only fields with a non-empty default are already
      // initialised above; only user-editable (or overridden) empty fields block.
      const isLocked = entry.userEditable === false && !overriddenVars.has(entry.name);
      if (isLocked) return false; // locked + no default → deploy empty (egg handles it)
      return true; // editable + empty + required → must fill in
    });
  // Build a list of empty required editable fields so we can show a helpful hint
  const emptyRequiredFields = activeEgg?.environment
    .filter((entry) => entry.userViewable !== false && entry.required)
    .filter((entry) => {
      const val = (envValues[entry.name] ?? entry.defaultValue ?? "").trim();
      if (val) return false;
      const isLocked = entry.userEditable === false && !overriddenVars.has(entry.name);
      return !isLocked;
    }) ?? [];
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
        nodeSelector: targetNode ? { "kubernetes.io/hostname": targetNode } : undefined,
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
      // Transition to install console instead of redirecting immediately
      setInstallPhase("deploying");
      setInstallLog([{ ts: new Date().toISOString(), kind: "info", message: "Kubernetes resources submitted — waiting for pod to start..." }]);
      // Clear the auto-saved draft now that we've deployed
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeploying(false);
    }
  }

  // ─── Export current config as .iwconfig.json ───────────────────────────────
  const exportConfig = useCallback(() => {
    if (!activeEgg) return;
    const config: WizardConfig = {
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      eggSource: sourceTab,
      eggId: selectedBuiltInId ?? selectedRemoteEntry?.id ?? null,
      eggName: activeEgg.name,
      eggPath: selectedRemoteEntry?.path ?? null,
      serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores,
      storageGi, storageClass, dockerImage: selectedDockerImage, eulaAccepted, targetNode: targetNode || null,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${normalizeServerName(serverName) || "server"}-config.iwconfig.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeEgg, sourceTab, selectedBuiltInId, selectedRemoteEntry, serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores, storageGi, storageClass, selectedDockerImage, eulaAccepted, targetNode]);

  // ─── Import config from .iwconfig.json ────────────────────────────────────
  const handleImportConfig = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const cfg = JSON.parse(ev.target?.result as string) as WizardConfig;
        if (cfg.version !== CONFIG_VERSION) throw new Error("Unrecognised config version");
        if (cfg.serverName) setServerName(cfg.serverName);
        if (cfg.dnsType) setDnsType(cfg.dnsType);
        if (cfg.dnsHostname) setDnsHostname(cfg.dnsHostname);
        if (cfg.envValues) setEnvValues(cfg.envValues);
        if (cfg.memoryMi) setMemoryMi(cfg.memoryMi);
        if (cfg.cpuCores) setCpuCores(cfg.cpuCores);
        if (cfg.storageGi) setStorageGi(cfg.storageGi);
        if (cfg.storageClass) setStorageClass(cfg.storageClass);
        setTargetNode(cfg.targetNode ?? "");
        if (cfg.dockerImage) setSelectedDockerImage(cfg.dockerImage);
        if (cfg.eulaAccepted) setEulaAccepted(cfg.eulaAccepted);
        if (cfg.eggSource === "built-in" && cfg.eggId) {
          const egg = BUILT_IN_EGGS.find((eg) => eg.id === cfg.eggId);
          if (egg) { setSourceTab("built-in"); setSelectedBuiltInId(egg.id); setSelectedRemoteEntry(null); }
        }
        toast.success("Config imported — check the settings below");
        setStep(2);
      } catch (err) {
        toast.error("Failed to import config: " + (err instanceof Error ? err.message : "Invalid file"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  // ─── Save current config as a named preset ────────────────────────────────
  const savePreset = useCallback((presetName: string) => {
    if (!activeEgg || !presetName.trim()) return;
    const preset: SavedPreset = {
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      presetName: presetName.trim(),
      eggSource: sourceTab,
      eggId: selectedBuiltInId ?? selectedRemoteEntry?.id ?? null,
      eggName: activeEgg.name,
      eggPath: selectedRemoteEntry?.path ?? null,
      serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores,
      storageGi, storageClass, dockerImage: selectedDockerImage, eulaAccepted, targetNode: targetNode || null,
    };
    setSavedPresets((prev) => {
      const updated = [preset, ...prev.filter((p) => p.presetName !== presetName.trim())].slice(0, 10);
      try { localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
    toast.success(`Preset "${presetName.trim()}" saved`);
  }, [activeEgg, sourceTab, selectedBuiltInId, selectedRemoteEntry, serverName, dnsType, dnsHostname, envValues, memoryMi, cpuCores, storageGi, storageClass, selectedDockerImage, eulaAccepted, targetNode]);

  const deletePreset = useCallback((presetName: string) => {
    setSavedPresets((prev) => {
      const updated = prev.filter((p) => p.presetName !== presetName);
      try { localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const loadPreset = useCallback((preset: SavedPreset) => {
    if (preset.serverName) setServerName(preset.serverName);
    if (preset.dnsType) setDnsType(preset.dnsType);
    if (preset.dnsHostname) setDnsHostname(preset.dnsHostname);
    if (preset.envValues) setEnvValues(preset.envValues);
    if (preset.memoryMi) setMemoryMi(preset.memoryMi);
    if (preset.cpuCores) setCpuCores(preset.cpuCores);
    if (preset.storageGi) setStorageGi(preset.storageGi);
    if (preset.storageClass) setStorageClass(preset.storageClass);
    setTargetNode(preset.targetNode ?? "");
    if (preset.dockerImage) setSelectedDockerImage(preset.dockerImage);
    if (preset.eulaAccepted) setEulaAccepted(preset.eulaAccepted);
    if (preset.eggSource === "built-in" && preset.eggId) {
      const egg = BUILT_IN_EGGS.find((eg) => eg.id === preset.eggId);
      if (egg) { setSourceTab("built-in"); setSelectedBuiltInId(egg.id); setSelectedRemoteEntry(null); }
    }
    toast.success(`Preset "${preset.presetName}" loaded`);
    setStep(2);
  }, []);

  const summaryRows = [
    { label: "Egg Source", value: sourceTab === "built-in" ? "Built-in library" : "Pelican catalog" },
    { label: "Selected Egg", value: activeEgg?.name ?? "—" },
    { label: "Docker Image", value: selectedDockerImage ?? activeEgg?.dockerImage ?? "—" },
    { label: "Server Name", value: normalizeServerName(serverName) || "—" },
    { label: "DNS Hostname", value: dnsHostname || "Auto-generated" },
    { label: "Memory", value: formatMemory(memoryMi) },
    { label: "CPU", value: `${formatCpu(cpuCores)} cores` },
    { label: "Storage", value: `${storageGi}Gi (${storageClass})` },
    { label: "Target Node", value: targetNode ? `${targetNode} (nodeSelector kubernetes.io/hostname)` : "Any node / scheduler decides" },
    { label: "Pod resources", value: `${formatMemory(memoryMi)} request/limit • ${formatCpu(cpuCores)} CPU request/limit` },
    { label: "Priority Class", value: "game-server" },
    { label: "Rollout Strategy", value: "Recreate" },
    { label: "Game Port", value: activeEgg ? `${activeEgg.gamePort}/${activeEgg.protocol ?? "TCP"}` : "—" },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <input ref={importRef} type="file" accept=".json,.iwconfig.json" className="hidden" onChange={handleImportConfig} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/game-hub" className="inline-flex min-h-[44px] items-center text-sm font-medium text-[#4db3ff] transition-colors hover:text-[#7cc4ff]">← Back</Link>
          <div className="hidden h-6 w-px bg-gray-200 dark:bg-[#2a2a2a] sm:block" />
          <div className="flex min-w-0 items-center gap-2">
            <Gamepad2 className="h-5 w-5 shrink-0 text-[#0078D4] dark:text-[#4db3ff]" />
            <h1 className="truncate text-2xl font-semibold text-gray-900 dark:text-[#f2f2f2]">New Game Server</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => importRef.current?.click()}
            title="Import config (.iwconfig.json)"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white"
          >
            <Upload className="h-4 w-4" /> Import
          </button>
          {activeEgg && (
            <button
              onClick={exportConfig}
              title="Export current config as .iwconfig.json"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white"
            >
              <Download className="h-4 w-4" /> Export
            </button>
          )}
        </div>
      </div>

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
              {/* ─── Saved presets quick-launch ─── */}
              {savedPresets.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Bookmark className="h-4 w-4 text-[#0078D4]" />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Saved presets</h3>
                    <span className="rounded-full bg-[#0078D4]/15 px-2 py-0.5 text-xs text-[#7cc4ff]">{savedPresets.length}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {savedPresets.map((preset) => (
                      <div key={preset.presetName} className="group flex items-center justify-between gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2.5">
                        <button onClick={() => loadPreset(preset)} className="flex items-center gap-2 text-left flex-1 min-w-0">
                          <Rocket className="h-4 w-4 shrink-0 text-[#0078D4]" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{preset.presetName}</p>
                            <p className="truncate text-xs text-gray-400 dark:text-[#666]">{preset.eggName} · {formatMemory(preset.memoryMi)} · {preset.cpuCores}c</p>
                          </div>
                        </button>
                        <button onClick={() => deletePreset(preset.presetName)} className="shrink-0 opacity-0 group-hover:opacity-100 rounded p-1 transition-opacity hover:text-red-400">
                          <XCircle className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* ─── Clone from existing server ─── */}
              {(serverListData?.servers?.length ?? 0) > 0 && (
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2.5">
                  <Users className="h-4 w-4 shrink-0 text-[#666]" />
                  <span className="text-sm text-gray-500 dark:text-[#777] whitespace-nowrap">Clone from:</span>
                  <select
                    className="relative z-[100] min-h-[48px] flex-1 cursor-pointer rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                    onChange={(e) => {
                      const name = e.target.value;
                      if (!name) return;
                      e.target.value = "";
                      toast.success(`Open the server "${name}" page and use Export to get its config`);
                    }}
                    defaultValue=""
                  >
                    <option value="" disabled>choose a server to copy its settings…</option>
                    {serverListData?.servers.map((s) => (
                      <option key={s.name} value={s.name}>{s.name} ({s.gameType})</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Choose an egg</h2>
                    <HelpTooltip>
                      An <strong>egg</strong> is a pre-built server template from the Pelican / Pterodactyl ecosystem. It bundles the Docker image, startup script, and environment variables needed to run a specific game or service. Pick one and the wizard fills in the rest automatically.
                    </HelpTooltip>
                  </div>
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
                    <div className="flex items-center gap-1.5">
                      <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{activeEgg?.name ?? selectedRemoteEntry?.name ?? "Loading egg..."}</p>
                      <InfoPopover title="What is an egg?" align="start">
                        <p>An <strong>egg</strong> is a ready-made recipe for a game server. It bundles the right Docker image, startup command, and the configuration variables a game needs — so you don&apos;t have to wire any of that up by hand.</p>
                        <p>Pick an egg and the wizard pre-fills sensible defaults; you just adjust a few options below.</p>
                      </InfoPopover>
                    </div>
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
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Server Name</label>
                        <HelpTooltip>
                          Becomes the Kubernetes resource name — lowercase letters, numbers, and hyphens only. Must be unique across all game servers. Spaces and special characters are converted automatically.
                        </HelpTooltip>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={serverName}
                          onChange={(event) => { setServerName(event.target.value); setServerNameTaken(null); }}
                          placeholder="my-server"
                          className={cn(
                            "flex-1 rounded-xl border bg-white dark:bg-[#111] px-4 py-3 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50",
                            serverNameTaken ? "border-red-500/60" : "border-gray-200 dark:border-[#2a2a2a]"
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => { setServerName(generateFunName()); setServerNameTaken(null); }}
                          title="Generate a random server name"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-400 transition-colors hover:text-[#0078D4] hover:border-[#0078D4]/40"
                        >
                          <Dices className="h-4 w-4" />
                        </button>
                      </div>
                      {serverNameTaken ? (
                        <p className="flex items-center gap-1.5 text-xs text-red-400"><AlertCircle className="h-3 w-3" /> Name already in use — choose a different one.</p>
                      ) : (
                        <p className="text-xs text-gray-400 dark:text-[#666]">The deployed Kubernetes resource will use <span className="font-mono text-[#7cc4ff]">{normalizeServerName(serverName) || "your-server-name"}</span>. Hit <Dices className="inline h-3 w-3 mx-0.5" /> for a random name.</p>
                      )}
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">DNS Hostname</label>
                        <HelpTooltip>
                          Controls how players connect to the server. Choose Internal for private use (VPN only), Public for internet access, or Custom to use your own domain.
                        </HelpTooltip>
                      </div>
                      {/* DNS type toggle — each option has an inline hint */}
                      <div className="space-y-2">
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
                        {/* Contextual hint per DNS type */}
                        <div className="rounded-xl border border-gray-100 dark:border-[#1e1e1e] bg-gray-50 dark:bg-[#0d0d0d] px-3 py-2 text-xs text-gray-500 dark:text-[#777]">
                          {dnsType === "internal" && (
                            <span>🔒 <strong>Private (VPN only)</strong> — only people connected to NetBird VPN can reach this server. Good for personal or friends-only play.</span>
                          )}
                          {dnsType === "public" && (
                            <span>🌐 <strong>Public internet</strong> — creates a DNS entry at <code className="font-mono text-[#7cc4ff]">.games.{ROOT_DNS_DOMAIN}</code>. Anyone who knows the address can connect. Make sure your game has a password if needed.</span>
                          )}
                          {dnsType === "custom" && (
                            <span>✏️ <strong>Custom domain</strong> — you control the DNS record. Point your domain at the cluster IP yourself. Useful if you have an existing domain.</span>
                          )}
                        </div>
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
                      <>
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Server Variables</h3>
                        <InfoPopover title="Variables, defaults & Override">
                          <p>These come from the egg. Most are safe to edit, but some show a <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-[#1a1a1a] dark:text-[#777]">default</span> badge and are locked.</p>
                          <p>Locked variables are read-only because the egg author set them to a tested value (or the game requires it) — changing them can stop the server from starting.</p>
                          <p>Need to change one anyway? Click <span className="text-[#7cc4ff]">Override</span> to unlock the field, or <span className="text-gray-400 dark:text-[#666]">Reset</span> to restore the default.</p>
                        </InfoPopover>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        {activeEgg.environment.filter((v) => v.userViewable !== false).map((variable) => {
                          const fieldType = variable.fieldType ?? "text";
                          const label = variable.description.split(":")[0] || variable.name;
                          const helperText = variable.description;
                          const value = envValues[variable.name] ?? variable.defaultValue;
                          const rulesHint = describeEggVariableRules(variable.rules);
                          const error = envErrors[variable.name];
                          const isReadOnly = variable.userEditable === false;
                          const isOverriding = overriddenVars.has(variable.name);
                          const effectivelyEditable = !isReadOnly || isOverriding;
                          // Highlight empty required editable fields so users know what to fill in
                          const needsInput = variable.required && effectivelyEditable && !(value ?? "").trim();

                          return (
                            <div key={variable.name} className={cn(
                              "rounded-2xl border bg-white dark:bg-[#111] p-4",
                              error ? "border-red-500/40" :
                              needsInput ? "border-amber-500/40 bg-amber-50/30 dark:bg-amber-500/5" :
                              "border-gray-200 dark:border-[#2a2a2a]"
                            )}>
                              <div className="mb-3 flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <label className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">
                                      {label}
                                      {variable.required ? <span className="ml-1 text-red-400">*</span> : null}
                                    </label>
                                    {isReadOnly && !isOverriding && (
                                      <span className="rounded-full bg-gray-100 dark:bg-[#1a1a1a] px-2 py-0.5 text-[10px] text-gray-400 dark:text-[#666]">default</span>
                                    )}
                                    {isOverriding && (
                                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500">overriding</span>
                                    )}
                                  </div>
                                  <p className="mt-1 text-xs text-gray-500 dark:text-[#777]">{helperText}</p>
                                  {rulesHint && <p className="mt-0.5 text-[10px] text-gray-400 dark:text-[#555]">{rulesHint}</p>}
                                </div>
                                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                  <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-gray-500 dark:text-[#999]">{fieldType}</span>
                                  {isReadOnly && !isOverriding && (
                                    <button
                                      type="button"
                                      onClick={() => setOverriddenVars((prev) => { const s = new Set(prev); s.add(variable.name); return s; })}
                                      className="text-[10px] text-[#7cc4ff] hover:text-[#0078D4] transition-colors"
                                    >Override</button>
                                  )}
                                  {isOverriding && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOverriddenVars((prev) => { const s = new Set(prev); s.delete(variable.name); return s; });
                                        setEnvValues((prev) => ({ ...prev, [variable.name]: variable.defaultValue }));
                                        setEnvErrors((prev) => { const copy = { ...prev }; delete copy[variable.name]; return copy; });
                                      }}
                                      className="text-[10px] text-gray-400 dark:text-[#666] hover:text-red-400 transition-colors"
                                    >Reset</button>
                                  )}
                                </div>
                              </div>

                              {fieldType === "boolean" ? (
                                <ToggleSwitch
                                  checked={String(value).toLowerCase() === "true"}
                                  onChange={(checked) => setEnvValues((current) => ({ ...current, [variable.name]: checked ? "true" : "false" }))}
                                  label={variable.name}
                                  description="Toggle the boolean value"
                                  disabled={!effectivelyEditable}
                                />
                              ) : (
                                <input
                                  type={fieldType === "integer" ? "number" : /password|token|secret/i.test(variable.name) ? "password" : "text"}
                                  value={value}
                                  readOnly={!effectivelyEditable}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    setEnvValues((current) => ({ ...current, [variable.name]: next }));
                                    if (envErrors[variable.name]) {
                                      setEnvErrors((prev) => { const copy = { ...prev }; delete copy[variable.name]; return copy; });
                                    }
                                  }}
                                  onBlur={() => {
                                    const err = validateEggVariable(variable, value);
                                    if (err) setEnvErrors((prev) => ({ ...prev, [variable.name]: err }));
                                  }}
                                  placeholder={variable.defaultValue || `Enter ${label.toLowerCase()}`}
                                  className={cn(
                                    "w-full rounded-xl border px-3 py-2 text-sm outline-none transition-colors",
                                    !effectivelyEditable
                                      ? "bg-white dark:bg-[#0d0d0d] text-gray-400 dark:text-[#555] cursor-default select-none"
                                      : needsInput
                                        ? "bg-white dark:bg-[#0d0d0d] text-gray-900 dark:text-[#f2f2f2] focus:border-amber-500/50"
                                        : "bg-white dark:bg-[#0d0d0d] text-gray-900 dark:text-[#f2f2f2] focus:border-[#0078D4]/50",
                                    error ? "border-red-500/40" : needsInput ? "border-amber-500/30" : "border-gray-200 dark:border-[#2a2a2a]"
                                  )}
                                />
                              )}
                              {needsInput && !error && (
                                <p className="mt-1.5 text-[11px] text-amber-500">Required — please fill this in</p>
                              )}
                              {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
                            </div>
                          );
                        })}
                      </div>
                      </>
                    )}
                  </div>
                </>
              )}

              <div className="space-y-3 pt-4">
                {/* Show exactly which required fields still need input */}
                {emptyRequiredFields.length > 0 && (
                  <p className="text-center text-xs text-amber-500">
                    Fill in: {emptyRequiredFields.map((e) => e.description.split(":")[0] || e.name).join(", ")}
                  </p>
                )}
                {activeEgg && !serverName.trim() && (
                  <p className="text-center text-xs text-amber-500">Enter a server name to continue</p>
                )}
                <div className="flex items-center justify-between gap-3">
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
            </div>
          )}

          {step === 3 && activeEgg && (
            <div className="space-y-8">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Set resources</h2>
                <p className="text-sm text-gray-500 dark:text-[#777]">Tune the default memory, CPU, and storage before deployment.</p>
              </div>

              {/* ─── Resource presets (quick buttons) ──────────────────────── */}
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Quick presets</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RESOURCE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => { setMemoryMi(preset.memory); setCpuCores(preset.cpu); setStorageGi(preset.storage); }}
                      className={cn(
                        "rounded-xl border p-3 text-left transition-colors",
                        memoryMi === preset.memory && cpuCores === preset.cpu
                          ? "border-[#0078D4]/50 bg-[#0078D4]/10"
                          : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] hover:border-[#0078D4]/30"
                      )}
                    >
                      <div className="text-lg">{preset.emoji}</div>
                      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{preset.label}</p>
                      <p className="text-xs text-gray-400 dark:text-[#666]">{preset.description}</p>
                      <p className="mt-1 text-xs font-mono text-[#7cc4ff]">{formatMemory(preset.memory)} · {preset.cpu}c · {preset.storage}Gi</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Game-specific resource hint */}
              {getResourceHint(activeEgg) && (
                <div className="rounded-xl border border-[#0078D4]/20 bg-[#0078D4]/5 px-4 py-3 text-xs text-gray-500 dark:text-[#999] space-y-1">
                  <p className="font-semibold text-[#7cc4ff]">💡 Recommended for {activeEgg.name}</p>
                  <p>🧠 Memory: {getResourceHint(activeEgg)!.memory}</p>
                  <p>⚡ CPU: {getResourceHint(activeEgg)!.cpu}</p>
                  <p>💾 Storage: {getResourceHint(activeEgg)!.storage}</p>
                </div>
              )}

              <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-[#0078D4]" />
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Target Node</h3>
                    </div>
                    <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">Optional. Leave this on Any node and Kubernetes will schedule the server where it fits best.</p>
                  </div>
                  <span className={cn(
                    "inline-flex w-fit rounded-full px-3 py-1 text-xs font-medium",
                    targetNode ? "bg-[#0078D4]/15 text-[#7cc4ff]" : "bg-gray-100 text-gray-500 dark:bg-[#1a1a1a] dark:text-[#888]"
                  )}>
                    {targetNode ? "Pinned" : "Auto"}
                  </span>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
                  <select
                    value={targetNode}
                    onChange={(event) => setTargetNode(event.target.value)}
                    className="relative z-[100] min-h-[48px] w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors focus:border-[#0078D4]/50"
                  >
                    <option value="">Any node / cluster decides</option>
                    {clusterNodes.map((node) => (
                      <option key={node.name} value={node.name}>
                        {node.name} · {node.status}
                      </option>
                    ))}
                  </select>
                  <div className="rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] bg-gray-50/60 px-4 py-3 text-xs text-gray-500 dark:bg-[#0d0d0d] dark:text-[#888]">
                    {targetNode
                      ? <>Scheduling hint: <span className="font-mono text-[#7cc4ff]">nodeSelector kubernetes.io/hostname={targetNode}</span></>
                      : <>No node pinning — the Kubernetes scheduler will pick the best node automatically.</>}
                  </div>
                </div>
                {selectedClusterNode ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Status</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedClusterNode.status}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Roles</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedClusterNode.roles.join(", ") || "worker"}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Total capacity</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedClusterNode.cpu ?? "—"} CPU • {selectedClusterNode.memory ?? "—"}</p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:col-span-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Memory</p>
                      <HelpTooltip>
                        The RAM guaranteed to your server. Setting this too low causes lag or crashes — game servers load entire worlds into memory. Setting it higher than needed wastes cluster resources.
                      </HelpTooltip>
                    </div>
                    <div className="text-right">
                      {selectedClusterNode ? (
                        <p className="flex items-center justify-end gap-1 text-xs text-gray-500 dark:text-[#777]">
                          <MemoryStick className="h-3.5 w-3.5" />
                          Node total {selectedClusterNode.memory ?? "—"}
                          {selectedNodeMemoryMi > 0 ? ` • ${((memoryMi / selectedNodeMemoryMi) * 100).toFixed(1)}% request` : ""}
                        </p>
                      ) : null}
                      <span className="mt-1 inline-flex rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-1 text-sm font-medium text-[#7cc4ff]">{formatMemory(memoryMi)}</span>
                    </div>
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

                {/* Storage panel — spans 2 rows on large screens */}
                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:row-span-2">
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="h-4 w-4 text-[#0078D4]" />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Storage</h3>
                    <InfoPopover title="What is persistent storage?">
                      <p>Your server runs in a container that is wiped every time it restarts. A <strong>persistent volume (PVC)</strong> is a separate disk that <em>survives</em> restarts, updates, and crashes — it&apos;s where your worlds, configs, and save data live.</p>
                      <p><strong>Size</strong> is how much disk to reserve. Start modest (worlds are small) — Longhorn classes can be expanded later, but local-path cannot be resized.</p>
                    </InfoPopover>
                  </div>
                  <p className="mt-1 text-sm text-gray-500 dark:text-[#777]">5 Gi to 500 Gi</p>
                  <div className="mt-5 space-y-5">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Size (Gi)</label>
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
                      <div className="mb-3 flex items-center gap-1.5">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-[#666]">Storage Class</label>
                        <InfoPopover title="Which storage class?">
                          <p>The storage class decides <em>where</em> your data lives and what happens to it when the server is deleted. Expand any card below for full details.</p>
                          <ul className="space-y-1">
                            <li><strong>local-path</strong> (default) — node-local disk. Fast, but tied to one node and lost if that node dies.</li>
                            <li><strong>local-path-retain</strong> — same node-local disk, but the volume/data is kept after you delete the server.</li>
                            <li><strong>longhorn</strong> — replicated distributed storage. Survives node failure and supports migration &amp; backups.</li>
                            <li><strong>longhorn-game</strong> — recommended tuned default for game servers.</li>
                            <li><strong>longhorn-retain</strong> — replicated storage whose volume is kept after deletion.</li>
                            <li><strong>longhorn-static</strong> — pre-provisioned volumes for infrastructure use, not new game servers.</li>
                          </ul>
                          <p>Rule of thumb: pick <strong>longhorn-game</strong>. Use a <strong>-retain</strong> class if you want the data to outlive the server.</p>
                        </InfoPopover>
                      </div>
                      {/* Storage class card picker */}
                      <div className="space-y-2">
                        {storageClasses.map((entry) => {
                          const meta = getStorageClassMeta(entry.name);
                          const isSelected = storageClass === entry.name;
                          const isExpanded = expandedStorageInfo === entry.name;
                          return (
                            <div
                              key={entry.name}
                              className={cn(
                                "rounded-xl border transition-colors cursor-pointer",
                                isSelected
                                  ? "border-[#0078D4]/50 bg-[#0078D4]/8"
                                  : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] hover:border-[#0078D4]/30"
                              )}
                            >
                              {/* Card header row — click to select */}
                              <button
                                type="button"
                                onClick={() => setStorageClass(entry.name)}
                                className="w-full px-3 py-2.5 text-left"
                              >
                                <div className="flex items-start gap-2">
                                  <span className="mt-0.5 text-base leading-none">{meta.icon}</span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="text-xs font-semibold text-gray-900 dark:text-[#f2f2f2]">
                                        {entry.name}
                                      </span>
                                      {entry.isDefault && (
                                        <span className="rounded-full bg-gray-100 dark:bg-[#222] px-1.5 py-0.5 text-[9px] text-gray-500 dark:text-[#666]">default</span>
                                      )}
                                      {meta.recommended && (
                                        <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[9px] text-green-400">recommended</span>
                                      )}
                                    </div>
                                    <p className="mt-0.5 text-[11px] text-gray-500 dark:text-[#777] leading-snug">{meta.tagline}</p>
                                    {/* Mini badges */}
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                      {meta.badges.map((badge) => (
                                        <span key={badge} className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-1.5 py-0.5 text-[9px] text-gray-500 dark:text-[#777]">{badge}</span>
                                      ))}
                                    </div>
                                  </div>
                                  {isSelected && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0078D4]" />}
                                </div>
                              </button>
                              {/* Info expand toggle */}
                              <button
                                type="button"
                                onClick={() => setExpandedStorageInfo(isExpanded ? null : entry.name)}
                                className="flex w-full items-center gap-1 border-t border-gray-100 dark:border-[#1a1a1a] px-3 py-1.5 text-[10px] text-gray-400 dark:text-[#555] hover:text-gray-600 dark:hover:text-[#888] transition-colors"
                              >
                                <ChevronDown className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")} />
                                {isExpanded ? "Hide details" : "What does this mean?"}
                              </button>
                              {/* Expanded description */}
                              {isExpanded && (
                                <div className="px-3 pb-3 text-[11px] text-gray-500 dark:text-[#888] leading-relaxed border-t border-gray-100 dark:border-[#1a1a1a]">
                                  {meta.description}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-5 lg:col-span-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">CPU</p>
                      <HelpTooltip>
                        CPU cores available to your server. 1 core handles most small-medium servers. Add more if you see lag spikes or console warnings about high tick time. Kubernetes can share CPU across servers — a 1-core limit doesn&apos;t prevent brief bursts above that.
                      </HelpTooltip>
                    </div>
                    <div className="text-right">
                      {selectedClusterNode ? (
                        <p className="flex items-center justify-end gap-1 text-xs text-gray-500 dark:text-[#777]">
                          <Cpu className="h-3.5 w-3.5" />
                          Node total {selectedClusterNode.cpu ?? "—"} cores
                          {selectedNodeCpuCores > 0 ? ` • ${((cpuCores / selectedNodeCpuCores) * 100).toFixed(1)}% request` : ""}
                        </p>
                      ) : null}
                      <span className="mt-1 inline-flex rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-1 text-sm font-medium text-[#7cc4ff]">{formatCpu(cpuCores)} cores</span>
                    </div>
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
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{targetNode ? "Node capacity" : "Cluster capacity"}</h3>
                      <HelpTooltip>
                        Live scheduling context for this deployment. Choose a node to see that node&apos;s real CPU and memory headroom, or leave scheduling automatic to view the overall cluster picture.
                      </HelpTooltip>
                    </div>
                    <span className={cn(
                      "rounded-full px-2 py-1 text-[11px] font-medium",
                      capacityData.canSafelyDeploy ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-300"
                    )}>
                      {capacityData.canSafelyDeploy ? "Healthy" : "Tight"}
                    </span>
                  </div>
                  {targetNode && selectedCapacityNode ? (
                    <>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-xs">
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Current memory requests</p>
                            <HelpTooltip>This is the real requested memory already allocated on the selected node.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedCapacityNode.requestMemoryPct.toFixed(1)}%</p>
                          <p className="text-gray-400 dark:text-[#666]">{targetNode}</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Current memory limits</p>
                            <HelpTooltip>Shows current overcommit on the selected node before adding this server.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedCapacityNode.limitMemoryPct.toFixed(1)}%</p>
                          <p className="text-gray-400 dark:text-[#666]">Limit pressure</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Observed memory usage</p>
                            <HelpTooltip>Live usage from the Kubernetes metrics API for the selected node.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedCapacityNode.usageMemoryPct != null ? `${selectedCapacityNode.usageMemoryPct.toFixed(1)}%` : "—"}</p>
                          <p className="text-gray-400 dark:text-[#666]">{selectedClusterNode?.status ?? "Unknown"}</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Game Hub budget</p>
                            <HelpTooltip>Total memory requested by all Game Hub servers combined vs the namespace quota.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{formatBytesGi(capacityData.gameHubUsage.requestedMemoryBytes)}</p>
                          <p className="text-gray-400 dark:text-[#666]">of {formatBytesGi(capacityData.gameHubUsage.quota.requestsMemoryBytes)}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-xs text-gray-500 dark:text-[#777]">
                        After this deploy, {targetNode} would request {selectedNodeProjectedMemoryPct != null ? `${selectedNodeProjectedMemoryPct.toFixed(1)}%` : "—"} memory
                        {selectedNodeProjectedCpuPct != null ? ` and ${selectedNodeProjectedCpuPct.toFixed(1)}% CPU` : ""} of allocatable capacity.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-xs">
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Ready nodes</p>
                            <HelpTooltip>How many nodes are currently available for the scheduler.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{clusterNodes.length > 0 ? clusterNodes.filter((node) => node.status === "Ready").length : capacityData.nodes.filter((node) => node.ready).length}</p>
                          <p className="text-gray-400 dark:text-[#666]">of {clusterNodes.length || capacityData.nodes.length}</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Highest node requests</p>
                            <HelpTooltip>The most-loaded ready node right now, based on actual memory requests.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{capacityData.summary.maxRequestMemoryPct.toFixed(1)}%</p>
                          <p className="text-gray-400 dark:text-[#666]">{highestPressureNode?.name ?? "No ready nodes"}</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Observed peak usage</p>
                            <HelpTooltip>Highest live memory usage currently observed on any ready node.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{capacityData.summary.maxUsageMemoryPct != null ? `${capacityData.summary.maxUsageMemoryPct.toFixed(1)}%` : "—"}</p>
                          <p className="text-gray-400 dark:text-[#666]">Across ready nodes</p>
                        </div>
                        <div className="rounded-xl bg-black/20 p-3">
                          <div className="flex items-center gap-1">
                            <p className="text-gray-500 dark:text-[#777]">Game Hub budget</p>
                            <HelpTooltip>Total memory requested by all Game Hub servers combined vs the namespace quota.</HelpTooltip>
                          </div>
                          <p className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{formatBytesGi(capacityData.gameHubUsage.requestedMemoryBytes)}</p>
                          <p className="text-gray-400 dark:text-[#666]">of {formatBytesGi(capacityData.gameHubUsage.quota.requestsMemoryBytes)}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-xs text-gray-500 dark:text-[#777]">No node selected — Kubernetes will place the server on the best available node.</p>
                    </>
                  )}
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

          {step === 4 && activeEgg && installPhase === "idle" && (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">Review and deploy</h2>
                  <p className="text-sm text-gray-500 dark:text-[#777]">Double-check the server settings before creating Kubernetes resources.</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={exportConfig} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-1.5 text-xs text-gray-500 dark:text-[#888] transition-colors hover:text-gray-900 dark:hover:text-white">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                  <SavePresetButton onSave={savePreset} />
                </div>
              </div>

              {capacityData && !capacityData.canSafelyDeploy ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
                  <p className="font-medium">⚠ Cluster memory pressure is already high.</p>
                  <p className="mt-1 text-xs text-amber-200">{targetNode && selectedNodeProjectedMemoryPct != null ? `${targetNode} would reach ${selectedNodeProjectedMemoryPct.toFixed(1)}% requested memory after this deploy.` : "One or more nodes are already under heavy memory pressure. Deployment can continue, but headroom is limited."}</p>
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

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => setStep(3)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
                <button
                  onClick={() => void deployServer()}
                  disabled={deploying || serverNameTaken === true}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-gray-900 dark:text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    capacityData && !capacityData.canSafelyDeploy ? "bg-amber-600 hover:bg-amber-500" : "bg-green-600 hover:bg-green-500"
                  )}
                >
                  {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  {capacityData && !capacityData.canSafelyDeploy ? "Deploy Anyway" : "Deploy Server"}
                </button>
              </div>
              {capacityData && !capacityData.canSafelyDeploy ? (
                <p className="text-xs text-amber-200">This does not block deployment, but it signals tight capacity until some cluster memory pressure is reduced.</p>
              ) : null}
            </div>
          )}

          {/* ─── Installation Console (replaces step 4 once deploy is submitted) ─── */}
          {installPhase !== "idle" && deployedServerName && (
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl",
                    installPhase === "running" ? "bg-green-500/20" : installPhase === "error" ? "bg-red-500/20" : "bg-[#0078D4]/15"
                  )}>
                    {installPhase === "running" ? <CheckCheck className="h-5 w-5 text-green-400" /> :
                     installPhase === "error"   ? <XCircle className="h-5 w-5 text-red-400" /> :
                                                  <Loader2 className="h-5 w-5 animate-spin text-[#0078D4]" />}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      {installPhase === "running" ? "Server is online 🎉" :
                       installPhase === "error"   ? "Deployment error" :
                                                    "Deploying…"}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-[#777]">{deployedServerName}</p>
                  </div>
                </div>
                {installPhase === "running" && (
                  <button
                    onClick={() => router.push(`/game-hub/${deployedServerName}`)}
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors"
                  >
                    <Rocket className="h-4 w-4" /> Open Server
                  </button>
                )}
              </div>

              {/* Deployment phase timeline */}
              <div className="grid gap-2 sm:grid-cols-4">
                {[
                  { key: "submitted",  label: "Resources submitted",   done: true },
                  { key: "scheduled",  label: "Pod scheduled",         done: installLog.some((l) => l.message.includes("Scheduled")) || installPhase === "running" },
                  { key: "pulling",    label: "Image pulled",          done: installLog.some((l) => l.message.includes("Pulled") || l.message.includes("AlreadyPulled")) || installPhase === "running" },
                  { key: "running",    label: "Server running",        done: installPhase === "running" },
                ].map((phase, idx) => (
                  <div key={phase.key} className={cn(
                    "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm",
                    phase.done ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-400 dark:text-[#555]"
                  )}>
                    <div className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", phase.done ? "bg-green-500 text-white" : "border border-current")}>
                      {phase.done ? "✓" : idx + 1}
                    </div>
                    <span className="text-xs">{phase.label}</span>
                  </div>
                ))}
              </div>

              {/* Live event log */}
              <div className="rounded-2xl border border-gray-200 dark:border-[#1e1e1e] bg-[#080808] overflow-hidden">
                <div className="flex items-center gap-2 border-b border-[#1a1a1a] px-4 py-2.5">
                  <Terminal className="h-4 w-4 text-[#555]" />
                  <span className="text-xs font-medium text-[#555] uppercase tracking-widest">Kubernetes Events</span>
                  {installPhase === "deploying" && <Loader2 className="h-3 w-3 animate-spin text-[#0078D4] ml-auto" />}
                </div>
                <div ref={installLogRef} className="h-64 overflow-y-auto p-4 font-mono text-xs space-y-1">
                  {installLog.length === 0 ? (
                    <p className="text-[#444]">Waiting for events…</p>
                  ) : installLog.map((entry, i) => (
                    <p key={i} className={cn(
                      "leading-5",
                      entry.kind === "error" ? "text-red-400" : entry.kind === "info" ? "text-[#7cc4ff]" : "text-[#aaa]"
                    )}>
                      <span className="text-[#444] mr-2">{new Date(entry.ts).toLocaleTimeString()}</span>
                      {entry.message}
                    </p>
                  ))}
                </div>
              </div>

              {installPhase === "error" && (
                <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Pod failed to start.</p>
                    <p className="text-xs text-red-400 mt-0.5">Check the event log above for details. You can still <button onClick={() => router.push(`/game-hub/${deployedServerName}`)} className="underline hover:no-underline">view the server page</button> to troubleshoot.</p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => router.push("/game-hub")}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-600 dark:text-[#b3b3b3] transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  ← Back to Game Hub
                </button>
                <button
                  onClick={() => router.push(`/game-hub/${deployedServerName}`)}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#0078D4]/40 bg-[#0078D4]/10 px-4 py-2 text-sm font-medium text-[#7cc4ff] transition-colors hover:bg-[#0078D4]/20"
                >
                  View Server <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ─── SavePresetButton (inline component to avoid hooks-in-callback issue) ───
function SavePresetButton({ onSave }: { onSave: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-1.5 text-xs text-gray-500 dark:text-[#888] transition-colors hover:text-gray-900 dark:hover:text-white">
        <Save className="h-3.5 w-3.5" /> Save preset
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onSave(name); setOpen(false); setName(""); } if (e.key === "Escape") { setOpen(false); setName(""); } }}
        placeholder="Preset name…"
        autoFocus
        className="rounded-lg border border-[#0078D4]/40 bg-white dark:bg-[#111] px-2 py-1.5 text-xs text-gray-900 dark:text-[#f2f2f2] outline-none w-36"
      />
      <button onClick={() => { if (name.trim()) { onSave(name); } setOpen(false); setName(""); }} className="rounded-lg bg-[#0078D4] px-2 py-1.5 text-xs text-white hover:bg-[#006cbe]">Save</button>
      <button onClick={() => { setOpen(false); setName(""); }} className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-2 py-1.5 text-xs text-gray-400 hover:text-gray-900 dark:hover:text-white">✕</button>
    </div>
  );
}
