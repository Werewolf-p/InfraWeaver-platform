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
import {
  invalidateInternalHostAllowlist,
  isAllowedInternalHostForWizard,
} from "@/lib/internal-url-allowlist-server";
import { probeNasCredentials, type ProbeResult } from "@/lib/nas/discovery";
import {
  fetchNasService,
  formatFingerprint,
  isNasCertificateError,
  normalizeFingerprint,
  type NasPeerCertificate,
} from "@/lib/nas/pinned-fetch";
import { provisionScopedNasAccount } from "@/lib/nas/provision-account";
import { listProviderConfigs, resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";
import {
  deleteNasSmbCreds,
  deleteStoredNasProvider,
  readStoredNasProviders,
  suppressEnvProvider,
  unsuppressEnvProvider,
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
      return `${base}/api/v2.0/system/info`;
    case "generic-smb":
    case "generic-nfs":
      return base;
  }
}

/**
 * Liveness only — never sends credentials. A certificate error still means the
 * appliance answered on the wire, so it counts as reachable; trust is decided
 * separately at save time.
 */
async function checkReachable(url: string, pin?: string): Promise<boolean> {
  try {
    const res = await fetchNasService(url, { timeoutMs: 2000 }, { pin });
    return res.ok || res.status < 500;
  } catch (error) {
    return isNasCertificateError(error);
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
  /**
   * SHA-256 fingerprint of the appliance's TLS certificate, as shown to and
   * confirmed by the operator. Required before the console will send any
   * credential to an appliance with a self-signed certificate.
   */
  tlsFingerprint256: z.string().regex(/^[0-9A-Fa-f:\s]{64,95}$/).optional(),
  /**
   * TrueNAS only: the existing TrueNAS user the minted scoped API key is bound
   * to. `api_key.create` requires it and the key inherits that user's rights.
   */
  scopedUsername: z.string().max(128).optional(),
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

/**
 * A NAS appliance ships a self-signed certificate, so the first save cannot
 * verify it against any CA. Rather than trusting it silently, answer 409 with
 * the certificate we observed; the wizard shows it and re-submits with
 * `tlsFingerprint256` once the operator confirms. No credential was sent to the
 * appliance to produce this response.
 */
function certificateChallenge(probe: ProbeResult & { certificate: NasPeerCertificate }): NextResponse {
  const { certificate } = probe;
  return NextResponse.json(
    {
      error: probe.error,
      needsCertificateTrust: true,
      certificateState: probe.certificateState,
      certificate: {
        ...certificate,
        fingerprintDisplay: formatFingerprint(certificate.fingerprint256),
      },
    },
    { status: 409 },
  );
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
  const reachability = await Promise.all(configs.map((p) => checkReachable(probeUrl(p), p.tlsFingerprint256)));
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

    const existing = (await readStoredNasProviders()).find((p) => p.id === id);
    // An explicit fingerprint means "the operator just confirmed this cert".
    // Otherwise reuse the pin already trusted for this provider, so a rename or
    // a port change does not force the operator to re-confirm the certificate.
    let pin: string | undefined;
    if (body.tlsFingerprint256) {
      try {
        pin = normalizeFingerprint(body.tlsFingerprint256);
      } catch {
        return NextResponse.json({ error: "Invalid TLS certificate fingerprint" }, { status: 400 });
      }
    }
    const priorPin = existing?.tlsFingerprint256;
    // Trusting a NEW certificate for a provider that already had one is the
    // security-relevant event: either the appliance rotated its cert, or someone
    // is on the path. Record the transition so it is findable after the fact —
    // the generic "saved provider" line below would not distinguish the two.
    if (pin && priorPin && pin !== priorPin) {
      await auditLog(
        "nas:provider:retrust",
        actor,
        `TLS pin for ${id} (${hostname}) changed ${formatFingerprint(priorPin)} -> ${formatFingerprint(pin)}`,
      );
    }
    pin ??= priorPin;
    const probeTarget = { host: hostname, port, kind, tlsFingerprint256: pin };

    // Least-privilege self-provisioning: the pasted credentials are a one-time
    // admin credential. Verify it, use it to mint a scoped service account on
    // the NAS, persist ONLY the scoped credential, and let the admin credential
    // fall out of scope — it is never written to OpenBao and never logged.
    if (body.provisionScoped === true && (kind === "synology" || kind === "truenas")) {
      const adminCredentials = {
        username: body.credentials.username,
        password: body.credentials.password,
        apiKey: body.credentials.apiKey,
        scopedUsername: body.scopedUsername,
      };
      const adminProbe = await probeNasCredentials(probeTarget, adminCredentials);
      if (adminProbe.certificate) return certificateChallenge({ ...adminProbe, certificate: adminProbe.certificate });
      if (!adminProbe.ok) {
        await auditLog("nas:provider:configure", actor, `admin test failed for ${id} (${hostname})`, { result: "failure" });
        return NextResponse.json({ error: `Admin credential test failed: ${adminProbe.error ?? "unknown"}` }, { status: 502 });
      }

      const provisioned = await provisionScopedNasAccount(probeTarget, adminCredentials, [], id);
      if (!provisioned.ok || !provisioned.credentials) {
        await auditLog("nas:provider:configure", actor, `scoped provisioning failed for ${id} (${hostname})`, { result: "failure" });
        return NextResponse.json({ error: provisioned.error ?? "Scoped account provisioning failed" }, { status: 502 });
      }

      // Only the scoped credential survives. Prove it works before persisting.
      const scopedCredentials = provisioned.credentials;
      const scopedProbe = await probeNasCredentials(probeTarget, scopedCredentials);
      if (!scopedProbe.ok) {
        return NextResponse.json(
          { error: `Scoped account was created but failed verification: ${scopedProbe.error ?? "unknown"}` },
          { status: 502 },
        );
      }

      await upsertStoredNasProvider({ id, name: body.name, host: hostname, port, protocol, kind, backends, credentials: scopedCredentials, tlsFingerprint256: pin });
      // Re-adding an id that was previously hidden lifts its tombstone.
      await unsuppressEnvProvider(id);
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
    const credentials = {
      username: body.credentials.username || existing?.credentials.username,
      password: body.credentials.password || existing?.credentials.password,
      apiKey: body.credentials.apiKey || existing?.credentials.apiKey,
    };

    // Prove the credentials work against the live NAS before persisting anything.
    const probe = await probeNasCredentials(probeTarget, credentials);
    if (probe.certificate) return certificateChallenge({ ...probe, certificate: probe.certificate });
    if (!probe.ok) {
      await auditLog("nas:provider:configure", actor, `test failed for ${id} (${hostname})`, { result: "failure" });
      return NextResponse.json({ error: probe.error ?? "Credential test failed" }, { status: 502 });
    }

    await upsertStoredNasProvider({ id, name: body.name, host: hostname, port, protocol, kind, backends, credentials, tlsFingerprint256: pin });
    // Re-adding an id that was previously hidden lifts its tombstone.
    await unsuppressEnvProvider(id);
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
      // Not in the OpenBao store. If it is an env-declared built-in, "remove" it
      // by recording a tombstone — resolveNasProviders() then hides it. The env
      // var stays put (it is git/deployment-managed); this just clears it from
      // the console. Re-adding the same id via the wizard lifts the tombstone.
      const isEnvBuiltIn = listProviderConfigs().some((p) => p.id === id);
      if (isEnvBuiltIn) {
        await suppressEnvProvider(id);
        await deleteNasSmbCreds(id);
        invalidateInternalHostAllowlist();
        await auditLog("nas:provider:delete", actor, `hid env-declared NAS provider ${id}`);
        return NextResponse.json({ ok: true, hidden: true });
      }
      return NextResponse.json(
        { error: `No provider '${id}' to remove.` },
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
