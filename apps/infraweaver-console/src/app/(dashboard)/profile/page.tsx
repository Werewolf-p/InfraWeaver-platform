"use client";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Pencil, Check, X, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsersConfig } from "@/hooks/use-users-config";

interface AuthentikSession {
  identifier: string;
  created: string;
  expires?: string;
  description?: string;
}

interface LoginEvent {
  pk: string;
  created: string;
  action: string;
  context?: { result?: string };
}

function InlineEdit({
  value,
  onSave,
  type = "text",
  placeholder,
}: {
  value: string;
  onSave: (v: string) => Promise<void>;
  type?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [loading, setLoading] = useState(false);

  async function save() {
    setLoading(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setLoading(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="bg-white/5 border border-indigo-500/50 rounded-lg px-2.5 py-1.5 text-sm text-white focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
        />
        <button onClick={save} disabled={loading} className="p-1 text-green-400 hover:text-green-300">
          <Check className="w-4 h-4" />
        </button>
        <button onClick={() => { setDraft(value); setEditing(false); }} className="p-1 text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setDraft(value); setEditing(true); }}
      className="flex items-center gap-2 text-white hover:text-indigo-300 transition-colors group"
    >
      <span>{value || placeholder}</span>
      <Pencil className="w-3.5 h-3.5 text-slate-500 group-hover:text-indigo-400 transition-colors" />
    </button>
  );
}

export default function ProfilePage() {
  const { data: session } = useSession();
  const { data: usersData } = useUsersConfig();
  const [activeTab, setActiveTab] = useState<"sessions" | "activity">("sessions");
  const [sessions, setSessions] = useState<AuthentikSession[]>([]);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [profile, setProfile] = useState<{ name: string; email: string; groups: string[] } | null>(null);

  const email = (session?.user as { email?: string })?.email ?? "";
  const allUsers = usersData?.users ?? [];
  const selfUser = allUsers.find((u) => u.email === email);
  const nasShares = selfUser?.nas_shares ?? [];
  const initials = (profile?.name || session?.user?.name || email || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then((d) => setProfile(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab === "sessions") {
      setSessionsLoading(true);
      fetch("/api/profile/sessions")
        .then((r) => r.json())
        .then((d) => setSessions(d.sessions ?? []))
        .catch(() => {})
        .finally(() => setSessionsLoading(false));
    } else {
      setEventsLoading(true);
      fetch("/api/profile/activity")
        .then((r) => r.json())
        .then((d) => setEvents(d.events ?? []))
        .catch(() => {})
        .finally(() => setEventsLoading(false));
    }
  }, [activeTab]);

  async function saveName(newName: string) {
    const r = await fetch("/api/profile/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    });
    const data = await r.json();
    if (!r.ok) { toast.error(data.error ?? "Failed"); throw new Error(data.error); }
    setProfile((prev) => prev ? { ...prev, name: newName } : prev);
    toast.success("Name updated");
  }

  async function saveEmail(newEmail: string) {
    const r = await fetch("/api/profile/email", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newEmail }),
    });
    const data = await r.json();
    if (!r.ok) { toast.error(data.error ?? "Failed"); throw new Error(data.error); }
    setProfile((prev) => prev ? { ...prev, email: newEmail } : prev);
    toast.success("Email updated — re-login may be required");
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header Card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white/5 border border-white/10 rounded-2xl p-6"
      >
        <div className="flex items-start gap-5">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xl font-bold text-indigo-300 flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <p className="text-xs text-slate-500 mb-1">Display name</p>
              {profile ? (
                <InlineEdit value={profile.name} onSave={saveName} placeholder="Your name" />
              ) : (
                <Skeleton className="h-6 w-40" />
              )}
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Email</p>
              {profile ? (
                <InlineEdit value={profile.email} onSave={saveEmail} type="email" placeholder="your@email.com" />
              ) : (
                <Skeleton className="h-6 w-56" />
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {profile?.groups.map((g) => (
                <span key={g} className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                  {g}
                </span>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {/* NAS Shares */}
      {nasShares.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-white/5 border border-white/10 rounded-2xl p-5"
        >
          <h2 className="text-sm font-semibold text-white mb-3">My NAS Shares</h2>
          <div className="space-y-2">
            {nasShares.map((share, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                <div className="w-2 h-2 rounded-full bg-indigo-400 flex-shrink-0" />
                <span className="text-sm text-slate-300">{typeof share === "string" ? share : JSON.stringify(share)}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden"
      >
        <div className="flex border-b border-white/10">
          {(["sessions", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? "text-white border-b-2 border-indigo-500 -mb-px"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {tab === "sessions" ? "Sessions" : "Login Activity"}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === "sessions" && (
            sessionsLoading ? (
              <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : sessions.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">No active sessions</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div key={s.identifier} className="flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 border border-white/10">
                    <div>
                      <p className="text-sm text-white">{s.description || s.identifier}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {s.created ? new Date(s.created).toLocaleString() : "—"}
                        {s.expires ? ` · expires ${new Date(s.expires).toLocaleString()}` : ""}
                      </p>
                    </div>
                    <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                  </div>
                ))}
              </div>
            )
          )}

          {activeTab === "activity" && (
            eventsLoading ? (
              <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : events.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">No login activity</p>
            ) : (
              <div className="relative pl-6 space-y-3">
                <div className="absolute left-2.5 top-0 bottom-0 w-px bg-white/10" />
                {events.map((evt) => {
                  const success = evt.context?.result !== "denied";
                  return (
                    <div key={evt.pk} className="relative">
                      <div
                        className={`absolute -left-3.5 top-2 w-2.5 h-2.5 rounded-full border-2 ${
                          success ? "bg-green-500 border-green-400" : "bg-red-500 border-red-400"
                        }`}
                      />
                      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10">
                        {success ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm text-white">{success ? "Login success" : "Login failed"}</p>
                          <p className="text-xs text-slate-500">{new Date(evt.created).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </motion.div>
    </div>
  );
}
