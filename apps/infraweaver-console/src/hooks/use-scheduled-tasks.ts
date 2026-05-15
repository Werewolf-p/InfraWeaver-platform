"use client";

import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { ScheduledTask, ScheduledTaskFormValues, ScheduledTasksResponse } from "@/types";
import { useApiMutation, useApiQuery } from "./use-api-query";

export type { ScheduledTaskFormValues } from "@/types";

const scheduledTaskQueryKeys = [queryKeys.cluster.scheduledTasks()];

export function useScheduledTasks() {
  const query = useApiQuery<ScheduledTasksResponse>({
    queryKey: queryKeys.cluster.scheduledTasks(),
    path: "/api/cluster/scheduled-tasks",
    staleTime: queryStaleTimes.short,
  });

  const createTask = useApiMutation<{ task: ScheduledTask }, ScheduledTaskFormValues>({
    path: "/api/cluster/scheduled-tasks",
    method: "POST",
    invalidateQueryKeys: scheduledTaskQueryKeys,
    successMessage: "Task created",
    errorMessage: "Failed to create task",
  });

  const deleteTask = useApiMutation<{ ok: boolean }, string>({
    path: "/api/cluster/scheduled-tasks",
    method: "DELETE",
    request: (id) => ({ query: { id } }),
    invalidateQueryKeys: scheduledTaskQueryKeys,
    successMessage: "Task deleted",
    errorMessage: "Failed to delete task",
  });

  const toggleTask = useApiMutation<{ task: ScheduledTask }, { id: string; enabled: boolean }>({
    path: "/api/cluster/scheduled-tasks",
    method: "PATCH",
    invalidateQueryKeys: scheduledTaskQueryKeys,
    errorMessage: "Failed to update task",
  });

  return {
    ...query,
    tasks: query.data?.tasks ?? [],
    createTask,
    deleteTask,
    toggleTask,
  };
}
