"use client";

/**
 * People (Users) panel — a full management table over the site's WordPress
 * accounts. Reads the `people` probe (id/login/displayName/email/roles/registered,
 * first 100, plus exact per-role headcounts and total) and wires every allow-listed
 * user action: add-user, update-user-email, update-user-role, set-user-password,
 * reset-user-password, delete-user (with optional content reassignment). Last-admin
 * and connector-service-account guardrails are enforced SERVER-SIDE (409) and their
 * messages surface inline; destructive delete additionally requires typing the login.
 *
 * Built on the Manage design-system kit (`./kit`): the roster is a `DataTable`, roles
 * are `Pill`s, the empty state is `EmptyState`, filtering uses `FilterTabs`, and the
 * delete block is fenced by `DangerZone`. Client-side search + role filter + bulk
 * select keep the panel usable on membership sites with hundreds of accounts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Mail, RefreshCw, Search, Trash2, UserCog, UserPlus, Users } from "lucide-react";
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
import { DangerZone, DataTable, EmptyState, FilterTabs, Pill } from "./kit";
import type { Column, FilterTabOption, PillTone } from "./kit";

type WordpressRoleName = (typeof WORDPRESS_ROLES)[number];

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const EMPTY_USERS: readonly WpUserRow[] = [];

// Compact controls for the floating bulk toolbar / row selection.
const BULK_SELECT =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
const CHECKBOX =
  "h-4 w-4 rounded border-zinc-300 text-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-600 dark:bg-zinc-900";

// Role → kit Pill tone. Colour rides WITH the role text, never alone.
const ROLE_PILL_TONE: Readonly<Record<string, PillTone>> = {
  administrator: "info",
  editor: "good",
  author: "good",
  contributor: "warn",
  subscriber: "neutral",
};
function roleToneOf(role: string): PillTone {
  return ROLE_PILL_TONE[role] ?? "neutral";
}

function RolePill({ role }: { role: string }) {
  return (
    <Pill tone={roleToneOf(role)}>
      <span className="capitalize">{role}</span>
    </Pill>
  );
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.split(" ")[0] || value;
}

/** Checkbox that supports the `indeterminate` visual state via a DOM ref. */
function SelectCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="flex cursor-pointer items-center justify-center p-1">
      <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} className={CHECKBOX} />
    </label>
  );
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
  const [role, setRole] = useState<WordpressRoleName>("subscriber");
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
          <select id="adduser-role" value={role} onChange={(e) => setRole(e.target.value as WordpressRoleName)} className={INPUT}>
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
    await run({ type: "update-user-role", userId: user.id, role: role as WordpressRoleName }, { onSuccess: reload });
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

          <DangerZone description="Deleting an account is permanent. Their content can be reassigned to another user.">
            <button type="button" className={BTN_DANGER_GHOST} disabled={pending} onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete user
            </button>
          </DangerZone>
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

const ROLE_FILTER_ALL = "all";

export function PeoplePanel({ site }: { site: string }) {
  const state = useManagePanel<PeopleData>(site, "people");
  const { run, pending } = useManageAction(site);

  const [addOpen, setAddOpen] = useState(false);
  const [manageId, setManageId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>(ROLE_FILTER_ALL);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [bulkRole, setBulkRole] = useState<WordpressRoleName>("subscriber");
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  const data = state.data;
  const users = data?.users ?? EMPTY_USERS;

  // Default sort: administrators first, then most-recently registered.
  const sorted = useMemo(() => {
    const copy = [...users];
    copy.sort((a, b) => {
      const aAdmin = a.roles.includes("administrator") ? 0 : 1;
      const bAdmin = b.roles.includes("administrator") ? 0 : 1;
      if (aAdmin !== bAdmin) return aAdmin - bAdmin;
      return (b.registered ?? "").localeCompare(a.registered ?? "");
    });
    return copy;
  }, [users]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((u) => {
      if (roleFilter !== ROLE_FILTER_ALL && !u.roles.includes(roleFilter)) return false;
      if (!q) return true;
      return (
        u.login.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [sorted, query, roleFilter]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const managed = useMemo(
    () => (manageId === null ? null : users.find((u) => u.id === manageId) ?? null),
    [manageId, users],
  );
  const others = useMemo(() => users.filter((u) => u.id !== manageId), [users, manageId]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((u) => selected.has(u.id));
  const someFilteredSelected = filtered.some((u) => selected.has(u.id));

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (filtered.every((u) => prev.has(u.id))) {
        filtered.forEach((u) => next.delete(u.id));
      } else {
        filtered.forEach((u) => next.add(u.id));
      }
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set<number>());
  }

  async function reconcile() {
    const result = await run({ type: "sync-users" });
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  function summarizeBulk(ok: number, failed: number, lastError: string, verb: string) {
    if (failed === 0) {
      toast.success(`${ok} user${ok === 1 ? "" : "s"} ${verb}.`);
    } else if (ok === 0) {
      toast.error(lastError || `Bulk action failed.`);
    } else {
      toast.error(`${ok} ${verb}, ${failed} failed${lastError ? ` — ${lastError}` : ""}.`);
    }
  }

  async function applyBulkRole() {
    if (selectedIds.length === 0) return;
    setBulkRunning(true);
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const id of selectedIds) {
      const res = await run({ type: "update-user-role", userId: id, role: bulkRole });
      if (res.ok) ok += 1;
      else {
        failed += 1;
        lastError = res.message;
      }
    }
    setBulkRunning(false);
    summarizeBulk(ok, failed, lastError, "updated");
    clearSelection();
    state.reload();
  }

  async function applyBulkDelete() {
    if (selectedIds.length === 0) return;
    setBulkRunning(true);
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const id of selectedIds) {
      const res = await run({ type: "delete-user", userId: id });
      if (res.ok) ok += 1;
      else {
        failed += 1;
        lastError = res.message;
      }
    }
    setBulkRunning(false);
    summarizeBulk(ok, failed, lastError, "deleted");
    setBulkDeleteOpen(false);
    clearSelection();
    state.reload();
  }

  const columns: Column<WpUserRow>[] = [
    {
      key: "select",
      header: (
        <SelectCheckbox
          checked={allFilteredSelected}
          indeterminate={!allFilteredSelected && someFilteredSelected}
          onChange={toggleAllFiltered}
          label="Select all users in view"
        />
      ),
      headClassName: "w-8",
      className: "w-8",
      // Bulk multi-select is a desktop power feature; the phone card stack drops it.
      mobileHidden: true,
      render: (u) => (
        <SelectCheckbox checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} label={`Select ${u.login}`} />
      ),
    },
    {
      key: "user",
      header: "User",
      // Phone card title.
      primary: true,
      render: (u) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{u.displayName}</p>
          <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">@{u.login}</p>
          <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{u.email ?? "—"}</p>
        </div>
      ),
    },
    {
      key: "roles",
      header: "Roles",
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.roles.length === 0 ? <RolePill role="none" /> : u.roles.map((r) => <RolePill key={r} role={r} />)}
        </div>
      ),
    },
    {
      key: "registered",
      header: "Registered",
      className: "whitespace-nowrap text-zinc-500 dark:text-zinc-400",
      render: (u) => shortDate(u.registered),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (u) => (
        <button type="button" className={cn(BTN_SM, "min-h-[24px]")} onClick={() => setManageId(u.id)}>
          <UserCog className="h-3.5 w-3.5" aria-hidden /> Manage
        </button>
      ),
    },
  ];

  return (
    <>
      <PanelState state={state}>
        {(d) => {
          if (d.users.length === 0) {
            return (
              <EmptyState
                icon={Users}
                title="No accounts on this site yet."
                body="Add a WordPress account or reconcile members from the directory."
                action={
                  <button type="button" className={BTN_PRIMARY} onClick={() => setAddOpen(true)}>
                    <UserPlus className="h-4 w-4" aria-hidden /> Add user
                  </button>
                }
              />
            );
          }

          const roleOptions: FilterTabOption<string>[] = [
            { value: ROLE_FILTER_ALL, label: "All", count: d.total },
            ...d.roleCounts.map((rc) => ({
              value: rc.role,
              label: <span className="capitalize">{rc.role}</span>,
              count: rc.count,
            })),
          ];
          const description =
            d.total > d.users.length
              ? `Showing ${d.users.length} of ${d.total} — search to find a specific user.`
              : `${d.total} account${d.total === 1 ? "" : "s"} with dashboard access.`;
          const isFiltered = query.trim().length > 0 || roleFilter !== ROLE_FILTER_ALL;

          return (
            <div className="grid gap-5 lg:grid-cols-2">
              <SectionCard
                title="Users"
                description={description}
                icon={Users}
                action={
                  <div className="flex gap-2">
                    <button type="button" className={BTN} disabled={pending || bulkRunning} onClick={reconcile}>
                      {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Reconcile
                    </button>
                    <button type="button" className={BTN_PRIMARY} onClick={() => setAddOpen(true)}>
                      <UserPlus className="h-4 w-4" aria-hidden /> Add user
                    </button>
                  </div>
                }
                className="lg:col-span-2"
              >
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="relative w-full sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search users…"
                      aria-label="Search users by name, username or email"
                      className={cn(INPUT, "pl-8")}
                    />
                  </div>
                  <FilterTabs
                    ariaLabel="Filter users by role"
                    value={roleFilter}
                    onChange={setRoleFilter}
                    options={roleOptions}
                  />
                </div>

                <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {filtered.length} of {d.users.length} shown{isFiltered ? " (filtered)" : ""}
                </p>

                <DataTable
                  caption="WordPress accounts on this site with their roles and registration dates"
                  columns={columns}
                  rows={filtered}
                  getRowKey={(u) => u.id}
                  empty={<span>No users match your search.</span>}
                />
              </SectionCard>

              <SectionCard
                title="Role distribution"
                description="How dashboard access is spread across roles."
                icon={UserCog}
                className="lg:col-span-2"
              >
                {d.roleCounts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                    No roles assigned.
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {d.roleCounts.map((entry) => (
                      <div key={entry.role} className={cn("flex items-center justify-between gap-3", TILE)}>
                        <RolePill role={entry.role} />
                        <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{entry.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>
          );
        }}
      </PanelState>

      {/* Floating bulk-action toolbar — appears only while rows are selected. */}
      {selectedIds.length > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div
            role="region"
            aria-label="Bulk user actions"
            className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white/95 p-2 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
          >
            <span className="px-1 text-xs font-medium tabular-nums text-zinc-700 dark:text-zinc-200">
              {selectedIds.length} selected
            </span>
            <div className="flex items-center gap-1.5">
              <label htmlFor="bulk-role" className="sr-only">
                Role to apply to selected users
              </label>
              <select
                id="bulk-role"
                value={bulkRole}
                onChange={(e) => setBulkRole(e.target.value as WordpressRoleName)}
                className={BULK_SELECT}
                disabled={bulkRunning}
              >
                {WORDPRESS_ROLES.map((r) => (
                  <option key={r} value={r} className="capitalize">
                    {r}
                  </option>
                ))}
              </select>
              <button type="button" className={cn(BTN_SM, "min-h-[24px]")} onClick={applyBulkRole} disabled={bulkRunning}>
                {bulkRunning ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <UserCog className="h-3.5 w-3.5" aria-hidden />} Change role
              </button>
            </div>
            <button
              type="button"
              className={cn(BTN_DANGER_GHOST, "min-h-[24px]")}
              onClick={() => setBulkDeleteOpen(true)}
              disabled={bulkRunning}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
            </button>
            <button
              type="button"
              className={cn(BTN_SM, "min-h-[24px]")}
              onClick={clearSelection}
              disabled={bulkRunning}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={applyBulkDelete}
        title={`Delete ${selectedIds.length} user${selectedIds.length === 1 ? "" : "s"}?`}
        description="This permanently removes the selected accounts."
        confirmLabel={`Delete ${selectedIds.length}`}
        confirmPhrase="delete"
        confirmPhraseLabel="Type delete to confirm"
        pending={bulkRunning}
        body={
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Their content is deleted unless reassigned elsewhere first. The last administrator and the connector service
            account are protected server-side and will be skipped.
          </p>
        }
      />

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
