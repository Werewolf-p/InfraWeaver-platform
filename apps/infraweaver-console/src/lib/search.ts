export type SearchResultCategory =
  | "navigation"
  | "game-server"
  | "pod"
  | "app"
  | "setting";

export type SearchResult = {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  category: SearchResultCategory;
  icon?: string;
  badge?: string;
  badgeColor?: string;
};

export interface SearchResponse {
  navigation: SearchResult[];
  gameServers: SearchResult[];
  pods: SearchResult[];
  apps: SearchResult[];
  settings: SearchResult[];
}

export const EMPTY_SEARCH_RESPONSE: SearchResponse = {
  navigation: [],
  gameServers: [],
  pods: [],
  apps: [],
  settings: [],
};

export const SEARCH_CATEGORY_LABELS: Record<SearchResultCategory, string> = {
  navigation: "Navigation",
  "game-server": "Game Servers",
  pod: "Pods",
  app: "Apps",
  setting: "Settings",
};
