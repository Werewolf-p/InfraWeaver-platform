"use client";

import { useCallback, useMemo } from "react";
import { useServerPreferences } from "@/hooks/use-server-preferences";
import { ALL_NAV_ITEMS } from "@/lib/nav-config";

export interface Favorite {
  id: string;
  label: string;
  href: string;
  iconName: string;
}

function mapHrefToFavorite(href: string): Favorite {
  const item = ALL_NAV_ITEMS.find((entry) => entry.href === href);
  return {
    id: href,
    href,
    label: item?.label ?? href,
    iconName: item?.label ?? href,
  };
}

export function useFavorites() {
  const { preferences, setPreferences } = useServerPreferences();
  const favorites = useMemo(
    () => preferences.pinnedApps.map(mapHrefToFavorite),
    [preferences.pinnedApps]
  );

  const addFavorite = useCallback((fav: Favorite) => {
    setPreferences((current) => (
      current.pinnedApps.includes(fav.href)
        ? {}
        : { pinnedApps: [...current.pinnedApps, fav.href] }
    ));
  }, [setPreferences]);

  const removeFavorite = useCallback((href: string) => {
    setPreferences((current) => ({
      pinnedApps: current.pinnedApps.filter((entry) => entry !== href),
    }));
  }, [setPreferences]);

  const toggleFavorite = useCallback((fav: Favorite) => {
    setPreferences((current) => ({
      pinnedApps: current.pinnedApps.includes(fav.href)
        ? current.pinnedApps.filter((entry) => entry !== fav.href)
        : [...current.pinnedApps, fav.href],
    }));
  }, [setPreferences]);

  const isFavorite = useCallback(
    (href: string) => preferences.pinnedApps.includes(href),
    [preferences.pinnedApps]
  );

  return { favorites, addFavorite, removeFavorite, toggleFavorite, isFavorite };
}
