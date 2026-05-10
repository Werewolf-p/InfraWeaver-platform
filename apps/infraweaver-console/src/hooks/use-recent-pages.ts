"use client";
import { useState, useEffect, useCallback } from "react";

export interface RecentPage {
  href: string;
  title: string;
  visitedAt: number;
}

const STORAGE_KEY = "infraweaver:recent-pages";
const MAX_RECENT = 5;

function load(): RecentPage[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(pages: RecentPage[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pages));
}

export function useRecentPages() {
  const [recentPages, setRecentPages] = useState<RecentPage[]>([]);

  useEffect(() => {
    setRecentPages(load());
  }, []);

  const addRecentPage = useCallback((href: string, title: string) => {
    setRecentPages(prev => {
      const filtered = prev.filter(p => p.href !== href);
      const next = [{ href, title, visitedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      save(next);
      return next;
    });
  }, []);

  return { recentPages, addRecentPage };
}
