"use client";

/**
 * "Grant existing user" dialog — pick an existing Authentik user from a searchable
 * directory and grant them access to THIS site with a chosen WordPress role. On
 * submit the server does two coordinated writes (RBAC access grant scoped to the
 * site + a signed, idempotent pre-create of the WordPress account by email), so the
 * person's first SSO login lands on an account that already has the chosen role — no
 * duplicate. Sits beside "Add user" in the People panel.
 *
 * Distinct from AddUserDialog: that creates a raw WordPress-only account; this wires
 * an Authentik identity to the site through InfraWeaver RBAC, which is what actually
 * authorizes the Authentik SSO gate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { WORDPRESS_ROLES } from "../../../lib/manage/capabilities";
import { Spinner } from "./panel-shell";
import { ActionError, BTN, BTN_PRIMARY, Field, INPUT, Modal } from "./manage-ui";

type WordpressRoleName = (typeof WORDPRESS_ROLES)[number];

/** Picker row — mirrors the server's AuthentikUserSummary (client can't import server-only). */
interface AuthentikUserSummary {
  readonly username: string;
  readonly email: string;
  readonly name: string;
}

interface GrantResult {
  ok?: boolean;
  rbac?: "granted" | "already-granted";
  wpAccount?: "ensured" | "deferred";
  wpRole?: string;
  wpAccountNote?: string;
  error?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

const RESULT_ROW =
  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none dark:hover:bg-zinc-800/60 dark:focus-visible:bg-zinc-800/60";

async function grantMessage(result: GrantResult): Promise<string> {
  const roleLabel = result.wpRole ?? "member";
  const base =
    result.rbac === "already-granted"
      ? `Already had access — role ensured as ${roleLabel}.`
      : `Access granted as ${roleLabel}.`;
  if (result.wpAccount === "deferred") {
    return `${base} ${result.wpAccountNote ?? "The WordPress account will be created on the next reconcile."}`;
  }
  return base;
}

export function GrantUserDialog({
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly AuthentikUserSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AuthentikUserSummary | null>(null);
  const [role, setRole] = useState<WordpressRoleName>("subscriber");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ignore out-of-order search responses: only the newest request's rows win.
  const reqIdRef = useRef(0);

  const runSearch = useCallback(
    async (q: string) => {
      const reqId = ++reqIdRef.current;
      setSearching(true);
      try {
        const res = await fetch(`/api/wordpress/sites/${site}/authentik-users?q=${encodeURIComponent(q)}`);
        const body = (await res.json().catch(() => null)) as { users?: AuthentikUserSummary[]; error?: string } | null;
        if (reqId !== reqIdRef.current) return; // a newer search superseded this one
        if (!res.ok) {
          setResults([]);
          setError(body?.error ?? "Could not search the directory.");
          return;
        }
        setError(null);
        setResults(body?.users ?? []);
      } catch {
        if (reqId === reqIdRef.current) setResults([]);
      } finally {
        if (reqId === reqIdRef.current) setSearching(false);
      }
    },
    [site],
  );

  // Debounced search whenever the query changes and nothing is selected yet.
  useEffect(() => {
    if (!open || selected) return;
    const handle = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [open, query, selected, runSearch]);

  // Reset everything when the dialog closes so a reopen starts clean.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setResults([]);
    setSelected(null);
    setRole("subscriber");
    setError(null);
    setPending(false);
  }, [open]);

  function pick(user: AuthentikUserSummary) {
    setSelected(user);
    setResults([]);
    setError(null);
  }

  function clearSelection() {
    setSelected(null);
    setQuery("");
  }

  async function submit() {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/wordpress/sites/${site}/grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: selected.username, role }),
      });
      const body = (await res.json().catch(() => null)) as GrantResult | null;
      if (!res.ok || !body) {
        setError(body?.error ?? `Grant failed (${res.status}).`);
        return;
      }
      toast.success(await grantMessage(body));
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grant failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Grant existing user"
      description="Give an Authentik user access to this site — their account is pre-created so first sign-in just works."
      icon={UserCheck}
    >
      <div className="space-y-4">
        {selected ? (
          <Field label="User" htmlFor="grant-selected">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{selected.name}</p>
                <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  @{selected.username} · {selected.email}
                </p>
              </div>
              <button type="button" className={BTN} onClick={clearSelection} disabled={pending}>
                Change
              </button>
            </div>
          </Field>
        ) : (
          <Field label="Find a user" htmlFor="grant-search" hint="Search Authentik by name, username or email.">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                id="grant-search"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search users…"
                aria-label="Search Authentik users"
                className={cn(INPUT, "pl-8")}
              />
            </div>
            <div
              role="listbox"
              aria-label="Matching Authentik users"
              className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              {searching ? (
                <p className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                  <Spinner /> Searching…
                </p>
              ) : results.length === 0 ? (
                <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                  {query.trim() ? "No matching users." : "Type to search the directory."}
                </p>
              ) : (
                results.map((user) => (
                  <button
                    key={user.username}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={RESULT_ROW}
                    onClick={() => pick(user)}
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{user.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      @{user.username} · {user.email}
                    </span>
                  </button>
                ))
              )}
            </div>
          </Field>
        )}

        <Field label="WordPress role" htmlFor="grant-role" required>
          <select
            id="grant-role"
            value={role}
            onChange={(e) => setRole(e.target.value as WordpressRoleName)}
            className={INPUT}
            disabled={pending}
          >
            {WORDPRESS_ROLES.map((r) => (
              <option key={r} value={r} className="capitalize">
                {r}
              </option>
            ))}
          </select>
        </Field>

        {error ? <ActionError message={error} onDismiss={() => setError(null)} /> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={BTN} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={!selected || pending}>
            {pending ? <Spinner /> : null} Grant access
          </button>
        </div>
      </div>
    </Modal>
  );
}
