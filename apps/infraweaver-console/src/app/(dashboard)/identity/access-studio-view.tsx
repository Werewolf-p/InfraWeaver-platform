"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAccessStudio } from "@/components/users/user-access-studio";
import { useUsersConfig, type PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";
import { useSession } from "next-auth/react";

/**
 * Access Studio tab — a per-person view of Jellyfin / Nextcloud / local access.
 * Wraps the existing UserAccessStudio component with a subject picker (extracted
 * from the former Users page) so it is a first-class Identity tab.
 */
export function AccessStudioView() {
  const { data, isLoading } = useUsersConfig();
  const { isAdmin } = useRBAC();
  const { data: session } = useSession();

  const [search, setSearch] = useState("");
  const [selectedUsername, setSelectedUsername] = useState("");

  const users = useMemo(() => data?.users ?? [], [data?.users]);
  const currentEmail = session?.user?.email ?? "";
  const currentUsername = users.find((u) => u.email === currentEmail)?.username;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const results = query
      ? users.filter(
          (u) =>
            u.username.toLowerCase().includes(query) ||
            u.name?.toLowerCase().includes(query) ||
            u.email?.toLowerCase().includes(query),
        )
      : users;
    return [...results].sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));
  }, [search, users]);

  const selectedUser: PlatformUser | null =
    filtered.find((u) => u.username === selectedUsername) ?? filtered[0] ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Sparkles}
        title="Access Studio"
        subtitle="Inspect and manage one person's Jellyfin, Nextcloud, and local access"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="space-y-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search people…" />
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-slate-500">No people match your search.</p>
          ) : (
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {filtered.map((user) => {
                const active = selectedUser?.username === user.username;
                return (
                  <li key={user.username}>
                    <button
                      type="button"
                      onClick={() => setSelectedUsername(user.username)}
                      className={`touch-target flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition ${
                        active
                          ? "bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
                          : "text-slate-700 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-white/5"
                      }`}
                    >
                      <span className="text-sm font-medium">{user.name || user.username}</span>
                      <span className="text-xs text-slate-500">@{user.username}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <UserAccessStudio user={selectedUser} isAdmin={isAdmin} currentUsername={currentUsername} />
        </div>
      </div>
    </div>
  );
}
