"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, Search as SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_SEARCH_RESPONSE,
  SEARCH_CATEGORY_LABELS,
  type SearchResponse,
  type SearchResult,
} from "@/lib/search";

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CATEGORY_ORDER: Array<keyof SearchResponse> = [
  "navigation",
  "gameServers",
  "pods",
  "apps",
  "settings",
];

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse>(EMPTY_SEARCH_RESPONSE);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(EMPTY_SEARCH_RESPONSE);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Search failed");
        const data = (await res.json()) as SearchResponse;
        setResults(data);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setResults(EMPTY_SEARCH_RESPONSE);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, query.trim() ? 150 : 0);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const groupedResults = useMemo(
    () => CATEGORY_ORDER
      .map((key) => [key, results[key]] as const)
      .filter(([, entries]) => entries.length > 0),
    [results],
  );

  const flatResults = useMemo(
    () => groupedResults.flatMap(([, entries]) => entries),
    [groupedResults],
  );

  const handleSelect = (result: SearchResult) => {
    router.push(result.href);
    onOpenChange(false);
  };

  const handleEnter = () => {
    if (flatResults[0]) {
      handleSelect(flatResults[0]);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[500] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-[501] w-[min(92vw,40rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#111] p-0 shadow-2xl outline-none">
          <Dialog.Title className="sr-only">Global search</Dialog.Title>
          <div className="flex items-center border-b border-[#2a2a2a] px-4">
            <SearchIcon className="mr-2 h-4 w-4 shrink-0 text-[#666]" />
            <input
              ref={inputRef}
              className="flex-1 bg-transparent py-3 text-sm text-[#f2f2f2] outline-none placeholder:text-[#444]"
              placeholder="Search pods, servers, apps..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleEnter();
                }
              }}
            />
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#666]" /> : null}
            <kbd className="rounded border border-[#333] px-1 text-xs text-[#444]">ESC</kbd>
          </div>
          <div className="max-h-80 overflow-y-auto py-2">
            {groupedResults.map(([key, entries]) => {
              const category = key === "gameServers"
                ? "game-server"
                : key === "pods"
                  ? "pod"
                  : key === "apps"
                    ? "app"
                    : key === "settings"
                      ? "setting"
                      : "navigation";

              return (
                <div key={key}>
                  <div className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-[#666]">
                    {SEARCH_CATEGORY_LABELS[category]}
                  </div>
                  {entries.map((result) => (
                    <button
                      key={result.id}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#1a1a1a]"
                      onClick={() => handleSelect(result)}
                    >
                      <span className="text-base">{result.icon ?? "•"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-[#f2f2f2]">{result.title}</div>
                        {result.subtitle ? (
                          <div className="truncate text-xs text-[#666]">{result.subtitle}</div>
                        ) : null}
                      </div>
                      {result.badge ? (
                        <span className={`rounded-full px-1.5 py-0.5 text-xs ${result.badgeColor ?? "bg-[#1f1f1f] text-[#888]"}`}>
                          {result.badge}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              );
            })}
            {query.length > 0 && flatResults.length === 0 && !loading ? (
              <div className="px-4 py-8 text-center text-sm text-[#444]">No results for &quot;{query}&quot;</div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
