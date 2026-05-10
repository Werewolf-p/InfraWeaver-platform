"use client";
import { useState, useEffect, useCallback } from "react";

export interface Favorite {
  id: string;
  label: string;
  href: string;
  iconName: string;
}

const STORAGE_KEY = "infraweaver:favorites";

function load(): Favorite[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(favorites: Favorite[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<Favorite[]>([]);

  useEffect(() => {
    setFavorites(load());
  }, []);

  const addFavorite = useCallback((fav: Favorite) => {
    setFavorites(prev => {
      if (prev.some(f => f.href === fav.href)) return prev;
      const next = [...prev, fav];
      save(next);
      return next;
    });
  }, []);

  const removeFavorite = useCallback((href: string) => {
    setFavorites(prev => {
      const next = prev.filter(f => f.href !== href);
      save(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((fav: Favorite) => {
    setFavorites(prev => {
      const exists = prev.some(f => f.href === fav.href);
      const next = exists ? prev.filter(f => f.href !== fav.href) : [...prev, fav];
      save(next);
      return next;
    });
  }, []);

  const isFavorite = useCallback(
    (href: string) => favorites.some(f => f.href === href),
    [favorites]
  );

  return { favorites, addFavorite, removeFavorite, toggleFavorite, isFavorite };
}
