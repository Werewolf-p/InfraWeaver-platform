"use client";

import { motion } from "framer-motion";
import { Clock, Lock, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataCard } from "@/components/ui/data-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResourceTable, type Column } from "@/components/ui/resource-table";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { usePermissions } from "@/hooks/use-permissions";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { useScheduledTasks, type ScheduledTaskFormValues } from "@/hooks/use-scheduled-tasks";
import { cn, timeAgo } from "@/lib/utils";
import type { ScheduledTask } from "@/types/cluster";

interface PodSummary {
  name: string;
  namespace: string;
  status: string;
}

const DEFAULT_FORM: ScheduledTaskFormValues = {
  name: "",
  namespace: "default",
  pod: "",
  schedule: "0 * * * *",
  command: "ls",
};

const ORDINAL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Human-readable summary for common 5-field cron expressions; falls back to a generic hint. */
function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "Enter a 5-field cron expression (minute hour day month weekday).";
  const [min, hour, dom, month, dow] = parts;

  const everyStep = (field: string): number | null => {
    const match = /^\*\/(\d+)$/.exec(field);
    return match ? Number(match[1]) : null;
  };

  const minStep = everyStep(min);
  if (minStep && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Runs every ${minStep} minute${minStep === 1 ? "" : "s"}.`;
  }
  const hourStep = everyStep(hour);
  if (hourStep && dom === "*" && month === "*" && dow === "*" && /^\d+$/.test(min)) {
    return `Runs every ${hourStep} hour${hourStep === 1 ? "" : "s"} at :${pad2(Number(min))}.`;
  }
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Runs every minute.";
  }
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Runs hourly at :${pad2(Number(min))}.`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && month === "*") {
    const time = `${pad2(Number(hour))}:${pad2(Number(min))}`;
    if (dom === "*" && dow === "*") return `Runs daily at ${time}.`;
    if (dom === "*" && /^\d+$/.test(dow) && Number(dow) <= 6) return `Runs weekly on ${ORDINAL_DAYS[Number(dow)]} at ${time}.`;
    if (/^\d+$/.test(dom) && dow === "*") return `Runs monthly on day ${dom} at ${time}.`;
  }
  return "Custom schedule — verify the cron fields carefully.";
}

export function ScheduledTasksView() {
  const { can, canAny } = usePermissions();
  const canViewTasks = canAny(["cluster:read", "infra:read"]);
  const canManageTasks = can("cluster:admin");
  const [showForm, setShowForm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);
  const [form, setForm] = useState<ScheduledTaskFormValues>(DEFAULT_FORM);
  const [search, setSearch] = useLocalStorage("scheduled-tasks-search", "");
  const debouncedSearch = useDebounce(search, 200);
  const { tasks, isLoading, refetch, createTask, deleteTask, toggleTask } = useScheduledTasks();
  const { data: podsData } = useApiQuery<PodSummary[]>({
    queryKey: ["pods"],
    path: "/api/pods",
    enabled: canManageTasks,
  });

  useRefetchInterval(() => refetch(), 30_000, canViewTasks);

  const pods = useMemo(() => podsData ?? [], [podsData]);
  const namespaceOptions = useMemo(() => Array.from(new Set(pods.map((pod) => pod.namespace))).sort(), [pods]);
  const podOptions = useMemo(
    () => pods.filter((pod) => pod.namespace === form.namespace).map((pod) => pod.name).sort(),
    [pods, form.namespace],
  );
  const cronPreview = useMemo(() => describeCron(form.schedule), [form.schedule]);

  const filteredTasks = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return tasks;

    return tasks.filter((task) =>
      [task.name, task.namespace, task.pod, task.schedule, task.command].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [debouncedSearch, tasks]);

  const columns: Column<ScheduledTask>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Name",
        sortable: true,
        render: (task) => (
          <div>
            <p className="font-medium text-gray-900 dark:text-white">{task.name}</p>
            <p className="text-xs text-slate-500">Created {timeAgo(task.createdAt)}</p>
          </div>
        ),
      },
      {
        key: "schedule",
        label: "Schedule",
        sortable: true,
        render: (task) => <span className="font-mono text-xs text-slate-700 dark:text-slate-300">{task.schedule}</span>,
      },
      {
        key: "pod",
        label: "Target",
        sortable: true,
        render: (task) => <span className="text-sm text-slate-500 dark:text-slate-400">{task.namespace}/{task.pod}</span>,
      },
      {
        key: "command",
        label: "Command",
        render: (task) => <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{task.command}</span>,
      },
      {
        key: "enabled",
        label: "Status",
        sortable: true,
        render: (task) => (
          <StatusBadge
            status={task.enabled ? "healthy" : "unknown"}
            label={task.enabled ? "Enabled" : "Disabled"}
            size="sm"
          />
        ),
      },
      {
        key: "actions",
        label: "Actions",
        className: "text-right",
        render: (task) => (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => toggleTask.mutate({ id: task.id, enabled: !task.enabled })}
              disabled={!canManageTasks || toggleTask.isPending}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                task.enabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
              )}
            >
              {task.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => setPendingDelete(task)}
              disabled={!canManageTasks || deleteTask.isPending}
              className="text-red-400 transition-colors hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`Delete ${task.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    [canManageTasks, deleteTask.isPending, toggleTask],
  );

  const handleCreateTask = async () => {
    await createTask.mutateAsync(form);
    setForm(DEFAULT_FORM);
    setShowForm(false);
  };

  if (!canViewTasks) {
    return (
      <EmptyState
        icon={Lock}
        title="Scheduled tasks are restricted"
        description="You do not have permission to view scheduled task automation."
      />
    );
  }

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const disabledCount = tasks.length - enabledCount;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={Clock}
        title="Scheduled Tasks"
        description="Pod restart and command scheduling"
        badge={`${tasks.length} total`}
        actions={
          <button
            type="button"
            onClick={() => canManageTasks && setShowForm((open) => !open)}
            disabled={!canManageTasks}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {showForm ? "Hide Form" : "Add Task"}
          </button>
        }
      />

      <div className="grid gap-3 md:grid-cols-3">
        <DataCard title="Total Tasks" value={tasks.length} subtitle="Automation jobs configured" />
        <DataCard title="Enabled" value={enabledCount} subtitle="Tasks currently running" trend="up" />
        <DataCard title="Disabled" value={disabledCount} subtitle="Paused automation jobs" trend={disabledCount > 0 ? "down" : undefined} />
      </div>

      {showForm ? (
        <div className="space-y-3 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4 backdrop-blur-sm">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Create scheduled task</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
              <input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="nightly-restart"
                className="min-h-[44px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Namespace</span>
              {namespaceOptions.length > 0 ? (
                <Select
                  value={form.namespace}
                  onChange={(event) => setForm((current) => ({ ...current, namespace: event.target.value, pod: "" }))}
                  selectSize="sm"
                >
                  {!namespaceOptions.includes(form.namespace) ? <option value={form.namespace}>{form.namespace}</option> : null}
                  {namespaceOptions.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
                </Select>
              ) : (
                <input
                  value={form.namespace}
                  onChange={(event) => setForm((current) => ({ ...current, namespace: event.target.value }))}
                  placeholder="default"
                  className="min-h-[44px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
                />
              )}
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Target pod</span>
              {podOptions.length > 0 ? (
                <Select
                  value={form.pod}
                  onChange={(event) => setForm((current) => ({ ...current, pod: event.target.value }))}
                  selectSize="sm"
                >
                  <option value="">Select a pod…</option>
                  {podOptions.map((pod) => <option key={pod} value={pod}>{pod}</option>)}
                </Select>
              ) : (
                <input
                  value={form.pod}
                  onChange={(event) => setForm((current) => ({ ...current, pod: event.target.value }))}
                  placeholder={pods.length > 0 ? "No live pods in this namespace" : "pod name"}
                  className="min-h-[44px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
                />
              )}
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Command</span>
              <input
                value={form.command}
                onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))}
                placeholder="ls"
                className="min-h-[44px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 font-mono text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
              />
            </label>
            <label className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Schedule (cron)</span>
              <input
                value={form.schedule}
                onChange={(event) => setForm((current) => ({ ...current, schedule: event.target.value }))}
                placeholder="0 * * * *"
                aria-describedby="cron-preview"
                className="min-h-[44px] rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 font-mono text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
              />
              <span id="cron-preview" className="text-xs text-slate-500 dark:text-slate-400">{cronPreview}</span>
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setForm(DEFAULT_FORM);
                setShowForm(false);
              }}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-200 dark:border-white/10 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreateTask()}
              disabled={createTask.isPending || !canManageTasks}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-4 py-2 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 disabled:opacity-50"
            >
              {createTask.isPending ? "Creating..." : "Create Task"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput placeholder="Search tasks, namespaces, pods, or commands" value={search} onChange={setSearch} className="sm:max-w-md" />
        <p className="text-sm text-slate-500">Showing {filteredTasks.length} of {tasks.length} tasks</p>
      </div>

      <ResourceTable
        tableId="scheduled-tasks-table"
        caption="Scheduled tasks table"
        columns={columns}
        data={filteredTasks}
        loading={isLoading}
        getRowKey={(task) => task.id}
        empty={
          <EmptyState
            icon={Clock}
            title={tasks.length === 0 ? "No scheduled tasks yet" : "No tasks match your search"}
            description={
              tasks.length === 0
                ? "Create a shared task once, then reuse the same workflow whenever you need pod automation."
                : "Try a different name, namespace, pod, or command filter."
            }
            action={
              tasks.length === 0 && canManageTasks
                ? { label: "Create task", onClick: () => setShowForm(true) }
                : undefined
            }
          />
        }
        mobileCardRender={(task) => (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-gray-900 dark:text-white">{task.name}</p>
                <p className="text-xs text-slate-500">{task.namespace}/{task.pod}</p>
              </div>
              <StatusBadge
                status={task.enabled ? "healthy" : "unknown"}
                label={task.enabled ? "Enabled" : "Disabled"}
                size="sm"
              />
            </div>
            <div className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
              <p><span className="text-slate-500">Schedule:</span> <span className="font-mono">{task.schedule}</span></p>
              <p><span className="text-slate-500">Command:</span> <span className="font-mono">{task.command}</span></p>
              <p><span className="text-slate-500">Last run:</span> {task.lastRun ? timeAgo(task.lastRun) : "Never"}</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => toggleTask.mutate({ id: task.id, enabled: !task.enabled })}
                disabled={!canManageTasks || toggleTask.isPending}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  task.enabled
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
                )}
              >
                {task.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(task)}
                disabled={!canManageTasks || deleteTask.isPending}
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteTask.mutate(pendingDelete.id, {
            onSuccess: () => setPendingDelete(null),
          });
        }}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : "Delete task?"}
        description="This removes the scheduled task definition but does not change any existing pods."
        confirmText="Delete"
        danger
      />
    </motion.div>
  );
}
