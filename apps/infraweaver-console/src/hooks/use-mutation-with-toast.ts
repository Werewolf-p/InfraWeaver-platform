"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface MutationWithToastOptions<TData, TVariables, TContext = unknown> {
  mutationFn: (vars: TVariables) => Promise<TData>;
  successMessage: string | ((data: TData, vars: TVariables) => string);
  errorMessage?: string | ((error: Error, vars: TVariables) => string);
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

  return useMutation<TData, Error, TVariables, TContext>({
    mutationFn: options.mutationFn,
    onMutate: options.onMutate,
    onSuccess: (data, vars, context) => {
      const msg = typeof options.successMessage === "function"
        ? options.successMessage(data, vars)
        : options.successMessage;
      toast.success(msg);
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
      toast.error(msg);
      options.onError?.(error, vars, context);
    },
    onSettled: options.onSettled,
  });
}
