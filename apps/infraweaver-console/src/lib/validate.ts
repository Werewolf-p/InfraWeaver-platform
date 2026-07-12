import path from "node:path";
import { z } from "zod";

/**
 * Validate a Kubernetes resource name (DNS subdomain: a-z0-9-.)
 */
export function isValidK8sName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-.]*[a-z0-9]$/.test(name) && name.length <= 253;
}

export function isValidNamespace(ns: string): boolean {
  return isValidK8sName(ns) && ns.length <= 63;
}

/**
 * Zod counterparts of isValidK8sName/isValidNamespace for schema-validated
 * route bodies. Built on the single DNS-1123 regex above — do not add a
 * second copy of that regex.
 */
export const k8sNameSchema = z
  .string()
  .refine(isValidK8sName, "Invalid Kubernetes resource name (lowercase DNS-1123 subdomain, max 253 characters)");

export const k8sNamespaceSchema = z
  .string()
  .refine(isValidNamespace, "Invalid Kubernetes namespace (lowercase DNS-1123 label, max 63 characters)");

export function isValidContainerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(name) && name.length <= 63;
}

export function sanitizeK8sLabel(value: string): string {
  return value.replace(/[^a-z0-9\-_.]/g, "").slice(0, 63);
}

// Shell-significant and control characters that have no legitimate place in a
// game-server data path. shellQuote already escapes single quotes safely, but
// rejecting these at the validation layer is defense-in-depth against any call
// site that interpolates a path without quoting.
const SHELL_UNSAFE_PATH_CHARS = /[\x00-\x1f'"`$\\]/;

function normalizeContainerPath(value: string): string | null {
  if (!value || !value.startsWith("/") || value.includes("\0")) return null;
  if (SHELL_UNSAFE_PATH_CHARS.test(value)) return null;
  const rawSegments = value.split("/").filter(Boolean);
  if (rawSegments.some((segment) => segment === "." || segment === "..")) return null;
  const normalized = path.posix.normalize(value);
  return normalized.startsWith("/") ? normalized : null;
}

/**
 * Validates a file path used for kubectl exec operations inside a game container.
 * Rejects traversal segments and null bytes before shell execution.
 */
export function validateContainerPath(path: string): boolean {
  return normalizeContainerPath(path) !== null;
}

export function validateContainerPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizeContainerPath(targetPath);
  const normalizedRoot = normalizeContainerPath(rootPath);
  if (!normalizedTarget || !normalizedRoot) return false;
  if (normalizedRoot === "/") return true;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

// The lexical checks above cannot see symlinks that live on the volume itself:
// `/data/link -> /` makes `/data/link/etc/shadow` pass every string check while
// resolving outside the data root (SECURITY-AUDIT H1). The only place symlinks
// can be resolved is inside the container, so every file operation prepends the
// guard script below and aborts before touching the filesystem when any target
// resolves outside the root.
export const PATH_ESCAPE_MARKER = "IW_PATH_ESCAPE";
export const ARCHIVE_UNSAFE_MEMBER_MARKER = "IW_ARCHIVE_UNSAFE_MEMBER";

export type ContainerPathTargetKind =
  // Directory that must already exist (listing, extract destination).
  | "existing-dir"
  // File operated on through its final component — the final component must not
  // be a symlink (read, extract archive), and its parent must resolve in-root.
  | "existing-file"
  // Entry addressed as itself, symlink-or-not (delete, rename source): removing
  // or moving a symlink is safe, so only the parent directory is resolved.
  | "entry"
  // Path that may not exist yet (save, upload, mkdir, rename target): the
  // deepest existing ancestor must resolve in-root and the final component must
  // not be a pre-existing symlink the write would follow.
  | "destination";

export interface ContainerPathTarget {
  path: string;
  kind: ContainerPathTargetKind;
}

/**
 * Builds a POSIX-sh prelude that re-validates every target with the container's
 * own filesystem view (`cd -P && pwd -P`, `[ -L ]`) before the real command
 * runs. On any escape it prints PATH_ESCAPE_MARKER to stdout and exits, so
 * callers must check stdout for the marker and refuse the request.
 *
 * `quote` is the caller's shell quoter (shellQuote); every path must already
 * have passed validateContainerPath, which this function re-asserts.
 */
export function buildContainerRealpathGuard(
  rootPath: string,
  targets: ContainerPathTarget[],
  quote: (value: string) => string,
): string {
  const root = normalizeContainerPath(rootPath);
  if (!root) throw new Error("Invalid container root path");
  const lines = [
    `iw_fail() { echo ${PATH_ESCAPE_MARKER}; exit 1; }`,
    // Resolve the root itself first; a root of "/" allows everything, so the
    // prefix becomes empty and the case pattern degrades to "/*".
    `iw_root=$(cd -P -- ${quote(root)} 2>/dev/null && pwd -P) || iw_fail`,
    `[ "$iw_root" = "/" ] && iw_root=""`,
    `iw_check() { case "$1/" in "$iw_root/"*) : ;; *) iw_fail ;; esac; }`,
    `iw_dir() { iw_rp=$(cd -P -- "$1" 2>/dev/null && pwd -P) || iw_fail; iw_check "$iw_rp"; }`,
    // Deepest existing ancestor: components that do not exist yet cannot be
    // symlinks, so resolving the first ancestor that does exist is sufficient.
    `iw_dest() { [ ! -L "$1" ] || iw_fail; iw_p="$1"; while [ "$iw_p" != "/" ] && [ ! -d "$iw_p" ]; do iw_p="\${iw_p%/*}"; [ -n "$iw_p" ] || iw_p="/"; done; iw_dir "$iw_p"; }`,
  ];
  for (const target of targets) {
    const normalized = normalizeContainerPath(target.path);
    if (!normalized) throw new Error("Invalid container target path");
    const parent = path.posix.dirname(normalized);
    switch (target.kind) {
      case "existing-dir":
        lines.push(`iw_dir ${quote(normalized)}`);
        break;
      case "existing-file":
        lines.push(`[ ! -L ${quote(normalized)} ] || iw_fail`, `iw_dir ${quote(parent)}`);
        break;
      case "entry":
        lines.push(`iw_dir ${quote(parent)}`);
        break;
      case "destination":
        lines.push(`iw_dest ${quote(normalized)}`);
        break;
    }
  }
  return lines.join("\n");
}
