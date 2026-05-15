"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import type { ScheduledTask } from "@/types/cluster";

export interface ScheduledTaskFormValues {
  name: string;
  namespace: string;
  pod: string;
  schedule: string;
  command: string;
}

export function useScheduledTasks() {
  const queryClient = useQueryClient();

  const query = useQuery<{ tasks: ScheduledTask[] }>({
    queryKey: queryKeys.cluster.scheduledTasks(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/scheduled-tasks");
      if (!response.ok) throw new Error("Failed to load scheduled tasks");
      return response.json();
    },
    staleTime: 30_000,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.cluster.scheduledTasks() });
  };

  const createTask = useMutation({
    mutationFn: async (body: ScheduledTaskFormValues) => {
      const response = await fetch("/api/cluster/scheduled-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Failed to create task");
      return response.json();
    },
    onSuccess: async () => {
      toast.success("Task created");
      await invalidate();
    },
    onError: () => toast.error("Failed to create task"),
  });

  const deleteTask = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/cluster/scheduled-tasks?id=${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete task");
    },
    onSuccess: async () => {
      toast.success("Task deleted");
      await invalidate();
    },
    onError: () => toast.error("Failed to delete task"),
  });

  const toggleTask = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const response = await fetch("/api/cluster/scheduled-tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      if (!response.ok) throw new Error("Failed to update task");
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: () => toast.error("Failed to update task"),
  });

  return {
    ...query,
    tasks: query.data?.tasks ?? [],
    createTask,
    deleteTask,
    toggleTask,
  };
}
