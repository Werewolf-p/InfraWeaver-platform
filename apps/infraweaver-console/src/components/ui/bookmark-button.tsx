"use client";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { useBookmarks } from "@/hooks/use-bookmarks";
import { cn } from "@/lib/utils";

interface BookmarkButtonProps {
  id: string;
  label: string;
  href: string;
  className?: string;
}

export function BookmarkButton({ id, label, href, className }: BookmarkButtonProps) {
  const { isBookmarked, addBookmark, removeBookmark } = useBookmarks();
  const bookmarked = isBookmarked(id);

  return (
    <button
      onClick={() => bookmarked ? removeBookmark(id) : addBookmark({ id, label, href })}
      className={cn(
        "flex items-center justify-center w-8 h-8 rounded-lg transition-all",
        bookmarked
          ? "text-yellow-400 hover:text-yellow-300 bg-yellow-400/10"
          : "text-white/30 hover:text-white/60 hover:bg-white/10",
        className
      )}
      aria-label={bookmarked ? `Remove bookmark: ${label}` : `Bookmark: ${label}`}
      title={bookmarked ? "Remove bookmark" : "Bookmark this page"}
    >
      {bookmarked ? <BookmarkCheck className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
    </button>
  );
}
