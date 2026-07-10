/**
 * Case canonicalization for NAS paths.
 *
 * The problem
 * -----------
 * RBAC scopes are lowercase — the assignments API grammar is
 * `/^\/(|[a-z0-9/_-]+)$/` — so `nasFolderScope` lowercases every segment. But the
 * TrueNAS/Synology filesystem APIs this code calls (`filesystem.listdir`,
 * `filesystem.mkdir`, `filesystem.setacl`, `SYNO.FileStation.*`) address ZFS/ext
 * datasets directly, NOT through Samba's case-folding layer, and those are
 * case-SENSITIVE. So `media` and `Media` can coexist as two distinct directories
 * that collapse to one scope, `/nas/<provider>/media`.
 *
 * A grant on `media` would then authorize `Media`, a directory nobody granted.
 * (The pre-scopes `NAS_FOLDER_ACL_JSON` matched case-insensitively too, so this
 * is not new — but it is real, and scopes make it easy to fix properly.)
 *
 * The invariant
 * -------------
 * We cannot represent `Media` and `media` as different scopes, so we refuse to
 * let them be different *resources*: a path segment is usable only when exactly
 * one on-disk entry matches it case-insensitively. That makes
 * lowercase-scope ↔ on-disk-folder a bijection, which is what the authorization
 * model already assumes.
 *
 * Enforced in both directions:
 *   - creation refuses a name that case-collides with an existing sibling, so a
 *     new ambiguity can never be introduced;
 *   - reads/mounts of an already-ambiguous path fail closed rather than silently
 *     picking one of the two directories.
 *
 * This applies to the platform owner too. Ambiguity is not a permission problem;
 * nobody can say which directory `Media` means.
 */
import { listNasFolders, type NasFolderTarget } from "@/lib/nas/folders";
import { normalizeSubfolder } from "@/lib/nas/paths";
import type { StoredNasCredentials } from "@/lib/nas/store";

export class NasAmbiguousPathError extends Error {
  constructor(
    /** The share-relative path whose segment is ambiguous. */
    readonly path: string,
    /** The colliding on-disk names, e.g. ["Media", "media"]. */
    readonly candidates: string[],
  ) {
    super(
      `'${path}' is ambiguous on this NAS: ${candidates.map((name) => `'${name}'`).join(" and ")} differ only by case. `
      + "Storage permissions are case-insensitive, so rename one of them before using this path.",
    );
    this.name = "NasAmbiguousPathError";
  }
}

/**
 * Groups of names that differ only by case, e.g. `[["Media", "media"]]`.
 * Pure; the listing routes use it to fail closed on an already-ambiguous parent.
 */
export function findCaseCollisions(names: readonly string[]): string[][] {
  const byLower = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    const bucket = byLower.get(key);
    if (bucket) bucket.push(name);
    else byLower.set(key, [name]);
  }
  return [...byLower.values()].filter((bucket) => bucket.length > 1);
}

/**
 * Drops entries that case-collide with a sibling. Returns what survives plus the
 * names that were withheld, so the caller can tell the operator *why* a folder
 * they can see over SMB is missing from this listing.
 */
export function withoutAmbiguousEntries<T extends { name: string }>(
  entries: readonly T[],
): { kept: T[]; ambiguous: string[] } {
  const collisions = findCaseCollisions(entries.map((entry) => entry.name));
  if (collisions.length === 0) return { kept: [...entries], ambiguous: [] };
  const blocked = new Set(collisions.flat());
  return {
    kept: entries.filter((entry) => !blocked.has(entry.name)),
    ambiguous: [...blocked].sort(),
  };
}

/** True when `name` case-collides with something already in `siblings`. */
export function collidesWithSibling(name: string, siblings: readonly string[]): string | null {
  const lower = name.toLowerCase();
  return siblings.find((sibling) => sibling.toLowerCase() === lower && sibling !== name) ?? null;
}

/**
 * Walk `subfolder` segment by segment against the NAS, asserting each is
 * unambiguous, and return the path spelled with its real on-disk casing.
 *
 * `mustExist: false` allows the FINAL segment not to exist yet — that is the
 * folder-creation case, where the caller still needs every ancestor checked and
 * needs to know the new name does not collide with a sibling.
 *
 * Costs one directory listing per segment. Paths here are shallow (a share plus
 * one or two levels), and every caller is already making network calls to the
 * appliance, so this is not a new class of latency.
 */
export async function resolveCanonicalSubfolder(
  target: NasFolderTarget,
  credentials: StoredNasCredentials,
  share: string,
  subfolder: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const mustExist = options.mustExist ?? true;
  const relative = normalizeSubfolder(subfolder);
  if (!relative) return "";

  const segments = relative.split("/");
  const canonical: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const parent = canonical.join("/");
    const siblings = await listNasFolders(target, credentials, share, parent);
    const matches = siblings.filter((entry) => entry.name.toLowerCase() === segment.toLowerCase());

    if (matches.length > 1) {
      throw new NasAmbiguousPathError(
        [...canonical, segment].join("/"),
        matches.map((entry) => entry.name).sort(),
      );
    }

    if (matches.length === 0) {
      const isLast = index === segments.length - 1;
      // A missing ancestor is simply "not found" — let the backend call that
      // follows produce its own error. A missing leaf is legal only when the
      // caller is about to create it.
      if (!isLast || mustExist) return [...canonical, ...segments.slice(index)].join("/");
      return [...canonical, segment].join("/");
    }

    canonical.push(matches[0].name);
  }

  return canonical.join("/");
}
