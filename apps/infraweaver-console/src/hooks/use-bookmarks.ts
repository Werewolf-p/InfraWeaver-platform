"use client";
import { useState, useCallback, useEffect } from "react";

type Bookmark = { id: string; label: string; href: string };

const STORAGE_KEY = "infraweaver:bookmarks";

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setBookmarks(JSON.parse(stored) as Bookmark[]);
    } catch {}
  }, []);

  const save = useCallback((items: Bookmark[]) => {
    setBookmarks(items);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, []);

  const addBookmark = useCallback((b: Bookmark) => {
    setBookmarks(prev => {
      if (prev.some(x => x.id === b.id)) return prev;
      const next = [...prev, b];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeBookmark = useCallback((id: string) => {
    setBookmarks(prev => {
      const next = prev.filter(x => x.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const isBookmarked = useCallback((id: string) => bookmarks.some(b => b.id === id), [bookmarks]);

  return { bookmarks, addBookmark, removeBookmark, isBookmarked, save };
}
