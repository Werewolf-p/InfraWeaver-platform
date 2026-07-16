"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { KeyRound, ShieldCheck, UserCircle } from "lucide-react";
import { SettingsCard } from "@/components/ui";
import { useApiMutation } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/notify";
import type { SelfServiceRequest } from "@/lib/self-service/types";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

interface PasswordResetResponse {
  request: SelfServiceRequest;
  recoveryLink?: string;
}

/**
 * Profile & security self-service. Name/email edits reuse the existing
 * auto-apply profile routes (rate-limited + audited) directly — no new backend —
 * while "Reset my password" submits a `password-reset` self-service request that
 * auto-applies against the caller's OWN Authentik account.
 */
export function ProfileSection() {
  const { data: session } = useSession();
  const email = (session?.user as { email?: string } | undefined)?.email ?? "";
  const [name, setName] = useState((session?.user as { name?: string } | undefined)?.name ?? "");
  const [newEmail, setNewEmail] = useState(email);

  const updateName = useApiMutation<{ ok: boolean }, { newName: string }>({
    path: "/api/profile/name",
    method: "PATCH",
    successMessage: "Display name updated",
    errorMessage: "Failed to update name",
  });

  const updateEmail = useApiMutation<{ ok: boolean }, { newEmail: string }>({
    path: "/api/profile/email",
    method: "PATCH",
    successMessage: "Email updated — re-login may be required",
    errorMessage: "Failed to update email",
  });

  const resetPassword = useApiMutation<PasswordResetResponse, { type: "password-reset"; payload: Record<string, never> }>({
    path: "/api/self-service/requests",
    method: "POST",
    invalidateQueryKeys: [queryKeys.selfService.mine()],
    onSuccess: async (data) => {
      if (data.recoveryLink) {
        toast.success("Password recovery link sent to your email");
      } else {
        toast.success("Password reset started");
      }
    },
    errorMessage: "Failed to start password reset",
  });

  return (
    <div className="space-y-4">
      <SettingsCard title="Profile" description="Update your display name and email. These apply immediately." icon={UserCircle}>
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 space-y-1">
              <span className="text-xs text-slate-500">Display name</span>
              <input className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
            </label>
            <button
              type="button"
              disabled={!name.trim() || updateName.isPending}
              onClick={() => updateName.mutate({ newName: name.trim() })}
              className="touch-target rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              Save name
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 space-y-1">
              <span className="text-xs text-slate-500">Email</span>
              <input className={INPUT_CLASS} type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="you@example.com" />
            </label>
            <button
              type="button"
              disabled={!newEmail.trim() || newEmail === email || updateEmail.isPending}
              onClick={() => updateEmail.mutate({ newEmail: newEmail.trim() })}
              className="touch-target rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              Save email
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Password & security" description="Reset your own password via a recovery link sent to your email." icon={ShieldCheck}>
        <button
          type="button"
          disabled={resetPassword.isPending}
          onClick={() => resetPassword.mutate({ type: "password-reset", payload: {} })}
          className="touch-target inline-flex items-center gap-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-600 dark:text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:opacity-50"
        >
          <KeyRound className="h-4 w-4" /> Reset my password
        </button>
      </SettingsCard>
    </div>
  );
}
