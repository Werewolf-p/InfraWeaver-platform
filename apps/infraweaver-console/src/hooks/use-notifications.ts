"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadAckedEventIds, saveAckedEventIds, subscribeAckedEventIds } from "@/lib/event-ack";
import { NOTIFICATION_PUSH_EVENT, type NotificationPushDetail } from "@/lib/notify";

export type NotificationLevel = "info" | "warning" | "error" | "success";

export interface Notification {
  id: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
}

interface NotificationStore {
  local: Notification[];
  dismissedIds: string[];
}

const STORAGE_KEY = "infraweaver:notifications";
const MAX_NOTIFICATIONS = 20;

function normalizeNotification(value: unknown): Notification | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Notification>;
  if (!input.id || !input.title || typeof input.id !== "string" || typeof input.title !== "string") return null;
  return {
    id: input.id,
    title: input.title,
    body: typeof input.body === "string" ? input.body : undefined,
    level: input.level === "warning" || input.level === "error" || input.level === "success" ? input.level : "info",
    timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
    read: Boolean(input.read),
  };
}

function loadStore(): NotificationStore {
  if (typeof window === "undefined") return { local: [], dismissedIds: [] };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(parsed)) {
      return {
        local: parsed.map(normalizeNotification).filter((value): value is Notification => Boolean(value)),
        dismissedIds: [],
      };
    }
    if (parsed && typeof parsed === "object") {
      const value = parsed as { local?: unknown[]; dismissedIds?: unknown[] };
      return {
        local: (value.local ?? []).map(normalizeNotification).filter((entry): entry is Notification => Boolean(entry)),
        dismissedIds: Array.isArray(value.dismissedIds)
          ? value.dismissedIds.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    }
  } catch {
    // ignore local storage parse failures
  }
  return { local: [], dismissedIds: [] };
}

function saveStore(store: NotificationStore) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function useNotifications() {
  const [store, setStore] = useState<NotificationStore>(() => loadStore());
  const [ackedIds, setAckedIds] = useState<string[]>(() => loadAckedEventIds());
  const [serverNotifications, setServerNotifications] = useState<Notification[]>([]);

  // Keep a ref to dismissedIds so the polling effect doesn't need it as a
  // dependency (store.dismissedIds is a new array reference on every store
  // update, which would restart the 60-second interval on every notification push).
  const dismissedIdsRef = useRef(store.dismissedIds);
  useEffect(() => {
    dismissedIdsRef.current = store.dismissedIds;
  }, [store.dismissedIds]);

  useEffect(() => subscribeAckedEventIds(() => setAckedIds(loadAckedEventIds())), []);

  // Listen for toast events dispatched by lib/notify.ts so every toast
  // automatically appears in the bell history without any extra wiring.
  useEffect(() => {
    function handlePush(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { title, level } = (e as CustomEvent<NotificationPushDetail>).detail;
      if (!title) return;
      setStore((current) => ({
        ...current,
        local: [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            title,
            level,
            timestamp: Date.now(),
            read: false,
          },
          ...current.local,
        ].slice(0, MAX_NOTIFICATIONS),
      }));
    }
    window.addEventListener(NOTIFICATION_PUSH_EVENT, handlePush);
    return () => window.removeEventListener(NOTIFICATION_PUSH_EVENT, handlePush);
  }, []);

  useEffect(() => {
    saveStore(store);
  }, [store]);

  useEffect(() => {
    let cancelled = false;

    const loadRemote = async () => {
      try {
        const response = await fetch("/api/notifications", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { notifications?: unknown[] };
        if (cancelled) return;
        const remote = (payload.notifications ?? [])
          .map(normalizeNotification)
          .filter((notification): notification is Notification => Boolean(notification))
          .filter((notification) => !dismissedIdsRef.current.includes(notification.id))
          .map((notification) => ({
            ...notification,
            read: notification.read || ackedIds.includes(notification.id),
          }));
        setServerNotifications(remote);
      } catch {
        if (!cancelled) setServerNotifications([]);
      }
    };

    void loadRemote();
    const interval = window.setInterval(loadRemote, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    }, [ackedIds]); // dismissedIds read via ref to avoid restarting interval on every push

  const addNotification = useCallback(
    (title: string, level: NotificationLevel = "info", body?: string) => {
      setStore((current) => ({
        ...current,
        local: [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            title,
            body,
            level,
            timestamp: Date.now(),
            read: false,
          },
          ...current.local,
        ].slice(0, MAX_NOTIFICATIONS),
      }));
    },
    []
  );

  const markRead = useCallback((id: string) => {
    setStore((current) => ({
      ...current,
      local: current.local.map((notification) => (
        notification.id === id ? { ...notification, read: true } : notification
      )),
    }));
    if (!ackedIds.includes(id)) saveAckedEventIds([...ackedIds, id]);
  }, [ackedIds]);

  const markAllRead = useCallback(() => {
    setStore((current) => ({
      ...current,
      local: current.local.map((notification) => ({ ...notification, read: true })),
    }));
    saveAckedEventIds([...ackedIds, ...serverNotifications.map((notification) => notification.id)]);
  }, [ackedIds, serverNotifications]);

  const dismiss = useCallback((id: string) => {
    setStore((current) => ({
      ...current,
      local: current.local.filter((notification) => notification.id !== id),
      dismissedIds: current.dismissedIds.includes(id) ? current.dismissedIds : [...current.dismissedIds, id],
    }));
    if (!ackedIds.includes(id)) saveAckedEventIds([...ackedIds, id]);
    setServerNotifications((current) => current.filter((notification) => notification.id !== id));
  }, [ackedIds]);

  const clearAll = useCallback(() => {
    setStore((current) => ({
      local: [],
      dismissedIds: Array.from(new Set([...current.dismissedIds, ...serverNotifications.map((notification) => notification.id)])),
    }));
    saveAckedEventIds([...ackedIds, ...serverNotifications.map((notification) => notification.id)]);
    setServerNotifications([]);
  }, [ackedIds, serverNotifications]);

  const notifications = useMemo(
    () => [...store.local, ...serverNotifications].sort((left, right) => right.timestamp - left.timestamp),
    [serverNotifications, store.local]
  );

  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return { notifications, addNotification, markRead, markAllRead, dismiss, clearAll, unreadCount };
}
