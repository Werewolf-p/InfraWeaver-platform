"use client";

import { useState } from "react";
import { Check, Clock, ShieldAlert, X } from "lucide-react";
import { useApiMutation } from "@/hooks";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { queryKeys } from "@/lib/query-keys";
import { describeCeilingEffect, describeRequest, requestTypeLabel } from "@/lib/self-service/describe";
import { GROUP_DENIED_PERMISSIONS, ROOT_SCOPE, expandToConcrete, resolveRoleDefinition } from "@/lib/rbac";
import type { AppAccessPayload, SelfServiceRequest } from "@/lib/self-service/types";

interface RequestCardProps {
  request: SelfServiceRequest;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

// A request has been waiting long enough to warrant a visual nudge (amber), and
// longer still to read as stale (red). Tuned for a homelab-scale queue where a
// same-day decision is the norm.
const URGENCY_AMBER_MS = 4 * 60 * 60 * 1000;
const URGENCY_RED_MS = 24 * 60 * 60 * 1000;

const ESCALATION_PERMISSIONS = new Set<string>(GROUP_DENIED_PERMISSIONS.filter((permission) => permission !== "*"));

/**
 * A grant is privileged when it lands at the cluster-wide root scope or confers a
 * platform-escalation permission (users:write / rbac:admin / cluster:admin / "*").
 * Mirrors the server-enforced ceiling so Approve pauses only on the dangerous ones.
 */
function isPrivilegedAppAccess(payload: AppAccessPayload): boolean {
  if (payload.scope === ROOT_SCOPE) return true;
  const role = resolveRoleDefinition(payload.roleId);
  if (!role) return /(^|[-:])(admin|owner)$/i.test(payload.roleId);
  if (role.permissions.includes("*")) return true;
  return role.permissions
    .flatMap((pattern) => expandToConcrete(pattern))
    .some((permission) => ESCALATION_PERMISSIONS.has(permission));
}

function isPrivilegedRequest(request: SelfServiceRequest): boolean {
  return request.type === "app-access" && isPrivilegedAppAccess(request.payload as AppAccessPayload);
}

function urgencyTone(createdAt: string): "normal" | "amber" | "red" {
  const age = Date.now() - new Date(createdAt).getTime();
  if (Number.isNaN(age)) return "normal";
  if (age >= URGENCY_RED_MS) return "red";
  if (age >= URGENCY_AMBER_MS) return "amber";
  return "normal";
}

const CARD_ACCENT: Record<"normal" | "amber" | "red", string> = {
  normal: "border-slate-200 dark:border-white/10",
  amber: "border-amber-400/50 dark:border-amber-400/40",
  red: "border-red-400/60 dark:border-red-500/50",
};

const AGE_TEXT: Record<"normal" | "amber" | "red", string> = {
  normal: "text-slate-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

/**
 * A single pending request with a CEILING PREVIEW — the exact effect approval
 * commits ("Grants role X at scope Y" / "Expands PVC to Z") — shown before the
 * admin decides. Approve applies under the approver's ceiling (server-enforced);
 * deny requires a note. Privileged grants gate Approve behind a confirm step, and
 * the card's border/age warm as the request waits.
 */
export function RequestCard({ request }: RequestCardProps) {
  const [denying, setDenying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");

  const invalidate = [queryKeys.selfService.pending()];
  const privileged = isPrivilegedRequest(request);
  const tone = urgencyTone(request.createdAt);

  const approve = useApiMutation<{ request: SelfServiceRequest; recoveryLink?: string }, void>({
    path: `/api/self-service/requests/${request.id}/approve`,
    method: "POST",
    invalidateQueryKeys: invalidate,
    successMessage: "Request approved and applied",
    errorMessage: (error) => error.message || "Approval failed",
    onSuccess: async () => setConfirming(false),
  });

  const deny = useApiMutation<{ request: SelfServiceRequest }, { note: string }>({
    path: `/api/self-service/requests/${request.id}/deny`,
    method: "POST",
    invalidateQueryKeys: invalidate,
    successMessage: "Request denied",
    errorMessage: "Failed to deny request",
    onSuccess: async () => setDenying(false),
  });

  const busy = approve.isPending || deny.isPending;

  function handleApprove() {
    if (privileged) {
      setConfirming(true);
      return;
    }
    approve.mutate();
  }

  return (
    <li className={`space-y-3 rounded-xl border ${CARD_ACCENT[tone]} bg-slate-50 dark:bg-white/5 p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-slate-300 dark:border-white/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          {requestTypeLabel(request.type)}
        </span>
        {privileged ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-300">
            <ShieldAlert className="h-3 w-3" /> Privileged
          </span>
        ) : null}
        <span className="text-sm text-slate-700 dark:text-slate-300">{request.requestedBy}</span>
        <span className={`ml-auto inline-flex items-center gap-1 text-xs ${AGE_TEXT[tone]}`}>
          {tone !== "normal" ? <Clock className="h-3 w-3" /> : null}
          <RelativeTime date={request.createdAt} />
        </span>
      </div>

      <p className="text-sm text-slate-800 dark:text-slate-200">{describeRequest(request)}</p>
      {request.reason ? <p className="text-xs text-slate-500">Reason: {request.reason}</p> : null}

      <div className="flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
        <p className="text-xs text-indigo-700 dark:text-indigo-300">On approve: {describeCeilingEffect(request)}</p>
      </div>

      {denying ? (
        <div className="space-y-2">
          <textarea className={`${INPUT_CLASS} min-h-[56px]`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason for denial (required)" maxLength={500} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => deny.mutate({ note: note.trim() })}
              className="touch-target inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              <X className="h-4 w-4" /> Confirm deny
            </button>
            <button type="button" onClick={() => setDenying(false)} className="touch-target rounded-lg border border-slate-300 dark:border-white/10 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleApprove}
            className="touch-target inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDenying(true)}
            className="touch-target inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-white/10 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-50"
          >
            <X className="h-4 w-4" /> Deny
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        danger
        title="Approve a privileged grant?"
        description={`This applies immediately under your own RBAC ceiling: ${describeCeilingEffect(request)}. Requested by ${request.requestedBy}.`}
        confirmText="Approve grant"
        onConfirm={() => approve.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </li>
  );
}
