export const ACKED_EVENT_STORAGE_KEY = "infraweaver:acked-events";
const ACKED_EVENT_CHANGE = "infraweaver:acked-events-changed";

export function loadAckedEventIds() {
  if (typeof window === "undefined") return [] as string[];
  try {
    const parsed = JSON.parse(localStorage.getItem(ACKED_EVENT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [] as string[];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [] as string[];
  }
}

export function saveAckedEventIds(ids: string[]) {
  if (typeof window === "undefined") return;
  const next = Array.from(new Set(ids)).slice(-500);
  localStorage.setItem(ACKED_EVENT_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(ACKED_EVENT_CHANGE));
}

export function subscribeAckedEventIds(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    if (event instanceof StorageEvent && event.key && event.key !== ACKED_EVENT_STORAGE_KEY) return;
    onChange();
  };
  window.addEventListener(ACKED_EVENT_CHANGE, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(ACKED_EVENT_CHANGE, handler);
    window.removeEventListener("storage", handler);
  };
}
