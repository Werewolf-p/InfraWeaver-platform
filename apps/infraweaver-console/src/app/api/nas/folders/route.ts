// NAS folder browser + creator.
//
//   GET  ?provider&share&path=      → directories directly beneath `share/path`.
//   POST {provider, share, path}    → create `share/path` (with missing parents),
//                                      mint the provider's scoped SMB service
//                                      accounts if needed, and grant them the
//                                      folder ACLs that make `readonly` real.
//
// Plan reference: plans/advanced-storage.md §3 (least-privilege) and §4.
//
// The POST is what turns "a share" into "a folder a pod can be given". It is the
// only place the console writes to a NAS filesystem, so it is gated on
// `nas:write` AND the folder ACL (at readwrite, because creating a directory and
// granting service accounts on it is a write to that region of the share).

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import {
  canAccessNasFolder,
  canReadStorage,
  canTraverseNasFolder,
  canWriteStorage,
  nasAccessDecision,
  visibleFolders,
} from "@/lib/nas/authz";
import {
  NasAmbiguousPathError,
  collidesWithSibling,
  resolveCanonicalSubfolder,
  withoutAmbiguousEntries,
} from "@/lib/nas/canonical";
import {
  createNasFolder,
  listNasFolders,
  NasFolderUnsupportedError,
  NasShareNotFoundError,
  resolveNasSharePath,
  type NasFolderTarget,
} from "@/lib/nas/folders";
import { ensureProviderSmbCredentials, truenasConnectionFor } from "@/lib/nas/mount-credentials";
import { normalizeSubfolder } from "@/lib/nas/paths";
import { resolveNasCredentials, type ResolvedNasProvider } from "@/lib/nas/providers";
import { nasCertificateChallenge, requireNasProvider } from "@/lib/nas/route-helpers";
import { grantTruenasFolderAccess, grantTruenasTraversal } from "@/lib/nas/smb-accounts";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const SHARE_RE = /^[a-z0-9][a-z0-9\-_]*$/i;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]*$/;

function toTarget(p: ResolvedNasProvider): NasFolderTarget {
  return { kind: p.kind, host: p.host, port: p.port, tlsFingerprint256: p.tlsFingerprint256 };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  // Coarse admission: holds nas:read somewhere under /nas. The requested folder
  // and every child in the response are authorized individually below.
  if (!canReadStorage(rbac)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-folders", req), 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const providerId = req.nextUrl.searchParams.get("provider");
  const share = req.nextUrl.searchParams.get("share");
  if (!providerId || !share) return NextResponse.json({ error: "provider and share params required" }, { status: 400 });
  if (!PROVIDER_RE.test(providerId) || !SHARE_RE.test(share)) {
    return NextResponse.json({ error: "Invalid provider or share" }, { status: 400 });
  }

  let path: string;
  try {
    path = normalizeSubfolder(req.nextUrl.searchParams.get("path"));
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }

  // Traversal, not read: a caller granted only `<share>/movies` must be able to
  // open `<share>` on the way there. The listing itself is then filtered to the
  // entries they may actually read, so traversal reveals nothing extra.
  if (!canTraverseNasFolder(rbac, { provider: providerId, share, subfolder: path })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolvedProvider = await requireNasProvider(providerId);
  if (resolvedProvider.response) return resolvedProvider.response;
  const provider = resolvedProvider.provider;
  const creds = await resolveNasCredentials(providerId);
  if (!creds) return NextResponse.json({ folders: [], path, access: "readonly" });

  try {
    // The scope `path` was just authorized against is lowercase, so `Media` and
    // `media` authorize identically. Resolve the real on-disk casing and fail
    // closed when the path is ambiguous — otherwise a grant on `media` would list
    // `Media`, a directory nobody granted. Only once a path is unambiguous is
    // lowercase-scope ↔ on-disk-folder a bijection, which is exactly what the
    // traversal check above assumes. See lib/nas/canonical.ts.
    const canonicalPath = await resolveCanonicalSubfolder(toTarget(provider), creds, share, path);
    const listed = await listNasFolders(toTarget(provider), creds, share, canonicalPath);
    // Two siblings differing only by case collapse to ONE lowercase RBAC scope,
    // so no grant can distinguish them. Withhold both rather than let a grant on
    // one silently authorize the other. See lib/nas/canonical.ts.
    const { kept, ambiguous } = withoutAmbiguousEntries(listed);
    const visible = visibleFolders(rbac, providerId, share, canonicalPath, kept);
    return NextResponse.json({
      ...(ambiguous.length ? { ambiguous } : {}),
      folders: visible.map((folder) => ({
        ...folder,
        // Per-entry access so the tree can badge RO vs RW without N round trips.
        access: canAccessNasFolder(rbac, {
          provider: providerId,
          share,
          subfolder: canonicalPath ? `${canonicalPath.replace(/\/+$/, "")}/${folder.name}` : folder.name,
          access: "readwrite",
        })
          ? "readwrite"
          : "readonly",
      })),
      path: canonicalPath,
      // The caller's access on the folder they are currently looking at, which
      // decides whether "New folder" and read-write mounts are offered.
      access: canAccessNasFolder(rbac, { provider: providerId, share, subfolder: canonicalPath, access: "readwrite" })
        ? "readwrite"
        : "readonly",
    });
  } catch (error) {
    const challenge = nasCertificateChallenge(error, provider.id);
    if (challenge) return challenge;
    if (error instanceof NasAmbiguousPathError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof NasShareNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof NasFolderUnsupportedError) return NextResponse.json({ error: error.message }, { status: 501 });
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

const CreateBody = z.object({
  provider: z.string().min(1).max(63).regex(PROVIDER_RE),
  share: z.string().min(1).max(63).regex(SHARE_RE),
  // Validated properly by `normalizeSubfolder`; this is only a cheap size cap.
  path: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  // Coarse admission: holds nas:write somewhere under /nas. The exact target
  // folder is authorized against its own scope below.
  if (!canWriteStorage(rbac)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-folder-create", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let providerIdForError = "unknown";
  try {
    const parsed = CreateBody.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const { provider: providerId, share } = parsed.data;
    providerIdForError = providerId;

    let subfolder: string;
    try {
      subfolder = normalizeSubfolder(parsed.data.path);
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 400 });
    }
    if (!subfolder) return NextResponse.json({ error: "Cannot create the share root" }, { status: 400 });

    const resolvedProvider = await requireNasProvider(providerId);
    if (resolvedProvider.response) return resolvedProvider.response;
    const provider = resolvedProvider.provider;
    const creds = await resolveNasCredentials(providerId);
    if (!creds) return NextResponse.json({ error: `Provider '${providerId}' has no stored credentials` }, { status: 400 });

    // Creating a directory and granting service accounts on it is a write to
    // this region of the share, so it is checked at `readwrite` — not `readonly`.
    // A read-write grant on any ancestor scope (the share, the provider, "/")
    // covers the new folder, so no grant is needed on a path that does not exist yet.
    const aclDecision = nasAccessDecision(rbac, { provider: providerId, share, subfolder, access: "readwrite" });
    if (!aclDecision.allowed) {
      await auditLog("nas:folder:create", actor, `denied ${providerId}/${share}/${subfolder}: ${aclDecision.reason}`, { result: "failure" });
      return NextResponse.json({ error: `NAS folder ACL denied: ${aclDecision.reason}` }, { status: 403 });
    }

    const target = toTarget(provider);

    // Refuse to introduce a case-variant sibling. `media` and `Media` would be two
    // distinct directories on a case-sensitive dataset collapsing to ONE lowercase
    // RBAC scope, so no grant could ever tell them apart. Also fails closed if an
    // ancestor is already ambiguous. See lib/nas/canonical.ts.
    //
    // `canonical` re-spells every EXISTING ancestor the way it is on disk; only the
    // leaf may be new. Creating the raw path instead would mkdir `movies` next to an
    // existing `Movies` — manufacturing the very ambiguity this block exists to
    // prevent, and permanently un-addressing both folders for RBAC.
    let canonical: string;
    try {
      canonical = await resolveCanonicalSubfolder(target, creds, share, subfolder, { mustExist: false });
    } catch (error) {
      if (error instanceof NasAmbiguousPathError) return NextResponse.json({ error: error.message }, { status: 409 });
      throw error;
    }

    // The collision check compares the RAW leaf the caller asked for against the
    // canonical parent's children: asking for `Media` where `media` exists must
    // still 409, not silently resolve to the existing folder.
    const rawSegments = subfolder.split("/");
    const leaf = rawSegments[rawSegments.length - 1];
    const parent = canonical.split("/").slice(0, -1).join("/");
    const siblings = await listNasFolders(target, creds, share, parent);
    const clash = collidesWithSibling(leaf, siblings.map((entry) => entry.name));
    if (clash) {
      return NextResponse.json(
        { error: `'${leaf}' collides with the existing folder '${clash}', which differs only by case. Storage permissions are case-insensitive, so the two could never be told apart.` },
        { status: 409 },
      );
    }

    const createPath = [...canonical.split("/").slice(0, -1), leaf].filter(Boolean).join("/");
    const { created } = await createNasFolder(target, creds, share, createPath);

    // Mint (or reuse) the scoped SMB accounts and give them their ACLs. Without
    // this the folder exists but no mount can authenticate to it, and a later
    // `readonly` mount would fall back to whatever it inherited from the parent.
    let accountsGranted = false;
    if (provider.backends.includes("smb")) {
      const accounts = await ensureProviderSmbCredentials(provider, creds, { share });
      if (provider.kind === "truenas") {
        const conn = truenasConnectionFor(provider, creds);
        const sharePath = await resolveNasSharePath(target, creds, share);
        // Traversal on the share root first, else an SMB tree connect fails
        // before the folder's own ACE is ever evaluated.
        await grantTruenasTraversal(conn, sharePath, accounts);
        await grantTruenasFolderAccess(conn, sharePath, createPath, accounts);
      }
      accountsGranted = true;
    }

    await auditLog(
      "nas:folder:create",
      actor,
      `created ${providerId}/${share}/${createPath} (${created.length} new segment${created.length === 1 ? "" : "s"})${accountsGranted ? " + scoped SMB ACLs" : ""}`,
    );
    return NextResponse.json({ ok: true, path: createPath, created, accountsGranted });
  } catch (error) {
    const challenge = nasCertificateChallenge(error, providerIdForError);
    if (challenge) return challenge;
    if (error instanceof NasShareNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof NasFolderUnsupportedError) return NextResponse.json({ error: error.message }, { status: 501 });
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
