"use client";
import { useEffect, useState } from "react";
import { X, CheckCircle2, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface LoginEvent {
  pk: string;
  created: string;
  action: string;
  context?: { result?: string };
}

interface Props {
  username: string;
  open: boolean;
  onClose: () => void;
}

export function HistoryDrawer({ username, open, onClose }: Props) {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/users/${username}/history`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, username]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="w-96 bg-slate-900 border-l border-white/10 flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <h2 className="text-sm font-semibold text-white">Login History</h2>
            <p className="text-xs text-slate-400">@{username}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm">No login history</div>
          ) : (
            <div className="relative pl-6">
              <div className="absolute left-2.5 top-0 bottom-0 w-px bg-white/10" />
              {events.map((evt) => {
                const success = evt.context?.result !== "denied";
                return (
                  <div key={evt.pk} className="relative mb-4 last:mb-0">
                    <div className={`absolute -left-3.5 top-1 w-2.5 h-2.5 rounded-full border-2 ${success ? "bg-green-500 border-green-400" : "bg-red-500 border-red-400"}`} />
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-white">
                          {success ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                          {success ? "Login success" : "Login failed"}
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${success ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"}`}>
                          {success ? "OK" : "Denied"}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {new Date(evt.created).toLocaleString()}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
