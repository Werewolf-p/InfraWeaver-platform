"use client";

import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/notify";

interface MutationWithToastOptions<TData, TVariables, TContext = unknown> {
  mutationFn: (vars: TVariables) => Promise<TData>;
  successMessage: string | ((data: TData, vars: TVariables) => string);
  errorMessage?: string | ((error: Error, vars: TVariables) => string);
  /**
   * Optional pending-toast copy shown while the mutation is in flight. When set,
   * a loading toast appears on mutate and is replaced in place by the success or
   * error toast (promise-style), giving immediate feedback for slow infra actions.
   */
  loadingMessage?: string | ((vars: TVariables) => string);
  invalidateKeys?: string[][];
  onMutate?: (vars: TVariables) => Promise<TContext> | TContext;
  onSuccess?: (data: TData, vars: TVariables, context: TContext | undefined) => void;
  onError?: (error: Error, vars: TVariables, context: TContext | undefined) => void;
  onSettled?: () => void;
}

export function useMutationWithToast<TData, TVariables, TContext = unknown>(
  options: MutationWithToastOptions<TData, TVariables, TContext>
) {
  const qc = useQueryClient();
  const loadingToastIdRef = useRef<string | number | undefined>(undefined);

  return useMutation<TData, Error, TVariables, TContext>({
    mutationFn: options.mutationFn,
    onMutate: (vars) => {
      if (options.loadingMessage) {
        const pending = typeof options.loadingMessage === "function"
          ? options.loadingMessage(vars)
          : options.loadingMessage;
        loadingToastIdRef.current = toast.loading(pending);
      }
      return options.onMutate?.(vars) as TContext;
    },
    onSuccess: (data, vars, context) => {
      const msg = typeof options.successMessage === "function"
        ? options.successMessage(data, vars)
        : options.successMessage;
      const id = loadingToastIdRef.current;
      loadingToastIdRef.current = undefined;
      toast.success(msg, id != null ? { id } : undefined);
      if (options.invalidateKeys) {
        for (const key of options.invalidateKeys) {
          void qc.invalidateQueries({ queryKey: key });
        }
      }
      options.onSuccess?.(data, vars, context);
    },
    onError: (error, vars, context) => {
      const msg = typeof options.errorMessage === "function"
        ? options.errorMessage(error, vars)
        : (options.errorMessage ?? error.message ?? "An unexpected error occurred");
      const id = loadingToastIdRef.current;
      loadingToastIdRef.current = undefined;
      toast.error(msg, id != null ? { id } : undefined);
      options.onError?.(error, vars, context);
    },
    onSettled: () => {
      if (loadingToastIdRef.current != null) {
        toast.dismiss(loadingToastIdRef.current);
        loadingToastIdRef.current = undefined;
      }
      options.onSettled?.();
    },
  });
}
