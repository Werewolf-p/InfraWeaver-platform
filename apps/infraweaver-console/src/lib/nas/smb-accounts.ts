/**
 * Scoped SMB service accounts + per-folder ACL grants — SERVER ONLY.
 *
 * The mount credential problem
 * ----------------------------
 * A TrueNAS provider is registered with an *API key*. The SMB CSI driver cannot
 * use an API key — it needs a username and password. Handing it the operator's
 * own NAS account would put a full-privilege credential in every namespace that
 * mounts a folder, and would make `access: "readonly"` a lie at the NAS layer.
 *
 * Instead the console mints two dedicated, SMB-only accounts per provider:
 *
 *   iw-<provider>-ro   granted READ   on each folder it is allowed to mount
 *   iw-<provider>-rw   granted MODIFY on each folder it is allowed to mount
 *
 * Their passwords are generated here, stored only in OpenBao under
 * `platform/nas/creds/<provider>-<ro|rw>`, and reach the cluster exclusively via
 * ExternalSecret. Neither account is granted anything at the share root beyond
 * traversal, so a compromised RO pod's credential opens exactly the folders that
 * were deliberately mounted for it — nothing else on the NAS.
 *
 * This is Layer A of the least-privilege model in plans/advanced-storage.md §3.
 * Layers B (kernel `ro` mount) and C (pod `readOnly: true`) are rendered by
 * `@/lib/nas/manifest`. All three are required; none is redundant.
 *
 * Two appliance behaviours this module exists to get right:
 *   - `filesystem.setacl` is an async job that returns HTTP 200 and *then* fails.
 *     Every grant is awaited to a terminal state (see `truenasJobResult`).
 *   - A dataset is either NFSv4- or POSIX1E-ACL flavoured, and the two take
 *     different ACE shapes. We read the existing ACL and match it.
 */

import { randomBytes } from "node:crypto";
import { joinNasPath } from "@/lib/nas/paths";
import {
  truenasJobCall,
  truenasRequest,
  truenasRequestOrThrow,
  type TruenasConnection,
} from "@/lib/nas/truenas-api";
import type { NasAccess } from "@/lib/nas/manifest";
import type { StoredNasCredentials } from "@/lib/nas/store";

/** Only ASCII alphanumerics: SMB, ZFS and shell quoting all agree on these. */
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PASSWORD_LENGTH = 28;

export interface NasSmbAccount {
  username: string;
  password: string;
}

export type NasSmbAccounts = Record<"readonly" | "readwrite", NasSmbAccount>;

/** `ro`/`rw` suffix used in account names, secret names and OpenBao paths. */
export function accessSlug(access: NasAccess): "ro" | "rw" {
  return access === "readonly" ? "ro" : "rw";
}

/** Stable, NAS-safe service-account name for a provider + access mode. */
export function smbAccountName(providerId: string, access: NasAccess): string {
  const slug = providerId.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase() || "nas";
  return `iw-${slug}-${accessSlug(access)}`;
}

/**
 * Rejection-sampled password from a uniform alphabet. `randomBytes % n` would
 * bias the low bytes; for a credential that guards a filesystem, don't.
 */
function generatePassword(): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of randomBytes(PASSWORD_LENGTH)) {
      if (byte >= limit) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === PASSWORD_LENGTH) break;
    }
  }
  return out;
}

interface TruenasUser {
  id: number;
  uid: number;
  username: string;
}

async function findTruenasUser(conn: TruenasConnection, username: string): Promise<TruenasUser | undefined> {
  const users = await truenasRequestOrThrow<TruenasUser[]>(
    conn,
    `/user?username=${encodeURIComponent(username)}`,
  );
  return Array.isArray(users) ? users[0] : undefined;
}

/**
 * Create the account, or reset the password of an existing one.
 *
 * Idempotent by design: re-running the provider wizard must always leave a
 * credential we know, and TrueNAS only ever accepts a password we set — it
 * cannot be read back. A pre-existing account (perhaps created by an earlier
 * run, perhaps by hand) is adopted rather than duplicated.
 *
 * `user.create` echoes `unixhash` and `smbhash`. The response is never logged.
 */
async function ensureTruenasAccount(
  conn: TruenasConnection,
  username: string,
  access: NasAccess,
): Promise<NasSmbAccount> {
  const password = generatePassword();
  const existing = await findTruenasUser(conn, username);

  if (existing) {
    await truenasRequestOrThrow(conn, `/user/id/${existing.id}`, {
      method: "PUT",
      body: { password, smb: true, locked: false, password_disabled: false },
    });
    return { username, password };
  }

  const created = await truenasRequest<TruenasUser>(conn, "/user", {
    method: "POST",
    body: {
      username,
      // `full_name` is required by `user_create`; omitting it is a 422.
      full_name: `InfraWeaver ${accessSlug(access) === "ro" ? "read-only" : "read-write"} service account`,
      smb: true,
      group_create: true,
      home_create: false,
      shell: "/usr/sbin/nologin",
      password,
      password_disabled: false,
      locked: false,
    },
  });
  if (!created.ok) {
    throw new Error(created.message ?? `TrueNAS refused to create service account '${username}'`);
  }
  return { username, password };
}

/**
 * Ensure both scoped SMB accounts exist on the appliance and return their fresh
 * credentials. The caller persists them to OpenBao; they are not returned to
 * any HTTP response.
 */
export async function ensureTruenasSmbAccounts(
  conn: TruenasConnection,
  providerId: string,
): Promise<NasSmbAccounts> {
  const readonly = await ensureTruenasAccount(conn, smbAccountName(providerId, "readonly"), "readonly");
  const readwrite = await ensureTruenasAccount(conn, smbAccountName(providerId, "readwrite"), "readwrite");
  return { readonly, readwrite };
}

// ---------------------------------------------------------------------------
// ACL grants
// ---------------------------------------------------------------------------

/** One ACE. NFSv4 uses `type`/`flags`; POSIX1E uses `default`. */
interface FilesystemAce {
  tag: string;
  type?: string;
  perms: Record<string, unknown>;
  flags?: Record<string, unknown>;
  default?: boolean;
  id?: number;
  who?: string | null;
}

interface FilesystemAcl {
  path: string;
  acltype: "NFS4" | "POSIX1E";
  acl: FilesystemAce[];
}

/** NFSv4 basic permission set per access mode. MODIFY = read+write+delete, not FULL_CONTROL. */
function nfs4Ace(username: string, access: NasAccess): FilesystemAce {
  return {
    tag: "USER",
    // `who` (account name) is accepted in place of a numeric `id`, so no uid lookup.
    who: username,
    type: "ALLOW",
    perms: { BASIC: access === "readonly" ? "READ" : "MODIFY" },
    // Inherit onto files and subdirectories created later, e.g. by Nextcloud.
    flags: { BASIC: "INHERIT" },
  };
}

function posixAce(username: string, access: NasAccess): FilesystemAce {
  return {
    tag: "USER",
    who: username,
    perms: { READ: true, WRITE: access !== "readonly", EXECUTE: true },
    default: false,
  };
}

/** Replace this account's ACE, preserving every other entry on the directory. */
function mergeAce(existing: FilesystemAce[], ace: FilesystemAce, username: string): FilesystemAce[] {
  const others = existing.filter((entry) => !(entry.tag === "USER" && entry.who === username));
  return [...others, ace];
}

/**
 * Grant the RO account READ and the RW account MODIFY on one folder, inherited
 * by everything created inside it. Existing ACEs (including the owner's) are
 * preserved — this never strips an operator's own access.
 *
 * Throws if the appliance's ACL job fails. A folder whose ACL could not be set
 * must not be reported as mountable: the RO account would silently have no
 * access, or worse, inherit more than intended from the parent.
 */
export async function grantTruenasFolderAccess(
  conn: TruenasConnection,
  sharePath: string,
  subfolder: string,
  accounts: NasSmbAccounts,
): Promise<void> {
  const path = joinNasPath(sharePath, subfolder);
  const current = await truenasRequestOrThrow<FilesystemAcl>(conn, "/filesystem/getacl", {
    method: "POST",
    body: { path },
  });
  const isNfs4 = current.acltype === "NFS4";
  const build = (username: string, access: NasAccess) =>
    isNfs4 ? nfs4Ace(username, access) : posixAce(username, access);

  let dacl = Array.isArray(current.acl) ? current.acl : [];
  for (const [access, account] of [
    ["readonly", accounts.readonly],
    ["readwrite", accounts.readwrite],
  ] as Array<[NasAccess, NasSmbAccount]>) {
    dacl = mergeAce(dacl, build(account.username, access), account.username);
  }

  // `setacl` answers 200 with a job id and can still fail asynchronously.
  await truenasJobCall(
    conn,
    "/filesystem/setacl",
    { path, dacl, options: { recursive: false } },
    `Granting NAS access on ${path}`,
  );
}

/**
 * Let both accounts traverse from the share root down to the granted folder
 * without being able to *list* the intervening directories. Without this an SMB
 * tree connect to the share fails before the folder's own ACE is ever consulted.
 *
 * TRAVERSE is execute-without-read: `cd media` works, `ls .` does not.
 */
export async function grantTruenasTraversal(
  conn: TruenasConnection,
  sharePath: string,
  accounts: NasSmbAccounts,
): Promise<void> {
  const current = await truenasRequestOrThrow<FilesystemAcl>(conn, "/filesystem/getacl", {
    method: "POST",
    body: { path: sharePath },
  });
  if (current.acltype !== "NFS4") return; // POSIX1E share roots already allow x via mode bits.

  let dacl = Array.isArray(current.acl) ? current.acl : [];
  let changed = false;
  for (const account of [accounts.readonly, accounts.readwrite]) {
    const has = dacl.some((entry) => entry.tag === "USER" && entry.who === account.username);
    if (has) continue;
    changed = true;
    dacl = [
      ...dacl,
      {
        tag: "USER",
        who: account.username,
        type: "ALLOW",
        perms: { BASIC: "TRAVERSE" },
        // NOINHERIT: traversal must not become read access on every child folder.
        flags: { BASIC: "NOINHERIT" },
      },
    ];
  }
  if (!changed) return;

  await truenasJobCall(
    conn,
    "/filesystem/setacl",
    { path: sharePath, dacl, options: { recursive: false } },
    `Granting share traversal on ${sharePath}`,
  );
}

/** Credentials as the store persists them for the SMB CSI driver. */
export function toStoredSmbCredentials(account: NasSmbAccount): StoredNasCredentials {
  return { username: account.username, password: account.password };
}
