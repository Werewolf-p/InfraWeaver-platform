import type { Session } from "next-auth";
import { getRole } from "@/lib/rbac";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "remonhulst@gmail.com")
  .split(",")
  .map((e) => e.trim());

export function isAdmin(session: Session): boolean {
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  return getRole(groups) === "admin" || ADMIN_EMAILS.includes(session.user?.email ?? "");
}
