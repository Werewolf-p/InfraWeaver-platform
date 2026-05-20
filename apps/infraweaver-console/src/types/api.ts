export interface ApiResponseMeta {
  timestamp?: string;
  requestId?: string;
  path?: string;
  [key: string]: unknown;
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta?: ApiResponseMeta;
}

export interface ApiErrorResponse {
  error: string;
  meta?: ApiResponseMeta;
  details?: unknown;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorResponse;

export interface MutationResponse {
  ok?: boolean;
  error?: string;
  message?: string;
}

export interface CatalogApp {
  name: string;
  description: string;
  host: string;
}

export interface PlatformConfigResponse {
  raw: string;
  sha: string;
  catalog: Record<string, unknown>;
  groups: Record<string, unknown>;
}

export interface UsersConfigResponse<TUser> {
  users: TUser[];
  sha: string;
  raw: string;
}
