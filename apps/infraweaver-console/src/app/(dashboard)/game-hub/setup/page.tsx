"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2, Gamepad2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import Link from "next/link";

interface SetupStatus {
  nsExists: boolean;
  crdExists: boolean;
  longhornAvailable: boolean;
  ready: boolean;
}

export default function GameHubSetupPage() {
  const queryClient = useQueryClient();
  const [applying, setApplying] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ["game-hub", "setup"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/setup");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<SetupStatus>;
    },
    refetchInterval: 5000,
  });

  async function applyResources() {
    setApplying(true);
    try {
      const res = await fetch("/api/game-hub/setup", { method: "POST" });
      const data = await res.json() as { results: Array<{ resource: string; status: string; error?: string }> };
      const errors = data.results.filter(r => r.status === "error");
      if (errors.length === 0) {
        toast.success("Resources applied successfully!");
      } else {
        toast.error(`Some resources failed: ${errors.map(e => e.resource).join(", ")}`);
      }
      queryClient.invalidateQueries({ queryKey: ["game-hub", "setup"] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setApplying(false);
    }
  }

  const checks = [
    { label: "game-hub namespace", key: "nsExists" as keyof SetupStatus, description: "Kubernetes namespace for game servers" },
    { label: "GameServer CRD", key: "crdExists" as keyof SetupStatus, description: "Custom Resource Definition for game servers" },
    { label: "Longhorn storage", key: "longhornAvailable" as keyof SetupStatus, description: "Persistent storage for game data" },
  ];

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <PageHeader title="Game Hub Setup" subtitle="Initialize Game Hub on your cluster" icon={Gamepad2} />

      <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-6 space-y-4">
        <h2 className="text-sm font-medium text-[#f2f2f2]">Prerequisites</h2>
        {isLoading ? (
          <div className="flex items-center gap-2 text-[#666] text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking cluster...
          </div>
        ) : (
          <div className="space-y-3">
            {checks.map(check => {
              const ok = status?.[check.key] === true;
              return (
                <div key={check.key} className="flex items-center gap-3">
                  {ok ? (
                    <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[#555] flex-shrink-0" />
                  )}
                  <div>
                    <p className={cn("text-sm font-medium", ok ? "text-[#f2f2f2]" : "text-[#666]")}>{check.label}</p>
                    <p className="text-xs text-[#555]">{check.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {status?.ready ? (
          <div className="pt-2">
            <div className="flex items-center gap-2 text-green-400 text-sm mb-3">
              <CheckCircle2 className="w-4 h-4" />
              Game Hub is ready!
            </div>
            <Link href="/game-hub" className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors w-fit">
              <Gamepad2 className="w-4 h-4" />
              Go to Game Hub
            </Link>
          </div>
        ) : (
          <button
            onClick={applyResources}
            disabled={applying || isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {applying ? "Applying..." : "Apply Resources"}
          </button>
        )}
      </div>
    </div>
  );
}
