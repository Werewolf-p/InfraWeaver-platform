"use client";

import {
  ALL_NAV_ITEMS as NAV_ITEMS,
  MOBILE_BOTTOM_NAV,
} from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";

export const STORAGE_KEY = "nav-favorites";
export const MAX_NAV_FAVORITES = 4;

export const ALL_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item, index, items) =>
  items.findIndex((entry) => entry.href === item.href) === index,
);

export const DEFAULT_FAVORITES = MOBILE_BOTTOM_NAV.map((item) => item.href).slice(
  0,
  MAX_NAV_FAVORITES,
);

function sanitizeFavorites(ids: string[]) {
  return ids
    .filter((href, index, values) => values.indexOf(href) === index)
    .filter((href) => ALL_NAV_ITEMS.some((item) => item.href === href))
    .slice(0, MAX_NAV_FAVORITES);
}

export function loadFavorites(): string[] {
  if (typeof window === "undefined") return DEFAULT_FAVORITES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FAVORITES;
    const parsed = JSON.parse(raw) as string[];
    return sanitizeFavorites(parsed);
  } catch {
    return DEFAULT_FAVORITES;
  }
}

export function saveFavorites(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeFavorites(ids)));
  } catch {}
}
