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
