"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { Check, Pencil, RefreshCw, UserCircle, X } from "lucide-react";
import { PageScaffold, SettingsCard, Skeleton } from "@/components/ui";
import { useApiMutation, useApiQuery, useUsersConfig } from "@/hooks";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import type { AuthentikSession, LoginEvent, ProfileActivityResponse, ProfileSessionsResponse, ProfileSummary } from "@/types";

const page = requirePageConfig("/profile");

function InlineEdit({
  value,
  onSave,
  type = "text",
  placeholder,
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
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
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          className="rounded-lg border border-indigo-500/50 bg-gray-100 dark:bg-white/5 px-2.5 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          autoFocus
        />
        <button onClick={() => void save()} disabled={loading} className="p-1 text-green-400 hover:text-green-300 disabled:opacity-50">
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            setDraft(value);
            setEditing(false);
          }}
          className="p-1 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className="group flex items-center gap-2 text-gray-900 dark:text-white transition-colors hover:text-indigo-300"
    >
      <span>{value || placeholder}</span>
      <Pencil className="h-3.5 w-3.5 text-slate-500 transition-colors group-hover:text-indigo-400" />
    </button>
  );
}

export default function ProfilePage() {
  const { data: session } = useSession();
  const { data: usersData } = useUsersConfig();
  const [activeTab, setActiveTab] = useState<"sessions" | "activity">("sessions");
  const [profileOverride, setProfileOverride] = useState<Partial<ProfileSummary>>({});

  const email = (session?.user as { email?: string } | undefined)?.email ?? "";
  const selfUser = (usersData?.users ?? []).find((user) => user.email === email);
  const nasShares = selfUser?.nas_shares ?? [];

  const profileQuery = useApiQuery<ProfileSummary>({
    queryKey: queryKeys.profile.summary(),
    path: "/api/profile",
    staleTime: queryStaleTimes.minute,
  });

  const sessionsQuery = useApiQuery<ProfileSessionsResponse>({
    queryKey: queryKeys.profile.sessions(),
    path: "/api/profile/sessions",
    staleTime: queryStaleTimes.minute,
    enabled: activeTab === "sessions",
  });

  const activityQuery = useApiQuery<ProfileActivityResponse>({
    queryKey: queryKeys.profile.activity(),
    path: "/api/profile/activity",
    staleTime: queryStaleTimes.minute,
    enabled: activeTab === "activity",
  });

  const updateName = useApiMutation<{ ok: boolean }, { newName: string }>({
    path: "/api/profile/name",
    method: "PATCH",
    invalidateQueryKeys: [queryKeys.profile.summary()],
    successMessage: "Name updated",
    errorMessage: "Failed to update name",
    onSuccess: async (_, variables) => {
      setProfileOverride((current) => ({ ...current, name: variables.newName }));
    },
  });

  const updateEmail = useApiMutation<{ ok: boolean }, { newEmail: string }>({
    path: "/api/profile/email",
    method: "PATCH",
    invalidateQueryKeys: [queryKeys.profile.summary()],
    successMessage: "Email updated — re-login may be required",
    errorMessage: "Failed to update email",
    onSuccess: async (_, variables) => {
      setProfileOverride((current) => ({ ...current, email: variables.newEmail }));
    },
  });

  const profile = profileQuery.data ? { ...profileQuery.data, ...profileOverride } : null;
  const sessions: AuthentikSession[] = sessionsQuery.data?.sessions ?? [];
  const events: LoginEvent[] = activityQuery.data?.events ?? [];
  const initials = (profile?.name || session?.user?.name || email || "?")
    .split(" ")
    .map((segment) => segment[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={profileQuery.isLoading && !profileQuery.data}
      className="max-w-4xl space-y-6"
    >
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <SettingsCard title="Profile" description="Manage your display information and access groups" icon={page.icon}>
          <div className="flex items-start gap-5">
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl border border-indigo-500/30 bg-indigo-500/20 text-xl font-bold text-indigo-300">
              {initials}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="mb-1 text-xs text-slate-500">Display name</p>
                {profile ? (
                  <InlineEdit key={`name-${profile.name}`} value={profile.name} onSave={async (newName) => { await updateName.mutateAsync({ newName }); }} placeholder="Your name" />
                ) : (
                  <Skeleton className="h-6 w-40" />
                )}
              </div>
              <div>
                <p className="mb-1 text-xs text-slate-500">Email</p>
                {profile ? (
                  <InlineEdit key={`email-${profile.email}`} value={profile.email} onSave={async (newEmail) => { await updateEmail.mutateAsync({ newEmail }); }} type="email" placeholder="your@email.com" />
                ) : (
                  <Skeleton className="h-6 w-56" />
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {(profile?.groups ?? []).map((group) => (
                  <span key={group} className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-400">
                    {group}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </SettingsCard>
      </motion.div>

      {nasShares.length > 0 ? (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <SettingsCard title="My NAS Shares" description="Storage access mapped to your account" icon={UserCircle}>
            <div className="space-y-2">
              {nasShares.map((share, index) => (
                <div key={`${share.provider}-${share.share}-${index}`} className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2">
                  <div className="text-sm text-slate-800 dark:text-slate-200">
                    {share.provider}:{share.share}{share.subfolder ? `/${share.subfolder}` : ""}
                  </div>
                  <div className="text-xs text-slate-500">
                    {share.access}
                    {share.pvc_namespace && share.pvc_name ? ` · PVC ${share.pvc_namespace}/${share.pvc_name}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </SettingsCard>
        </motion.div>
      ) : null}

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <SettingsCard title="Session Activity" description="Review active sessions and recent login events" icon={RefreshCw}>
          <div className="mb-4 flex border-b border-gray-200 dark:border-white/10">
            {([
              { id: "sessions", label: "Sessions" },
              { id: "activity", label: "Login Activity" },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-5 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "-mb-px border-b-2 border-indigo-500 text-gray-900 dark:text-white"
                    : "text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "sessions" ? (
            sessionsQuery.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-14" />)}</div>
            ) : sessions.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No active sessions</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((authentikSession) => (
                  <div key={authentikSession.identifier} className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3">
                    <div>
                      <p className="text-sm text-gray-900 dark:text-white">{authentikSession.description || authentikSession.identifier}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {authentikSession.created ? new Date(authentikSession.created).toLocaleString() : "—"}
                        {authentikSession.expires ? ` · expires ${new Date(authentikSession.expires).toLocaleString()}` : ""}
                      </p>
                    </div>
                    <RefreshCw className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                ))}
              </div>
            )
          ) : activityQuery.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-12" />)}</div>
          ) : events.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No login activity</p>
          ) : (
            <div className="relative space-y-3 pl-6">
              <div className="absolute bottom-0 left-2.5 top-0 w-px bg-gray-100 dark:bg-white/10" />
              {events.map((event) => {
                const success = event.context?.result !== "denied";
                return (
                  <div key={event.pk} className="relative rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3">
                    <div
                      className={`absolute -left-3.5 top-4 h-2.5 w-2.5 rounded-full border-2 ${
                        success ? "border-green-400 bg-green-500" : "border-red-400 bg-red-500"
                      }`}
                    />
                    <div className="text-sm text-gray-900 dark:text-white">{event.action}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{new Date(event.created).toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsCard>
      </motion.div>
    </PageScaffold>
  );
}
