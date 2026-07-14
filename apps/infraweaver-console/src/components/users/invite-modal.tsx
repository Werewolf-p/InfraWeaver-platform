"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { X, Mail, Copy, Check, ChevronDown, Users, AppWindow } from "lucide-react";
import { toast } from "@/lib/notify";
import { useRBAC } from "@/hooks/use-rbac";
import { useApiQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface GroupOption {
  name: string;
  secondary?: string;
}

const EXPIRY_OPTIONS = [
  { label: "1 hour", value: 1 },
  { label: "6 hours", value: 6 },
  { label: "24 hours", value: 24 },
  { label: "3 days", value: 72 },
  { label: "7 days", value: 168 },
];

// App access catalog — the invitee picks an app, then a role within it. Each
// role's `presetId` is auto-provisioned on enrollment (the server maps ids to
// RBAC grants in lib/users/access-presets.ts). Ids MUST match ACCESS_PRESETS.
// `privileged` roles (app admin) are only offered to, and only accepted from,
// rbac:admin operators — the server enforces the same ceiling.
interface AppRoleOption {
  presetId: string;
  label: string;
  description: string;
  privileged?: boolean;
}

interface AppAccessOption {
  id: string;
  label: string;
  roles: AppRoleOption[];
}

const APP_CATALOG: AppAccessOption[] = [
  {
    id: "jellyfin",
    label: "Jellyfin",
    roles: [
      { presetId: "jellyfin-user", label: "User", description: "Stream media" },
      { presetId: "jellyfin-admin", label: "Admin", description: "Manage the Jellyfin server", privileged: true },
    ],
  },
  {
    id: "storage",
    label: "Nextcloud storage",
    roles: [
      { presetId: "storage-viewer", label: "Read-only", description: "View the /Media folder" },
      { presetId: "storage-contributor", label: "Read-write", description: "Upload to /Media" },
    ],
  },
];

const inputCls = "w-full rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3 text-base text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] sm:text-sm";

export function InviteModal({ open, onClose }: Props) {
  const { canAny, can } = useRBAC();
  const canManageUsers = canAny(["users:invite", "users:write", "rbac:admin"]);
  // Assigning groups on an invite can confer privileges, so the picker (and the
  // server) restrict it to rbac:admin. The `groups` field stays [] for everyone
  // else and the server rejects a non-empty list without rbac:admin.
  const canAssignGroups = can("rbac:admin");
  const [email, setEmail] = useState("");
  const [expiryHours, setExpiryHours] = useState(24);
  const [loading, setLoading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  // One role per app, keyed by app id (value is the chosen preset id). Selecting
  // the same role again clears that app's access.
  const [appRoles, setAppRoles] = useState<Record<string, string>>({});
  const [openApp, setOpenApp] = useState<string | null>(null);

  function selectRole(appId: string, presetId: string) {
    setAppRoles((current) => {
      if (current[appId] === presetId) {
        return Object.fromEntries(Object.entries(current).filter(([key]) => key !== appId));
      }
      return { ...current, [appId]: presetId };
    });
  }

  // Load the RBAC groups an admin can grant on invite. Only fetched when the
  // modal is open for an rbac:admin operator, so a normal inviter never calls it.
  const {
    data: groupOptions = [],
    isLoading: groupsLoading,
    isError: groupsError,
  } = useApiQuery<{ groups?: Array<{ name: string; secondary?: string }> }, GroupOption[]>({
    queryKey: queryKeys.rbac.subjects(),
    path: "/api/rbac/subjects",
    enabled: open && canAssignGroups,
    select: (data) =>
      (data.groups ?? []).filter((group) => group.name).map((group) => ({ name: group.name, secondary: group.secondary })),
  });

  function toggleGroup(name: string) {
    setSelectedGroups((current) =>
      current.includes(name) ? current.filter((g) => g !== name) : [...current, name],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canManageUsers) {
      toast.error("You do not have permission to invite users");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, groups: canAssignGroups ? selectedGroups : [], access: Object.values(appRoles), expiryHours }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      setInviteUrl(data.url);
      toast.success("Invite created");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setEmail("");
    setExpiryHours(24);
    setInviteUrl("");
    setCopied(false);
    setSelectedGroups([]);
    setAppRoles({});
    setOpenApp(null);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-[61] w-full overflow-y-auto bg-white dark:bg-[#111] p-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[90dvh] sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a] sm:p-6 sm:pt-6 sm:pb-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
              <Mail className="h-4 w-4 text-[#3b82f6]" />
              Invite User
            </Dialog.Title>
            <button onClick={handleClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {inviteUrl ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-[#888]">Share this link with the user:</p>
              <div className="group flex items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3">
                <span className="flex-1 truncate font-mono text-xs text-gray-700 dark:text-[#d4d4d4]">{inviteUrl}</span>
                <button
                  onClick={handleCopy}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] focus:opacity-100"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <button
                onClick={handleClose}
                className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Email address</label>
                <input
                  autoFocus
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  placeholder="user@example.com"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">
                  <AppWindow className="h-4 w-4 text-[#3b82f6]" />
                  App access
                  <span className="font-normal text-gray-400 dark:text-[#666]">(optional)</span>
                </label>
                <p className="mb-2 text-sm text-gray-400 dark:text-[#666]">
                  Pick an app, then a role. It&apos;s provisioned automatically when they finish enrolling — no extra steps.
                </p>
                <div className="space-y-2">
                  {APP_CATALOG.map((app) => {
                    const visibleRoles = app.roles.filter((role) => !role.privileged || canAssignGroups);
                    if (visibleRoles.length === 0) return null;
                    const selectedPreset = appRoles[app.id];
                    const selectedRole = visibleRoles.find((role) => role.presetId === selectedPreset);
                    const isOpen = openApp === app.id;
                    return (
                      <div
                        key={app.id}
                        className="overflow-hidden rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d]"
                      >
                        <button
                          type="button"
                          onClick={() => setOpenApp((current) => (current === app.id ? null : app.id))}
                          aria-expanded={isOpen}
                          className="flex min-h-[52px] w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{app.label}</span>
                            <span
                              className={`block truncate text-xs ${selectedRole ? "text-[#3b82f6]" : "text-gray-400 dark:text-[#666]"}`}
                            >
                              {selectedRole ? selectedRole.label : "No access"}
                            </span>
                          </span>
                          <ChevronDown
                            className={`h-4 w-4 shrink-0 text-gray-500 dark:text-[#888] transition-transform ${isOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        {isOpen && (
                          <div className="space-y-1 border-t border-gray-200 dark:border-[#2a2a2a] p-2">
                            {visibleRoles.map((role) => {
                              const active = selectedPreset === role.presetId;
                              return (
                                <button
                                  key={role.presetId}
                                  type="button"
                                  onClick={() => selectRole(app.id, role.presetId)}
                                  aria-pressed={active}
                                  className={`flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${active ? "bg-[#3b82f6]/10 dark:bg-[#3b82f6]/15" : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"}`}
                                >
                                  <span
                                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-[#3b82f6] bg-[#3b82f6] text-white" : "border-gray-300 dark:border-[#3a3a3a]"}`}
                                  >
                                    {active && <Check className="h-3 w-3" />}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                      <span className="truncate text-sm text-gray-900 dark:text-[#f2f2f2]">{role.label}</span>
                                      {role.privileged && (
                                        <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                                          Admin
                                        </span>
                                      )}
                                    </span>
                                    <span className="block truncate text-xs text-gray-400 dark:text-[#666]">{role.description}</span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {canAssignGroups && (
                <div>
                  <label className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">
                    <Users className="h-4 w-4 text-[#3b82f6]" />
                    Grant RBAC groups
                    <span className="font-normal text-gray-400 dark:text-[#666]">(advanced, optional)</span>
                  </label>
                  <p className="mb-2 text-sm text-gray-400 dark:text-[#666]">
                    The new account joins these groups when they finish enrolling, inheriting each group&apos;s roles.
                  </p>
                  {groupsLoading ? (
                    <p className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] px-4 py-3 text-sm text-gray-500 dark:text-[#888]">
                      Loading groups…
                    </p>
                  ) : groupsError ? (
                    <p className="rounded-2xl border border-amber-300 dark:border-amber-900/60 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
                      Could not load groups. You can still invite without one.
                    </p>
                  ) : groupOptions.length === 0 ? (
                    <p className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] px-4 py-3 text-sm text-gray-500 dark:text-[#888]">
                      No RBAC groups available to grant.
                    </p>
                  ) : (
                    <div className="max-h-44 space-y-1 overflow-y-auto rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-2">
                      {groupOptions.map((group) => {
                        const checked = selectedGroups.includes(group.name);
                        return (
                          <label
                            key={group.name}
                            className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleGroup(group.name)}
                              className="h-4 w-4 shrink-0 rounded border-gray-300 dark:border-[#2a2a2a] text-[#3b82f6] focus:ring-[#3b82f6]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-gray-900 dark:text-[#f2f2f2]">{group.name}</span>
                              {group.secondary && (
                                <span className="block truncate text-xs text-gray-400 dark:text-[#666]">{group.secondary}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div>
                <p className="mt-2 text-sm text-gray-400 dark:text-[#666]">The invite link stays below the input on mobile so expiry is never hidden behind the keyboard.</p>
                <label className="mb-2 mt-3 block text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Link expiry</label>
                <Select.Root value={String(expiryHours)} onValueChange={(value) => setExpiryHours(Number(value))}>
                  <Select.Trigger className="flex min-h-[48px] w-full items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 text-base text-gray-900 dark:text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] sm:text-sm">
                    <Select.Value />
                    <ChevronDown className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="z-[70] overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-900 dark:text-[#f2f2f2] shadow-2xl">
                      <Select.Viewport className="p-1">
                        {EXPIRY_OPTIONS.map((option) => (
                          <Select.Item
                            key={option.value}
                            value={String(option.value)}
                            className="flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none data-[highlighted]:bg-[#1a1a1a] data-[highlighted]:text-[#f2f2f2]"
                          >
                            <Select.ItemText>{option.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex min-h-[48px] flex-1 items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-transparent px-4 text-sm text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:bg-gray-200 dark:active:bg-[#1f1f1f]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !email || !canManageUsers}
                  className="flex min-h-[48px] flex-1 items-center justify-center rounded-2xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Creating…" : "Create Invite"}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
