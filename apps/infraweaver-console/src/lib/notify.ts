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
// We use a Proxy so all other methods (loading, custom, promise, etc.) pass through.
const _wrapped = {
  ..._toast,
  error(
    title: Parameters<typeof _toast.error>[0],
    opts?: Parameters<typeof _toast.error>[1],
  ) {
    pushToHistory(title, "error");
    return _toast.error(title, opts);
  },
  warning(
    title: Parameters<typeof _toast.warning>[0],
    opts?: Parameters<typeof _toast.warning>[1],
  ) {
    pushToHistory(title, "warning");
    return _toast.warning(title, opts);
  },
  success(
    title: Parameters<typeof _toast.success>[0],
    opts?: Parameters<typeof _toast.success>[1],
  ) {
    pushToHistory(title, "success");
    return _toast.success(title, opts);
  },
  info(
    title: Parameters<typeof _toast.info>[0],
    opts?: Parameters<typeof _toast.info>[1],
  ) {
    pushToHistory(title, "info");
    return _toast.info(title, opts);
  },
};

function toastFn(...args: Parameters<typeof _toast>) {
  return _toast(...args);
}

export const toast = Object.assign(toastFn, _wrapped) as unknown as typeof _toast;

export default toast;
