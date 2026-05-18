"use client";
import { useEffect, useState } from "react";
import { X, Trash2, RefreshCw } from "lucide-react";
import { toast } from "@/lib/notify";
import { Skeleton } from "@/components/ui/skeleton";
import { useRBAC } from "@/hooks/use-rbac";

interface TokenSession {
  identifier: string;
  created: string;
  expires?: string;
  description?: string;
}

interface Props {
  username: string;
  open: boolean;
  onClose: () => void;
}

export function SessionsPanel({ username, open, onClose }: Props) {
  const { canAny } = useRBAC();
  const canManageSessions = canAny(["users:write", "users:invite", "rbac:admin"]);
  const [sessions, setSessions] = useState<TokenSession[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchSessions() {
    setLoading(true);
    try {
      const r = await fetch(`/api/users/${username}/sessions`);
      const data = await r.json();
      setSessions(data.sessions ?? []);
    } catch {
      toast.error("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, username]);

  async function revokeSession(tokenId: string) {
    if (!canManageSessions) {
      toast.error("You do not have permission to manage user sessions");
      return;
    }
    try {
      await fetch(`/api/users/${username}/sessions/${tokenId}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.identifier !== tokenId));
      toast.success("Session revoked");
    } catch {
      toast.error("Failed to revoke session");
    }
  }

  async function revokeAll() {
    if (!canManageSessions) {
      toast.error("You do not have permission to manage user sessions");
      return;
    }
    for (const s of sessions) {
      await revokeSession(s.identifier);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="w-96 bg-slate-100 dark:bg-slate-900 border-l border-gray-200 dark:border-white/10 flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-white/10">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Sessions</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">@{username}</p>
          </div>
          <div className="flex items-center gap-2">
            {sessions.length > 0 && (
              <button
                onClick={revokeAll}
                disabled={!canManageSessions}
                className="px-2.5 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                Revoke All
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)
          ) : sessions.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm">No active sessions</div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.identifier}
                className="flex items-start justify-between p-3 rounded-xl bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                    {s.description || s.identifier}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Created: {s.created ? new Date(s.created).toLocaleString() : "—"}
                  </p>
                  {s.expires && (
                    <p className="text-xs text-slate-500">
                      Expires: {new Date(s.expires).toLocaleString()}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => revokeSession(s.identifier)}
                  disabled={!canManageSessions}
                  className="ml-3 p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-3 border-t border-gray-200 dark:border-white/10">
          <button
            onClick={fetchSessions}
            className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
