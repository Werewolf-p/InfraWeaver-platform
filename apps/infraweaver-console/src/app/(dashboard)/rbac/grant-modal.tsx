"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  X, Plus, Search, User, Users, Info, ShieldCheck, Check, Ban, Clock, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_COLOR_CLASSES, scopeLabel, type RoleDefinition } from "@/lib/rbac";
import type { PlatformSubject } from "@/lib/rbac-viz-types";
import type { StagedGrant } from "./use-rbac-cart";
import {
  RESOURCE_TYPES,
  resourceTypeById,
  rolesForResource,
  gameServerInstanceScope,
  wordpressSiteScope,
  inferResourceType,
  type GrantIntent,
  type ResourceTypeId,
} from "./resources";

interface GrantModalProps {
  onClose: () => void;
  onStage: (grant: Omit<StagedGrant, "key">) => void;
  users: PlatformSubject[];
  groups: PlatformSubject[];
  gameServers: string[];
  wordpressSites: string[];
  wordpressLoading: boolean;
  initial?: GrantIntent;
}

function PermBadge({ perm }: { perm: string }) {
  const isWild = perm === "*";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border",
        isWild
          ? "bg-red-900/20 text-red-300 border-red-700/30"
          : "bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888] border-gray-200 dark:border-[#2a2a2a]",
      )}
    >
      {isWild && <ShieldCheck className="w-2.5 h-2.5" />}
      {perm}
    </span>
  );
}

/** Parse a per-instance identifier out of a prefilled scope. */
function instanceFromScope(scope: string, id: ResourceTypeId): string {
  if (id === "game-server") return scope.match(/^\/game-hub\/servers\/(.+)$/)?.[1] ?? "";
  if (id === "wordpress") return scope.match(/^\/wordpress\/sites\/(.+)$/)?.[1] ?? "";
  return "";
}

const SECTION_LABEL = "text-xs text-gray-500 dark:text-[#888] font-medium";
const CHIP_BASE = "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors";
const CHIP_ACTIVE = "border-[#0078D4] bg-[#0078D4]/15 text-[#0078D4] dark:text-[#4fc3f7]";
const CHIP_IDLE = "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-600 dark:text-[#888] hover:border-[#0078D4]/40";

export function GrantModal({
  onClose, onStage, users, groups, gameServers, wordpressSites, wordpressLoading, initial,
}: GrantModalProps) {
  const initialType = initial?.scope ? inferResourceType(initial.scope) : "cluster";

  const [principalType, setPrincipalType] = useState<"user" | "group">(initial?.subject?.principalType ?? "user");
  const [principal, setPrincipal] = useState<string>(initial?.subject?.principal ?? "");
  const [principalLabel, setPrincipalLabel] = useState<string>(initial?.subject?.principalLabel ?? "");
  const [subjectSearch, setSubjectSearch] = useState("");

  const [resourceTypeId, setResourceTypeId] = useState<ResourceTypeId>(initialType);
  const [serverName, setServerName] = useState<string>(initial?.scope ? instanceFromScope(initial.scope, initialType) : "");
  const [site, setSite] = useState<string>(initial?.scope ? instanceFromScope(initial.scope, initialType) : "");
  const [nasScope, setNasScope] = useState<string>(
    initial?.scope && initialType === "storage" ? initial.scope : "/nas",
  );

  const [roleId, setRoleId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [effect, setEffect] = useState<"Allow" | "Deny">("Allow");

  const resource = resourceTypeById(resourceTypeId);
  const roleOptions = useMemo(() => rolesForResource(resource), [resource]);

  const scope = useMemo(() => {
    if (resource.instance === "game-server") return serverName ? gameServerInstanceScope(serverName) : resource.allScope;
    if (resource.instance === "wordpress") return site ? wordpressSiteScope(site) : resource.allScope;
    if (resource.instance === "nas") return nasScope.trim() || resource.allScope;
    return resource.allScope;
  }, [resource, serverName, site, nasScope]);

  const selectedRole = roleOptions.find((role) => role.id === roleId);

  const pickResourceType = (id: ResourceTypeId) => {
    setResourceTypeId(id);
    setRoleId("");
  };

  const pickSubject = (type: "user" | "group", id: string, label: string) => {
    setPrincipalType(type);
    setPrincipal(id);
    setPrincipalLabel(label);
  };

  const query = subjectSearch.trim().toLowerCase();
  const matchedUsers = users.filter((u) => !query || u.name.toLowerCase().includes(query) || (u.secondary ?? "").toLowerCase().includes(query));
  const matchedGroups = groups.filter((g) => !query || g.name.toLowerCase().includes(query));

  const canStage = Boolean(principal) && Boolean(roleId) && Boolean(scope);

  const stage = () => {
    if (!canStage) return;
    onStage({
      principalType,
      principal,
      principalLabel: principalLabel || principal,
      roleId,
      scope,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(effect === "Deny" ? { effect } : {}),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-black/75">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-[#2a2a2a] dark:bg-[#111]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0078D4]/20"><Plus className="h-4 w-4 text-[#0078D4]" /></span>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Grant access</h2>
              <p className="text-[10px] text-gray-400 dark:text-[#8a8a8a]">Give a user or group a role on any resource</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-700 dark:text-[#8a8a8a] dark:hover:text-[#888]"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-5 overflow-y-auto p-5">
          {/* Step 1 — Subject */}
          <section className="space-y-2">
            <p className={SECTION_LABEL}>1 · Who</p>
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-[#2a2a2a]">
              {(["user", "group"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => { setPrincipalType(type); setPrincipal(""); setPrincipalLabel(""); }}
                  className={cn("flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
                    principalType === type ? "bg-[#0078D4] text-white" : "text-gray-500 hover:text-gray-900 dark:text-[#888] dark:hover:text-[#f2f2f2]")}
                >
                  {type === "user" ? <User className="h-3 w-3" /> : <Users className="h-3 w-3" />} {type}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={subjectSearch}
                onChange={(e) => setSubjectSearch(e.target.value)}
                placeholder={principalType === "user" ? "Search users…" : "Search groups…"}
                className="h-8 w-full rounded-lg border border-gray-200 bg-white pl-8 pr-2.5 text-xs text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
              />
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-1 dark:border-[#2a2a2a]">
              {(principalType === "user" ? matchedUsers : matchedGroups).map((subject) => {
                const active = principal === subject.name;
                return (
                  <button
                    key={subject.id}
                    type="button"
                    onClick={() => pickSubject(principalType, subject.name, principalType === "user" ? (subject.secondary || subject.name) : subject.name)}
                    className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                      active ? "bg-[#0078D4]/15 text-[#0078D4] dark:text-[#4fc3f7]" : "text-gray-700 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-white/5")}
                  >
                    <span className="min-w-0 truncate">
                      {subject.name}
                      {principalType === "user" && subject.secondary ? <span className="ml-1.5 text-[10px] text-slate-400">{subject.secondary}</span> : null}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                  </button>
                );
              })}
              {(principalType === "user" ? matchedUsers : matchedGroups).length === 0 && (
                <p className="px-2.5 py-3 text-center text-[11px] text-slate-400">No {principalType === "user" ? "users" : "groups"} match.</p>
              )}
            </div>
          </section>

          {/* Step 2 — Resource */}
          <section className="space-y-2">
            <p className={SECTION_LABEL}>2 · Where</p>
            <div className="flex flex-wrap gap-1.5">
              {RESOURCE_TYPES.map((rt) => {
                const Icon = rt.icon;
                return (
                  <button key={rt.id} type="button" onClick={() => pickResourceType(rt.id)} className={cn(CHIP_BASE, resourceTypeId === rt.id ? CHIP_ACTIVE : CHIP_IDLE)}>
                    <Icon className="h-3.5 w-3.5" /> {rt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-[#8a8a8a]">{resource.description}</p>

            {resource.instance === "game-server" && (
              <InstancePicker
                allLabel={resource.allLabel}
                allActive={!serverName}
                onAll={() => setServerName("")}
                items={gameServers}
                selected={serverName}
                onSelect={setServerName}
                emptyHint="No game servers deployed."
              />
            )}
            {resource.instance === "wordpress" && (
              <InstancePicker
                allLabel={resource.allLabel}
                allActive={!site}
                onAll={() => setSite("")}
                items={wordpressSites}
                selected={site}
                onSelect={setSite}
                loading={wordpressLoading}
                emptyHint="No WordPress sites found."
              />
            )}
            {resource.instance === "nas" && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setNasScope("/nas")} className={cn(CHIP_BASE, nasScope.trim() === "/nas" ? CHIP_ACTIVE : CHIP_IDLE)}>
                    <Layers className="h-3.5 w-3.5" /> {resource.allLabel}
                  </button>
                </div>
                <input
                  value={nasScope}
                  onChange={(e) => setNasScope(e.target.value)}
                  placeholder="/nas/<provider>/<share>"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
                />
                <p className="text-[10px] text-gray-400 dark:text-[#8a8a8a]">Storage scopes are lowercase — a grant on a share cascades to its folders.</p>
              </div>
            )}

            <p className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-[#888]">
              <Info className="h-3 w-3" /> Scope <span className="font-mono text-slate-600 dark:text-slate-400">{scope}</span> — {scopeLabel(scope)}
            </p>
          </section>

          {/* Step 3 — Role + options */}
          <section className="space-y-2">
            <p className={SECTION_LABEL}>3 · Which role</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {roleOptions.map((role) => (
                <RoleOption key={role.id} role={role} selected={roleId === role.id} onClick={() => setRoleId(role.id)} />
              ))}
            </div>
            {selectedRole && (
              <div className="space-y-1.5 rounded-lg border border-gray-200 bg-white p-3 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]">
                <p className="text-[11px] font-medium text-gray-500 dark:text-[#888]">Permissions granted</p>
                <div className="flex flex-wrap gap-1">{selectedRole.permissions.map((p) => <PermBadge key={p} perm={p} />)}</div>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-4 pt-1">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#8a8a8a]">Expiry (optional)</label>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#8a8a8a]">Effect</label>
                <div className="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-[#2a2a2a]">
                  {(["Allow", "Deny"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setEffect(value)}
                      className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        effect === value
                          ? value === "Deny" ? "bg-red-500 text-white" : "bg-emerald-600 text-white"
                          : "text-gray-500 hover:text-gray-900 dark:text-[#888] dark:hover:text-[#f2f2f2]")}
                    >
                      {value === "Deny" ? <Ban className="h-3 w-3" /> : <Check className="h-3 w-3" />} {value}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {effect === "Deny" && (
              <p className="text-[10px] text-red-400">A Deny removes this role&apos;s permissions at (and below) the scope and wins over any Allow.</p>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-gray-200 bg-white px-5 py-4 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]">
          <span className="min-w-0 truncate text-[11px] text-slate-400">
            {principal ? <>Staging for <span className="text-slate-600 dark:text-slate-300">{principalLabel || principal}</span></> : "Pick a subject to continue"}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-900 dark:text-[#888] dark:hover:text-[#f2f2f2]">Cancel</button>
            <button
              onClick={stage}
              disabled={!canStage}
              className="flex items-center gap-1.5 rounded-lg bg-[#0078D4] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#006cbd] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {expiresAt ? <Clock className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />} Add to staged changes
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function RoleOption({ role, selected, onClick }: { role: RoleDefinition; selected: boolean; onClick: () => void }) {
  const colors = ROLE_COLOR_CLASSES[role.color ?? "gray"];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("rounded-lg border p-2.5 text-left transition-all",
        selected ? "border-[#0078D4] bg-[#0078D4]/10" : "border-gray-200 bg-white hover:border-[#0078D4]/40 dark:border-[#2a2a2a] dark:bg-[#0d0d0d]")}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn("h-2 w-2 flex-shrink-0 rounded-full", colors.dot)} />
        <span className="text-xs font-semibold text-gray-900 dark:text-[#f2f2f2]">{role.name}</span>
      </span>
      <span className="mt-0.5 block text-[10px] leading-snug text-gray-400 dark:text-[#9a9a9a]">{role.description}</span>
    </button>
  );
}

interface InstancePickerProps {
  allLabel: string;
  allActive: boolean;
  onAll: () => void;
  items: string[];
  selected: string;
  onSelect: (value: string) => void;
  loading?: boolean;
  emptyHint: string;
}

function InstancePicker({ allLabel, allActive, onAll, items, selected, onSelect, loading, emptyHint }: InstancePickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={onAll} className={cn(CHIP_BASE, allActive ? CHIP_ACTIVE : CHIP_IDLE)}>
        <Layers className="h-3.5 w-3.5" /> {allLabel}
      </button>
      {loading ? (
        <span className="px-2 py-1.5 text-[11px] text-slate-400">Loading…</span>
      ) : items.length === 0 ? (
        <span className="px-2 py-1.5 text-[11px] text-slate-400">{emptyHint}</span>
      ) : (
        items.map((item) => (
          <button key={item} type="button" onClick={() => onSelect(item)} className={cn(CHIP_BASE, selected === item ? CHIP_ACTIVE : CHIP_IDLE)}>
            {item}
          </button>
        ))
      )}
    </div>
  );
}
