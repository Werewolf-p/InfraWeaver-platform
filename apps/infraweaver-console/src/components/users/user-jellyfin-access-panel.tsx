"use client";

// "Does this person have Jellyfin, and what are their credentials."
//
// A sibling of `user-storage-access-panel.tsx`, deliberately independent: giving
// someone a NAS folder and giving someone Jellyfin are two separate grants that
// compose, not one wizard. A person can have either, both, or neither.
//
// What makes Jellyfin special: its OIDC plugin covers only the web UI, so native
// and TV clients sign in with a LOCAL Jellyfin account. Granting here provisions
// that account with a generated password; revoking disables it (watch history
// survives a re-grant). There is no mail transport on this platform, so the
// password is revealed in-console — by the grantee themselves, who is already
// authenticated by the same SSO identity that earned them the grant.

import { useMemo, useState } from "react";
import {
  Check,
  Clapperboard,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { cn, formatDate } from "@/lib/utils";
import type { PlatformUser } from "@/hooks/use-users-config";
import {
  useGrantJellyfinAccess,
  useJellyfinAccess,
  useRevealJellyfinCredential,
  useRevokeJellyfinAccess,
  useSyncJellyfinUsers,
  type JellyfinCredential,
  type JellyfinRoleId,
} from "@/hooks/use-jellyfin-access";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

const TIERS: Array<{ roleId: JellyfinRoleId; label: string; grants: string; icon: typeof Eye; accent: string; ring: string }> = [
  {
    roleId: "jellyfin-user",
    label: "User",
    grants: "A standard Jellyfin account. Watch anything the libraries expose.",
    icon: UserRound,
    accent: "text-slate-600 dark:text-slate-300",
    ring: "border-slate-400/60",
  },
  {
    roleId: "jellyfin-admin",
    label: "Admin",
    grants: "A Jellyfin administrator: manage libraries, users and server settings.",
    icon: Shield,
    accent: "text-purple-600 dark:text-purple-300",
    ring: "border-purple-500/60",
  },
];

const ROLE_LABEL: Record<string, string> = {
  "jellyfin-user": "User",
  "jellyfin-admin": "Admin",
};

/** The revealed password, shown once behind an explicit click. */
function CredentialCard({ credential, onHide }: { credential: JellyfinCredential; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-xl border border-purple-500/20 bg-purple-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Jellyfin sign-in</p>
        <button type="button" onClick={onHide} className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-gray-900 dark:hover:text-white">
          <EyeOff className="h-3 w-3" /> Hide
        </button>
      </div>
      <dl className="mt-1.5 space-y-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Server</dt>
          <dd className="truncate font-mono text-slate-700 dark:text-slate-300">{credential.launchUrl}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Username</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-300">{credential.username}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Password</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-slate-700 dark:text-slate-300">{credential.password}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(credential.password);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white"
              title="Copy password"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            </button>
          </dd>
        </div>
      </dl>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        Use this in the Jellyfin app on a TV or phone, where SSO does not work. Signing in on the web can still use SSO.
      </p>
    </div>
  );
}

function GrantJellyfinSheet({
  username,
  open,
  onClose,
}: {
  username: string;
  open: boolean;
  onClose: () => void;
}) {
  const grant = useGrantJellyfinAccess();
  const [tier, setTier] = useState<JellyfinRoleId>("jellyfin-user");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedTier = TIERS.find((entry) => entry.roleId === tier) ?? TIERS[0];

  async function submit() {
    setError(null);
    try {
      await grant.mutateAsync({
        roleId: tier,
        principalType: "user",
        principal: username,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant Jellyfin access");
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      size="md"
      title={`Grant ${username} Jellyfin access`}
      description={<span className="text-xs text-slate-500">Creates a local Jellyfin account with a generated password.</span>}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 px-4 text-sm text-slate-600 dark:border-white/10 dark:text-slate-300">
            Cancel
          </button>
          <button
            type="button"
            disabled={grant.isPending}
            onClick={() => void submit()}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-purple-500/30 bg-purple-500/20 px-4 text-sm font-semibold text-purple-700 transition-colors hover:bg-purple-500/30 disabled:opacity-50 dark:text-purple-200"
          >
            {grant.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Grant {selectedTier.label}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Access level</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TIERS.map((entry) => {
              const Icon = entry.icon;
              const active = tier === entry.roleId;
              return (
                <button
                  key={entry.roleId}
                  type="button"
                  onClick={() => setTier(entry.roleId)}
                  aria-pressed={active}
                  className={cn(
                    "relative flex min-h-[104px] flex-col rounded-2xl border-2 p-4 text-left transition-all",
                    active ? cn(entry.ring, "bg-white shadow-sm dark:bg-white/[0.07]") : "border-gray-200 bg-gray-100 hover:border-gray-300 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20",
                  )}
                >
                  {active ? (
                    <span className={cn("absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full", entry.accent)}>
                      <Check className="h-4 w-4" />
                    </span>
                  ) : null}
                  <Icon className={cn("mb-1.5 h-5 w-5", entry.accent)} />
                  <p className={cn("text-sm font-semibold", entry.accent)}>{entry.label}</p>
                  <p className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{entry.grants}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Expiry (optional)</label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-base text-gray-900 focus:border-purple-500/50 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
          />
          <p className="mt-2 text-xs text-slate-500">
            When the grant expires the account is disabled on the next reconcile, not deleted.
          </p>
        </div>

        <p className="flex items-start gap-2 rounded-2xl border border-gray-200 bg-gray-50 p-3 text-xs leading-snug text-slate-500 dark:border-white/10 dark:bg-white/5">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The password is generated, stored encrypted, and never emailed. {username} reveals it themselves from this page after signing in.
        </p>

        {error ? <p className="text-sm text-red-500">{error}</p> : null}
      </div>
    </ResponsiveSheet>
  );
}

export function UserJellyfinAccessPanel({ user, isAdmin }: Props) {
  const [granting, setGranting] = useState(false);
  const [credential, setCredential] = useState<JellyfinCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const accessQuery = useJellyfinAccess(Boolean(user));
  const revoke = useRevokeJellyfinAccess();
  const reveal = useRevealJellyfinCredential();
  const sync = useSyncJellyfinUsers();

  const grants = useMemo(
    () => (accessQuery.data?.grants ?? []).filter((grant) => grant.principalType === "user" && grant.principalId === user?.username),
    [accessQuery.data, user?.username],
  );

  if (!user) return null;
  const canManage = accessQuery.data?.canManage ?? false;

  async function submitRevoke(assignmentId: string) {
    setError(null);
    setNotice(null);
    setCredential(null);
    try {
      await revoke.mutateAsync({ assignmentId, principalType: "user", principal: user!.username });
      setNotice(`Jellyfin account for ${user!.username} will be disabled.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke Jellyfin access");
    }
  }

  async function submitReveal() {
    setError(null);
    try {
      setCredential(await reveal.mutateAsync(user!.username));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reveal credential");
    }
  }

  async function submitSync() {
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const result = await sync.mutateAsync();
      const parts = [
        result.created.length ? `${result.created.length} created` : "",
        result.enabled.length ? `${result.enabled.length} re-enabled` : "",
        result.roleChanged.length ? `${result.roleChanged.length} role changed` : "",
        result.disabled.length ? `${result.disabled.length} disabled` : "",
      ].filter(Boolean);
      setNotice(parts.length ? `Jellyfin accounts reconciled: ${parts.join(", ")}.` : "Jellyfin accounts already match RBAC.");
      // A reconcile can succeed while a credential never reached its owner: once the
      // account exists it is never re-created, so the notification never re-runs.
      // Nothing else reports this, and the fix is a manual reveal.
      if (result.pendingHandoff.length) {
        setWarning(
          `Credential never handed off to ${result.pendingHandoff.join(", ")}. Their account and password exist — reveal it to them.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reconcile Jellyfin accounts");
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#2a2a2a] dark:bg-[#111]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <Clapperboard className="h-4 w-4 text-purple-500" />
            Jellyfin access
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Grants {user.name || user.username} a local Jellyfin account, so TV and mobile apps can sign in.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canManage ? (
            <button
              type="button"
              onClick={() => void submitSync()}
              disabled={sync.isPending}
              title="Reconcile every Jellyfin account against RBAC"
              className="rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:text-gray-900 disabled:opacity-40 dark:border-white/10 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} />
            </button>
          ) : null}
          {isAdmin && grants.length === 0 ? (
            <button
              type="button"
              onClick={() => setGranting(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1.5 text-xs font-medium text-purple-700 transition-colors hover:bg-purple-500/20 dark:text-purple-300"
            >
              <Plus className="h-3.5 w-3.5" />
              Grant Jellyfin
            </button>
          ) : null}
        </div>
      </div>

      {accessQuery.isLoading ? (
        <p className="flex items-center gap-2 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : accessQuery.isError ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
          {(accessQuery.error as Error).message}
        </p>
      ) : grants.length === 0 ? (
        <p className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5">
          No Jellyfin account. Granting one creates it automatically.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-[#1c1c1c] dark:border-[#2a2a2a]">
          {grants.map((grant) => (
            <li key={grant.id} className="p-3">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-500/10 text-purple-500">
                  {grant.roleId === "jellyfin-admin" ? <Shield className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white">
                    Jellyfin
                    <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-300">
                      {ROLE_LABEL[grant.roleId] ?? grant.roleId}
                    </span>
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    Granted by {grant.grantedBy}
                    {grant.expiresAt ? ` · expires ${formatDate(grant.expiresAt)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => (credential ? setCredential(null) : void submitReveal())}
                  disabled={reveal.isPending}
                  title="Reveal the Jellyfin username and password for app sign-in"
                  className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-purple-500/40 hover:text-purple-500 disabled:opacity-40 dark:border-white/10"
                >
                  {reveal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : credential ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    onClick={() => void submitRevoke(grant.id)}
                    disabled={revoke.isPending}
                    title="Revoke Jellyfin access (disables the account, keeps watch history)"
                    className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-40 dark:border-white/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              {credential ? <CredentialCard credential={credential} onHide={() => setCredential(null)} /> : null}
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="mt-2 text-sm text-red-500">{error}</p> : null}
      {notice ? <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">{notice}</p> : null}
      {warning ? <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">{warning}</p> : null}

      {granting ? (
        <GrantJellyfinSheet
          username={user.username}
          open
          onClose={() => { setGranting(false); void accessQuery.refetch(); }}
        />
      ) : null}
    </div>
  );
}
