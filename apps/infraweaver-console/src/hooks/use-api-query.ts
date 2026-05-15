"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient, type ApiRequestOptions, toApiErrorMessage } from "@/lib/api-client";

type Resolvable<TVariables, TValue> = TValue | ((variables: TVariables) => TValue);

type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

type MutationInvalidateKeys<TData, TVariables> =
  | QueryKey[]
  | ((data: TData, variables: TVariables) => QueryKey[]);

interface UseApiQueryOptions<TQueryFnData, TData = TQueryFnData>
  extends Omit<UseQueryOptions<TQueryFnData, Error, TData, QueryKey>, "queryFn" | "queryKey"> {
  queryKey: QueryKey;
  path: string;
  request?: Omit<ApiRequestOptions, "method">;
}

interface UseApiMutationOptions<TData, TVariables, TContext = unknown>
  extends Omit<UseMutationOptions<TData, Error, TVariables, TContext>, "mutationFn" | "onSuccess" | "onError"> {
  path: Resolvable<TVariables, string>;
  method?: MutationMethod;
  request?: Resolvable<TVariables, Omit<ApiRequestOptions, "method">>;
  invalidateQueryKeys?: MutationInvalidateKeys<TData, TVariables>;
  successMessage?: string | ((data: TData, variables: TVariables) => string | undefined);
  errorMessage?: string | ((error: Error, variables: TVariables) => string | undefined);
  onSuccess?: UseMutationOptions<TData, Error, TVariables, TContext>["onSuccess"];
  onError?: UseMutationOptions<TData, Error, TVariables, TContext>["onError"];
}

function resolveValue<TVariables, TValue>(value: Resolvable<TVariables, TValue> | undefined, variables: TVariables) {
  return typeof value === "function" ? (value as (input: TVariables) => TValue)(variables) : value;
}

function resolveInvalidateKeys<TData, TVariables>(
  value: MutationInvalidateKeys<TData, TVariables> | undefined,
  data: TData,
  variables: TVariables,
) {
  return typeof value === "function" ? value(data, variables) : value;
}

export function useApiQuery<TQueryFnData, TData = TQueryFnData>({ queryKey, path, request, ...options }: UseApiQueryOptions<TQueryFnData, TData>) {
  return useQuery<TQueryFnData, Error, TData, QueryKey>({
    ...options,
    queryKey,
    queryFn: () => apiClient.get<TQueryFnData>(path, request),
  });
}

export function useApiMutation<TData, TVariables = void, TContext = unknown>({
  path,
  method = "POST",
  request,
  invalidateQueryKeys,
  successMessage,
  errorMessage,
  onSuccess,
  onError,
  ...options
}: UseApiMutationOptions<TData, TVariables, TContext>) {
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVariables, TContext>({
    ...options,
    mutationFn: async (variables) => {
      const resolvedRequest = resolveValue(request, variables) ?? {};
      const needsAutoJsonBody = method !== "DELETE" && resolvedRequest.body === undefined && resolvedRequest.json === undefined;

      const resolvedPath = resolveValue(path, variables);
      if (!resolvedPath) {
        throw new Error("Mutation path is required");
      }

      return apiClient.request<TData>(resolvedPath, {
        ...resolvedRequest,
        method,
        ...(needsAutoJsonBody && variables !== undefined ? { json: variables } : {}),
      });
    },
    onSuccess: async (data, variables, onMutateResult, context) => {
      const keys = resolveInvalidateKeys(invalidateQueryKeys, data, variables);
      if (keys?.length) {
        await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      }

      const message = typeof successMessage === "function" ? successMessage(data, variables) : successMessage;
      if (message) {
        toast.success(message);
      }

      await onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: async (error, variables, onMutateResult, context) => {
      const message = typeof errorMessage === "function"
        ? errorMessage(error, variables)
        : errorMessage;

      if (message) {
        toast.error(message);
      } else {
        toast.error(toApiErrorMessage(error));
      }

      await onError?.(error, variables, onMutateResult, context);
    },
  });
}
