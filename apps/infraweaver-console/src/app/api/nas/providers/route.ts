// NAS providers API.
//
//   GET    → merged registry (env built-ins + OpenBao dynamic) with reachability.
//            Never returns credentials — only presence flags.
//   POST   {name, host, kind, port?, protocol?, backends?, credentials} → validate
//            + SSRF-allowlist the host, test the credentials against the live NAS
//            ("save & test"), then persist to OpenBao. Live immediately, no pod
//            restart. Reads require nas:read; writes require nas:write and are
//            rate-limited, access-logged and audited. Credentials are never logged.
//   DELETE {id} → remove a dynamically-added provider. Built-in (env) providers
//            cannot be deleted here — they are managed via environment.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { logMutatingAccess } from "@/lib/access-log";
import { INTERNAL_DOMAIN } from "@/lib/domain";
import { fetchInternalService } from "@/lib/insecure-fetch";
import {
  invalidateInternalHostAllowlist,
  isAllowedInternalHostForWizard,
} from "@/lib/internal-url-allowlist-server";
import { probeNasCredentials } from "@/lib/nas/discovery";
import { provisionScopedNasAccount } from "@/lib/nas/provision-account";
import { resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";
import {
  deleteNasSmbCreds,
  deleteStoredNasProvider,
  readStoredNasProviders,
  upsertStoredNasProvider,
  writeNasSmbCreds,
  type NasProviderKind,
} from "@/lib/nas/store";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

// Discovery probe URLs per provider kind — extending the kind enum requires
// adding an entry here.
function probeUrl(provider: Pick<ResolvedNasProvider, "protocol" | "host" | "port" | "kind">): string {
  const base = `${provider.protocol}://${provider.host}:${provider.port}`;
  switch (provider.kind) {
    case "synology":
      return `${base}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query`;
    case "truenas":
      return `${base}/api/v2/system/info`;
    case "generic-smb":
    case "generic-nfs":
      return base;
  }
}

async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetchInternalService(url, { signal: AbortSignal.timeout(2000) }, { allowInsecureTls: true });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

const DEFAULT_PORT: Record<NasProviderKind, number> = {
  synology: 5001,
  truenas: 443,
  "generic-smb": 445,
  "generic-nfs": 2049,
};

const DEFAULT_BACKENDS: Record<NasProviderKind, Array<"smb" | "nfs">> = {
  synology: ["smb"],
  truenas: ["smb", "nfs"],
  "generic-smb": ["smb"],
  "generic-nfs": ["nfs"],
};

const CreateBody = z.object({
  id: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253),
  kind: z.enum(["synology", "truenas", "generic-smb", "generic-nfs"]),
  port: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["http", "https"]).optional(),
  backends: z.array(z.enum(["smb", "nfs"])).min(1).optional(),
  credentials: z
    .object({
      username: z.string().max(128).optional(),
      password: z.string().max(256).optional(),
      apiKey: z.string().max(1024).optional(),
    })
    .default({}),
  // When true, the supplied `credentials` are treated as a ONE-TIME admin
  // credential: the console uses them to mint a least-privilege service account
  // on the NAS, persists only that scoped account, and discards the admin
  // credential (never stored, never logged). Synology/TrueNAS only.
  provisionScoped: z.boolean().optional(),
});

/** Slugify a name into a stable, url-safe provider id. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Extract a bare hostname from operator input (accepts `host`, `host:port`, or a URL). */
function normalizeHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.hostname || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-providers", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const configs = await resolveNasProviders();
  const reachability = await Promise.all(configs.map((p) => checkReachable(probeUrl(p))));
  return NextResponse.json({
    providers: configs.map((p, i) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      port: p.port,
      protocol: p.protocol,
      kind: p.kind,
      backends: p.backends,
      source: p.source,
      // A provider is "enabled" once it has usable credentials.
      enabled: p.hasCredentials,
      hasCredentials: p.hasCredentials,
      reachable: reachability[i],
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) {
    logMutatingAccess(req, actor, { status: 401 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:write")) {
    logMutatingAccess(req, actor, { status: 403 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logMutatingAccess(req, actor);
  if (!checkRateLimit(rateLimitKey("nas-provider-save", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = CreateBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const body = parsed.data;

    const hostname = normalizeHostname(body.host);
    if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) {
      return NextResponse.json({ error: "Invalid host" }, { status: 400 });
    }
    const protocol = body.protocol ?? "https";
    // SSRF guard for the WIZARD: accept the host when it's already on the
    // resolved allowlist (env/git overlay + previously-stored providers) OR
    // unambiguously private (RFC1918 / loopback / link-local / `.local` /
    // single-label / `.${INTERNAL_DOMAIN}`). A public/attacker-controlled
    // target is still fail-closed. This is what turns "add a new NAS box" from
    // a git edit + rebuild into a wizard-only flow.
    if (!(await isAllowedInternalHostForWizard(hostname))) {
      return NextResponse.json(
        {
          error:
            `Host ${hostname} is not allowed: it is neither on the internal ` +
            `allowlist nor an unambiguously private address. Use a private IP, ` +
            `a *.${INTERNAL_DOMAIN} name, or add it ` +
            `to the platform host allowlist first.`,
        },
        { status: 400 },
      );
    }

    const kind = body.kind as NasProviderKind;
    const id = body.id ?? slugify(body.name);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      return NextResponse.json({ error: "Could not derive a valid id from the name; provide an explicit id." }, { status: 400 });
    }
    const port = body.port ?? DEFAULT_PORT[kind];
    const backends = body.backends ?? DEFAULT_BACKENDS[kind];

    // Least-privilege self-provisioning: the pasted credentials are a one-time
    // admin credential. Verify it, use it to mint a scoped service account on
    // the NAS, persist ONLY the scoped credential, and let the admin credential
    // fall out of scope — it is never written to OpenBao and never logged.
    if (body.provisionScoped === true && (kind === "synology" || kind === "truenas")) {
      const adminCredentials = {
        username: body.credentials.username,
        password: body.credentials.password,
        apiKey: body.credentials.apiKey,
      };
      const adminProbe = await probeNasCredentials({ host: hostname, port, kind }, adminCredentials);
      if (!adminProbe.ok) {
        await auditLog("nas:provider:configure", actor, `admin test failed for ${id} (${hostname})`, { result: "failure" });
        return NextResponse.json({ error: `Admin credential test failed: ${adminProbe.error ?? "unknown"}` }, { status: 502 });
      }

      const provisioned = await provisionScopedNasAccount({ host: hostname, port, kind }, adminCredentials, [], id);
      if (!provisioned.ok || !provisioned.credentials) {
        await auditLog("nas:provider:configure", actor, `scoped provisioning failed for ${id} (${hostname})`, { result: "failure" });
        return NextResponse.json({ error: provisioned.error ?? "Scoped account provisioning failed" }, { status: 502 });
      }

      // Only the scoped credential survives. Prove it works before persisting.
      const scopedCredentials = provisioned.credentials;
      const scopedProbe = await probeNasCredentials({ host: hostname, port, kind }, scopedCredentials);
      if (!scopedProbe.ok) {
        return NextResponse.json(
          { error: `Scoped account was created but failed verification: ${scopedProbe.error ?? "unknown"}` },
          { status: 502 },
        );
      }

      await upsertStoredNasProvider({ id, name: body.name, host: hostname, port, protocol, kind, backends, credentials: scopedCredentials });
      invalidateInternalHostAllowlist();
      if (kind === "synology" && scopedCredentials.username && scopedCredentials.password) {
        await writeNasSmbCreds(id, { username: scopedCredentials.username, password: scopedCredentials.password });
      }

      await auditLog(
        "nas:provider:configure",
        actor,
        `saved NAS provider ${id} host=${hostname} kind=${kind} via least-privilege account ${provisioned.scopedName ?? "?"}`,
      );
      return NextResponse.json({
        ok: true,
        id,
        reachable: true,
        provisioned: { scopedName: provisioned.scopedName, warning: provisioned.warning },
      });
    }

    // On an existing provider, blank credentials mean "keep the stored ones" —
    // reuse them so we can still run the save & test.
    const existing = (await readStoredNasProviders()).find((p) => p.id === id);
    const credentials = {
      username: body.credentials.username || existing?.credentials.username,
      password: body.credentials.password || existing?.credentials.password,
      apiKey: body.credentials.apiKey || existing?.credentials.apiKey,
    };

    // Prove the credentials work against the live NAS before persisting anything.
    const probe = await probeNasCredentials({ host: hostname, port, kind }, credentials);
    if (!probe.ok) {
      await auditLog("nas:provider:configure", actor, `test failed for ${id} (${hostname})`, { result: "failure" });
      return NextResponse.json({ error: probe.error ?? "Credential test failed" }, { status: 502 });
    }

    await upsertStoredNasProvider({ id, name: body.name, host: hostname, port, protocol, kind, backends, credentials });
    // A newly-stored provider host must be trusted for SSRF-guarded fetches on
    // the very next request (reachability probe, assign, mount-workload).
    invalidateInternalHostAllowlist();

    // SMB-capable providers whose login credentials ARE the SMB credentials
    // (Synology, generic-smb) also get a flat, ESO-readable secret so the assign
    // flow can materialise the CSI Secret for the mount.
    if ((kind === "synology" || kind === "generic-smb") && credentials.username && credentials.password) {
      await writeNasSmbCreds(id, { username: credentials.username, password: credentials.password });
    }

    await auditLog("nas:provider:configure", actor, `saved NAS provider ${id} host=${hostname} kind=${kind}`);
    return NextResponse.json({ ok: true, id, reachable: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

const DeleteBody = z.object({ id: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/) });

export async function DELETE(req: NextRequest) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) {
    logMutatingAccess(req, actor, { status: 401 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:write")) {
    logMutatingAccess(req, actor, { status: 403 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logMutatingAccess(req, actor);
  if (!checkRateLimit(rateLimitKey("nas-provider-delete", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const { id } = parsed.data;

    const removed = await deleteStoredNasProvider(id);
    if (!removed) {
      // Either unknown, or a built-in env provider (which isn't in the store).
      return NextResponse.json(
        { error: `No dynamically-added provider '${id}'. Built-in providers are managed via environment.` },
        { status: 400 },
      );
    }
    await deleteNasSmbCreds(id);
    // Drop the deleted host from the resolved allowlist so a stale entry cannot
    // keep a removed NAS reachable through SSRF-guarded fetches.
    invalidateInternalHostAllowlist();
    await auditLog("nas:provider:delete", actor, `removed NAS provider ${id}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
