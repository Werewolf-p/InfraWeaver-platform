/**
 * NAS subfolder path model — the traversal boundary for every NAS write.
 *
 * A "subfolder" is an operator-supplied, share-relative path such as
 * `media` or `media/movies`. It reaches the appliance in three places:
 *   - `filesystem/mkdir` (TrueNAS) / `SYNO.FileStation.CreateFolder`,
 *   - `filesystem/setacl`, which grants the console's service accounts rights
 *     on the resulting directory,
 *   - the CSI `subDir` mount attribute.
 *
 * All three take the value produced here, so this module is the only thing
 * standing between a crafted subfolder and `mkdir /etc` + an ACL grant on it.
 * It is deliberately allow-list based: a segment must match a narrow charset,
 * `.`/`..` are rejected outright rather than resolved, and the result can never
 * begin with a separator. Everything downstream may assume the output is a
 * clean, relative, already-validated path.
 */

/** Max path segments below the share root. Deep trees are a smell, not a need. */
const MAX_DEPTH = 8;
/** Max total length of the normalized path (CSI `subDir` and SMB both cope well below this). */
const MAX_LENGTH = 200;
/** Max length of a single segment (SMB/ZFS both allow 255; stay conservative). */
const MAX_SEGMENT_LENGTH = 100;
/** A segment may hold ASCII alphanumerics, dot, dash, underscore — nothing else. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** Truncation budget for k8s object-name fragments derived from a path. */
const MAX_SLUG_LENGTH = 40;

/**
 * Normalize a share-relative subfolder, or throw.
 *
 * Returns `""` for the share root. The result never starts or ends with `/`,
 * never contains an empty segment, and never contains `.` or `..`.
 */
export function normalizeSubfolder(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || value === "/") return "";

  // Reject before splitting: a NUL byte truncates the path in any C-based
  // syscall layer below, and a backslash is a separator to an SMB server.
  if (/[\x00-\x1f\x7f\\]/.test(value)) {
    throw new Error("Subfolder contains an illegal character");
  }

  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return "";
  if (segments.length > MAX_DEPTH) {
    throw new Error(`Subfolder is nested too deep (max ${MAX_DEPTH} levels)`);
  }

  for (const segment of segments) {
    if (segment === "..") throw new Error("Subfolder contains a path traversal ('..')");
    if (/^\.+$/.test(segment)) throw new Error(`Invalid subfolder segment '${segment}'`);
    if (segment.length > MAX_SEGMENT_LENGTH) throw new Error("Subfolder segment is too long");
    if (!SEGMENT_RE.test(segment)) throw new Error(`Subfolder contains an illegal character in '${segment}'`);
  }

  const normalized = segments.join("/");
  if (normalized.length > MAX_LENGTH) throw new Error("Subfolder path is too long");
  return normalized;
}

/**
 * Resolve a normalized subfolder against a share's absolute path on the
 * appliance. `sharePath` comes from the NAS API (TrueNAS `sharing/smb.path`,
 * Synology `real_path`), never from the caller.
 */
export function joinNasPath(sharePath: string, subfolder: string | null | undefined): string {
  if (!sharePath.startsWith("/")) throw new Error("Share path must be absolute");
  const base = sharePath.replace(/\/+$/, "");
  // Re-validate rather than trust: callers reach this from several routes and
  // one forgotten `normalizeSubfolder` upstream must not become a traversal.
  const relative = normalizeSubfolder(subfolder);
  return relative ? `${base}/${relative}` : base;
}

/** Every path segment of a normalized subfolder, parents first — the mkdir order. */
export function subfolderSegments(subfolder: string): string[] {
  const normalized = normalizeSubfolder(subfolder);
  if (!normalized) return [];
  const parts = normalized.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * Render a path (or any name) as a DNS-1123-safe fragment for a Kubernetes
 * object name. Lossy by design — uniqueness is the caller's job, which is why
 * `deriveNasResourceNames` also folds in a content hash.
 */
export function slugifyPathSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "root";
}
