"use client";

/**
 * People (Users) panel — a full management table over the site's WordPress
 * accounts. Reads the `people` probe (id/login/displayName/email/roles/registered,
 * first 100, plus exact per-role headcounts and total) and wires every allow-listed
 * user action: add-user, update-user-email, update-user-role, set-user-password,
 * reset-user-password, delete-user (with optional content reassignment). Last-admin
 * and connector-service-account guardrails are enforced SERVER-SIDE (409) and their
 * messages surface inline; destructive delete additionally requires typing the login.
 */

import { useMemo, useState, type ReactNode } from "react";
import { KeyRound, Mail, RefreshCw, ShieldAlert, Trash2, UserCog, UserPlus, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { PeopleData, WpUserRow } from "../../../lib/manage/probes/people";
import { WORDPRESS_ROLES } from "../../../lib/manage/capabilities";
import { SectionCard } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";
import {
  ActionError,
  BTN,
  BTN_DANGER_GHOST,
  BTN_PRIMARY,
  BTN_SM,
  ConfirmDialog,
  Field,
  INPUT,
  Modal,
  useActionRunner,
} from "./manage-ui";
import { isValidEmail, isValidLogin, isValidPassword } from "./form-validation";

type RoleTone = "violet" | "info" | "good" | "warn" | "neutral";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const ROLE_PILL: Readonly<Record<RoleTone, string>> = {
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const ROLE_TONE: Readonly<Record<string, RoleTone>> = {
  administrator: "violet",
  editor: "info",
  author: "good",
  contributor: "warn",
  subscriber: "neutral",
};
function roleTone(role: string): RoleTone {
  return ROLE_TONE[role] ?? "neutral";
}

function RolePill({ role }: { role: string }): ReactNode {
  return (
    <span className={cn(PILL_BASE, ROLE_PILL[roleTone(role)])}>
      <span className="capitalize">{role}</span>
    </span>
  );
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.split(" ")[0] || value;
}

// ── Add-user dialog ───────────────────────────────────────────────────────────

function AddUserDialog({
  site,
  open,
  onClose,
  onChanged,
}: {
  site: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { run, pending, error } = useActionRunner(site);
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof WORDPRESS_ROLES)[number]>("subscriber");
  const [password, setPassword] = useState("");

  const loginBad = login.length > 0 && !isValidLogin(login);
  const emailBad = email.length > 0 && !isValidEmail(email);
  const passwordBad = password.length > 0 && !isValidPassword(password);
  const canSubmit = isValidLogin(login) && isValidEmail(email) && (password === "" || isValidPassword(password));

  async function submit() {
    const result = await run(
      {
        type: "add-user",
        login,
        email,
        role,
        ...(password ? { password } : {}),
      },
      { onSuccess: onChanged },
    );
    if (result.ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add user" description="Create a WordPress account on this site." icon={UserPlus}>
      <div className="space-y-4">
        <Field label="Username" htmlFor="adduser-login" required error={loginBad ? "Letters, numbers, dot, dash, underscore." : undefined}>
          <input id="adduser-login" type="text" autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} className={INPUT} placeholder="jane.doe" />
        </Field>
        <Field label="Email" htmlFor="adduser-email" required error={emailBad ? "Enter a valid email address." : undefined}>
          <input id="adduser-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} placeholder="jane@example.com" />
        </Field>
        <Field label="Role" htmlFor="adduser-role" required>
          <select id="adduser-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={INPUT}>
            {WORDPRESS_ROLES.map((r) => (
              <option key={r} value={r} className="capitalize">
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Password"
          htmlFor="adduser-password"
          hint="Leave blank to auto-generate (members sign in via SSO)."
          error={passwordBad ? "8–200 characters, no line breaks." : undefined}
        >
          <input id="adduser-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} placeholder="Optional" />
        </Field>
        {error ? <ActionError message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={BTN} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={!canSubmit || pending}>
            {pending ? <Spinner /> : null} Create user
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Manage-user dialog (role / email / password / delete) ─────────────────────

function ManageUserDialog({
  site,
  user,
  others,
  open,
  onClose,
  onChanged,
}: {
  site: string;
  user: WpUserRow;
  others: readonly WpUserRow[];
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { run, pending, error, clearError } = useActionRunner(site);
  const [role, setRole] = useState<string>(user.roles[0] ?? "subscriber");
  const [email, setEmail] = useState<string>(user.email ?? "");
  const [password, setPassword] = useState("");
  const [reassignTo, setReassignTo] = useState<string>("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const emailBad = email.length > 0 && !isValidEmail(email);
  const emailChanged = email !== (user.email ?? "") && isValidEmail(email);
  const roleChanged = role !== (user.roles[0] ?? "");
  const passwordBad = password.length > 0 && !isValidPassword(password);

  const reload = () => onChanged();

  async function saveRole() {
    await run({ type: "update-user-role", userId: user.id, role: role as (typeof WORDPRESS_ROLES)[number] }, { onSuccess: reload });
  }
  async function saveEmail() {
    await run({ type: "update-user-email", userId: user.id, email }, { onSuccess: reload });
  }
  async function savePassword() {
    const result = await run({ type: "set-user-password", userId: user.id, password }, { onSuccess: reload });
    if (result.ok) setPassword("");
  }
  async function sendReset() {
    await run({ type: "reset-user-password", userId: user.id }, { onSuccess: reload });
  }
  async function confirmDelete() {
    const result = await run(
      {
        type: "delete-user",
        userId: user.id,
        ...(reassignTo ? { reassignTo: Number(reassignTo) } : {}),
      },
      { onSuccess: reload },
    );
    if (result.ok) {
      setDeleteOpen(false);
      onClose();
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={user.displayName} description={`@${user.login}`} icon={UserCog}>
        <div className="space-y-5">
          {error ? <ActionError message={error} onDismiss={clearError} /> : null}

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Role" htmlFor="mu-role">
                <select id="mu-role" value={role} onChange={(e) => setRole(e.target.value)} className={INPUT}>
                  {WORDPRESS_ROLES.map((r) => (
                    <option key={r} value={r} className="capitalize">
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button type="button" className={cn(BTN, "mb-[1px]")} disabled={!roleChanged || pending} onClick={saveRole}>
              {pending ? <Spinner /> : null} Update role
            </button>
          </div>

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Email" htmlFor="mu-email" error={emailBad ? "Enter a valid email address." : undefined}>
                <input id="mu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} />
              </Field>
            </div>
            <button type="button" className={cn(BTN, "mb-[1px]")} disabled={!emailChanged || pending} onClick={saveEmail}>
              <Mail className="h-4 w-4" aria-hidden /> Save
            </button>
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Password</p>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Set a new password" htmlFor="mu-password" error={passwordBad ? "8–200 characters, no line breaks." : undefined}>
                  <input id="mu-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} placeholder="New password" />
                </Field>
              </div>
              <button type="button" className={cn(BTN, "mb-[1px]")} disabled={!isValidPassword(password) || pending} onClick={savePassword}>
                <KeyRound className="h-4 w-4" aria-hidden /> Set
              </button>
            </div>
            <button type="button" className={BTN_SM} disabled={pending} onClick={sendReset}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Email a reset link instead
            </button>
          </div>

          <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Danger zone
            </div>
            <p className="text-xs text-red-700/90 dark:text-red-300/90">
              Deleting an account is permanent. Their content can be reassigned to another user.
            </p>
            <button type="button" className={BTN_DANGER_GHOST} disabled={pending} onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete user
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
        title={`Delete ${user.login}?`}
        description="This permanently removes the account."
        confirmLabel="Delete user"
        confirmPhrase={user.login}
        confirmPhraseLabel="Type the username to confirm"
        pending={pending}
        error={error}
        body={
          <Field label="Reassign their content to" htmlFor="mu-reassign" hint="Optional — otherwise their posts are deleted too.">
            <select id="mu-reassign" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} className={INPUT}>
              <option value="">Don&apos;t reassign</option>
              {others.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.displayName} (@{o.login})
                </option>
              ))}
            </select>
          </Field>
        }
      />
    </>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function PeoplePanel({ site }: { site: string }) {
  const state = useManagePanel<PeopleData>(site, "people");
  const { run, pending } = useManageAction(site);
  const [addOpen, setAddOpen] = useState(false);
  const [manageId, setManageId] = useState<number | null>(null);

  async function reconcile() {
    const result = await run({ type: "sync-users" });
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  const managed = useMemo(
    () => (manageId === null ? null : state.data?.users.find((u) => u.id === manageId) ?? null),
    [manageId, state.data],
  );
  const others = useMemo(
    () => (state.data?.users ?? []).filter((u) => u.id !== manageId),
    [state.data, manageId],
  );

  return (
    <>
      <PanelState state={state} isEmpty={(d) => d.users.length === 0} emptyMessage="No WordPress accounts on this site.">
        {(data) => (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Users"
              description={
                data.total > data.users.length
                  ? `Showing first ${data.users.length} of ${data.total} accounts.`
                  : `${data.total} account${data.total === 1 ? "" : "s"} with dashboard access.`
              }
              icon={Users}
              action={
                <div className="flex gap-2">
                  <button type="button" className={BTN} disabled={pending} onClick={reconcile}>
                    {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Reconcile
                  </button>
                  <button type="button" className={BTN_PRIMARY} onClick={() => setAddOpen(true)}>
                    <UserPlus className="h-4 w-4" aria-hidden /> Add user
                  </button>
                </div>
              }
              className="lg:col-span-2"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-3 font-medium">User</th>
                      <th className="py-2 pr-3 font-medium">Email</th>
                      <th className="py-2 pr-3 font-medium">Role</th>
                      <th className="py-2 pr-3 font-medium">Registered</th>
                      <th className="py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.users.map((user) => (
                      <tr key={user.id}>
                        <td className="py-2 pr-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{user.displayName}</p>
                            <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">@{user.login}</p>
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <span className="block max-w-[200px] truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                            {user.email ?? "—"}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {user.roles.length === 0 ? <RolePill role="none" /> : user.roles.map((role) => <RolePill key={role} role={role} />)}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">{shortDate(user.registered)}</td>
                        <td className="py-2 text-right">
                          <button type="button" className={BTN_SM} onClick={() => setManageId(user.id)}>
                            <UserCog className="h-3.5 w-3.5" aria-hidden /> Manage
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard
              title="Role distribution"
              description="How dashboard access is spread across roles."
              icon={UserCog}
              className="lg:col-span-2"
            >
              {data.roleCounts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  No roles assigned.
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {data.roleCounts.map((entry) => (
                    <div key={entry.role} className={cn("flex items-center justify-between gap-3", TILE)}>
                      <RolePill role={entry.role} />
                      <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{entry.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        )}
      </PanelState>

      {addOpen ? (
        <AddUserDialog site={site} open={addOpen} onClose={() => setAddOpen(false)} onChanged={state.reload} />
      ) : null}
      {managed ? (
        <ManageUserDialog
          site={site}
          user={managed}
          others={others}
          open={manageId !== null}
          onClose={() => setManageId(null)}
          onChanged={state.reload}
        />
      ) : null}
    </>
  );
}
