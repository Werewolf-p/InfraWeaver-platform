// Thin wrapper around sonner's toast that also pushes to the notification bell.
// All error/warning/success/info toasts automatically appear in bell history.
// Import `{ toast }` from "@/lib/notify" instead of "sonner" throughout the app.
import { toast as _toast } from "sonner";

export { Toaster } from "sonner";

export const NOTIFICATION_PUSH_EVENT = "infraweaver:push-notification";

export type NotificationPushDetail = {
  title: string;
  level: "info" | "warning" | "error" | "success";
};

function pushToHistory(title: unknown, level: NotificationPushDetail["level"]) {
  if (typeof window === "undefined") return;
  const titleStr =
    typeof title === "string"
      ? title
      : title != null
        ? String(title)
        : "";
  if (!titleStr) return;
  window.dispatchEvent(
    new CustomEvent<NotificationPushDetail>(NOTIFICATION_PUSH_EVENT, {
      detail: { title: titleStr, level },
    }),
  );
}

// Re-export a toast object compatible with sonner's API that additionally
// dispatches a bell-history event on every error/warning/success/info call.
// All other methods (loading, custom, promise, etc.) are copied over by spreading
// sonner's toast object at import time; only the four leveled methods are wrapped.
const LEVELS = ["error", "warning", "success", "info"] as const;

const _wrapped = {
  ..._toast,
  ...(Object.fromEntries(
    LEVELS.map((level) => [
      level,
      (
        title: Parameters<typeof _toast.error>[0],
        opts?: Parameters<typeof _toast.error>[1],
      ) => {
        pushToHistory(title, level);
        return _toast[level](title, opts);
      },
    ]),
  ) as Pick<typeof _toast, (typeof LEVELS)[number]>),
};

function toastFn(...args: Parameters<typeof _toast>) {
  return _toast(...args);
}

export const toast = Object.assign(toastFn, _wrapped) as unknown as typeof _toast;

export default toast;
