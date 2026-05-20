"use client";
import { useState, useEffect } from "react";

export interface SearchResult {
  id: string;
  type: "app" | "pod" | "nav";
  name: string;
  subtitle: string;
  href: string;
  icon?: string;
}

export function useResourceSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    const q = query.toLowerCase();

    const fetchAll = async () => {
      const out: SearchResult[] = [];

      try {
        const [appsRes, podsRes] = await Promise.allSettled([
          fetch("/api/argocd/apps").then(r => r.ok ? r.json() : []),
          fetch("/api/pods").then(r => r.ok ? r.json() : []),
        ]);

        if (appsRes.status === "fulfilled") {
          const apps = appsRes.value as Array<{ metadata?: { name?: string }; spec?: { destination?: { namespace?: string } } }>;
          for (const app of apps) {
            const name = app.metadata?.name ?? "";
            if (name.toLowerCase().includes(q)) {
              out.push({
                id: `app-${name}`,
                type: "app",
                name,
                subtitle: app.spec?.destination?.namespace ?? "argocd",
                href: "/apps",
              });
            }
          }
        }

        if (podsRes.status === "fulfilled") {
          const pods = podsRes.value as Array<{ name?: string; namespace?: string; status?: string }>;
          for (const pod of pods) {
            const name = pod.name ?? "";
            if (name.toLowerCase().includes(q)) {
              out.push({
                id: `pod-${name}`,
                type: "pod",
                name,
                subtitle: pod.namespace ?? "",
                href: "/pods",
              });
            }
          }
        }
      } catch {
        // ignore
      }

      setResults(out.slice(0, 20));
      setLoading(false);
    };

    const timer = setTimeout(() => void fetchAll(), 300);
    return () => clearTimeout(timer);
  }, [query]);

  return { results, loading };
}
