"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Lock } from "lucide-react";
import { useRBAC } from "@/hooks/useRBAC";
import type { Permission } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

interface PermissionGateProps {
  permission: Permission | Permission[];
  scope?: string;
  children: ReactNode;
  /** Shown when permission is denied. Defaults to nothing. */
  fallback?: ReactNode;
  /** Shown while RBAC is still loading. Defaults to `fallback`. */
  loading?: ReactNode;
}

/**
 * Renders children only when the current user has the required permission(s).
 * While RBAC is loading it defaults to the denied state to avoid flashing
 * restricted content.
 */
export function PermissionGate({ permission, scope, children, fallback = null, loading }: PermissionGateProps) {
  const { can, canAny, isLoading } = useRBAC();
  if (isLoading) return <>{loading ?? fallback}</>;
  const permitted = Array.isArray(permission) ? canAny(permission, scope) : can(permission, scope);
  return <>{permitted ? children : fallback}</>;
}

interface LockedButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  permission: Permission | Permission[];
  scope?: string;
  lockedTitle?: string;
}

/**
 * Renders a normal button when permitted, or a visually locked disabled
 * button with a tooltip when the user lacks the required permission.
 *
 * Drop-in replacement for `<button>`: pass all normal button props.
 */
export function LockedButton({
  permission,
  scope,
  lockedTitle = "You don't have permission for this action",
  children,
  className,
  ...props
}: LockedButtonProps) {
  const { can, canAny, isLoading } = useRBAC();
  const permitted = !isLoading && (Array.isArray(permission) ? canAny(permission, scope) : can(permission, scope));

  if (permitted) {
    return (
      <button className={className} {...props}>
        {children}
      </button>
    );
  }

  return (
    <Tooltip content={lockedTitle} position="top">
      <button
        type="button"
        disabled
        aria-disabled="true"
        className={cn(className, "cursor-not-allowed opacity-50 select-none")}
      >
        <Lock className="mr-1.5 inline h-3 w-3 flex-shrink-0" aria-hidden />
        {children}
      </button>
    </Tooltip>
  );
}
