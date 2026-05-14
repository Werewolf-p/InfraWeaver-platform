"use client";
import { useState, useEffect, useCallback } from "react";

export type NotificationLevel = "info" | "warning" | "error" | "success";

export interface Notification {
  id: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
}

const STORAGE_KEY = "infraweaver:notifications";
const MAX_NOTIFICATIONS = 20;

function load(): Notification[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(notifications: Notification[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    setNotifications(load());
  }, []);

  const addNotification = useCallback(
    (title: string, level: NotificationLevel = "info", body?: string) => {
      setNotifications(prev => {
        const notification: Notification = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          title,
          body,
          level,
          timestamp: Date.now(),
          read: false,
        };
        const next = [notification, ...prev].slice(0, MAX_NOTIFICATIONS);
        save(next);
        return next;
      });
    },
    []
  );

  const markRead = useCallback((id: string) => {
    setNotifications(prev => {
      const next = prev.map(n => (n.id === id ? { ...n, read: true } : n));
      save(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications(prev => {
      const next = prev.map(n => ({ ...n, read: true }));
      save(next);
      return next;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications(prev => {
      const next = prev.filter(n => n.id !== id);
      save(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    save([]);
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return { notifications, addNotification, markRead, markAllRead, dismiss, clearAll, unreadCount };
}
