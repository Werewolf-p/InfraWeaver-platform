import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseAllowedInternalUrl } from "@/lib/internal-url-allowlist";
import { gitCommitFiles } from "@/lib/git-provider";
import { generateK8sManifest, type NasBackend } from "@/lib/nas/manifest";
import { evaluateFolderAcl } from "@/lib/nas/folder-acl";
import { getProviderConfig, listProviderConfigs } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionEffectivePermissions, getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { loadUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const SAFE_NAME = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$/;
const SAFE_SUBFOLDER = /^(?!.*\.\.)(?!\/)(?!.*\/\/)[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/i;
const K8S_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SAFE_HOST = /^[a-z0-9.-]+$/i;
const YAML_UNSAFE_RE = /[\r\n\[\]{}&*!|>'"%@`]/;

// `provider` is an open string so future providers registered via
// `NAS_PROVIDERS_JSON` work without a code change. It is validated against the
// live registry at request time (below).
const AssignBody = z.object({
  username: z.string().min(1).max(63).regex(K8S_NAME_RE, "Invalid username"),
  provider: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  backend: z.enum(["smb", "nfs"]).optional(),
  share: z.string().min(1).max(63),
  subfolder: z.string().min(1).max(200).optional(),
  access: z.enum(["readonly", "readwrite"]),
  pvc_namespace: z.string().min(1).max(63).regex(K8S_NAME_RE).optional(),
  pvc_name: z.string().min(1).max(253).regex(K8S_NAME_RE).optional(),
  size: z.string().min(1).max(20).regex(/^[0-9]+(Ki|Mi|Gi|Ti|Pi)$/).optional(),
});

const DeleteBody = z.object({
  username: z.string().min(1).max(63).regex(K8S_NAME_RE),
  provider: z.string().min(1).max(63),
  share: z.string().min(1).max(63),
  subfolder: z.string().min(1).max(200).optional(),
});

interface NasShareAssignment {
  provider: string;
  backend?: NasBackend;
  share: string;
  subfolder?: string;
  access: "readonly" | "readwrite";
  pvc_namespace?: string;
  pvc_name?: string;
  created_at?: string;
}

function isSafeYamlScalar(value: string) {
  return value.length > 0
    && !/^\s*:/.test(value)
    && !/^\s/.test(value)
    && !/\s$/.test(value)
    && !YAML_UNSAFE_RE.test(value);
}

// (Manifest generator lives in `@/lib/nas/manifest` for unit-testability.)

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  // `nas:write` gates NAS-share management; provisioning a StorageClass/PVC into
  // a caller-chosen `pvc_namespace` is a catalog mutation, so also require
  // `catalog:write`. Without it, a bare `nas:write` holder could place a PVC in
  // any namespace (cross-namespace name collision / share hijack).
  if (!hasSessionPermission(rbac, "nas:write") || !hasSessionPermission(rbac, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("nas-assign-post", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = AssignBody.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const body = parsed.data;
    const { username, provider, share, access } = body;
    const subfolder = body.subfolder ?? username;

    if (!SAFE_NAME.test(username)) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
    if (!SAFE_NAME.test(share)) return NextResponse.json({ error: "Invalid share name" }, { status: 400 });
    if (subfolder && !SAFE_SUBFOLDER.test(subfolder)) return NextResponse.json({ error: "Invalid subfolder" }, { status: 400 });

    // Resolve the provider via the registry so `synology` isn't hardcoded and
    // future providers work without touching this route (plan §"generic").
    const providerCfg = getProviderConfig(provider);
    if (!providerCfg) {
      return NextResponse.json({ error: `Unknown NAS provider '${provider}'. Registered: ${listProviderConfigs().map((p) => p.id).join(", ") || "(none)"}` }, { status: 400 });
    }
    const backend: NasBackend = body.backend ?? providerCfg.backends[0];
    if (!providerCfg.backends.includes(backend)) {
      return NextResponse.json({ error: `Provider '${provider}' does not support backend '${backend}'` }, { status: 400 });
    }

    // Folder-level ACL. Callers with `*` bypass; otherwise the requested
    // (provider, share, subfolder, access) must be granted to the caller's
    // groups (or their `@user:<name>` identity). Undeclared shares stay open.
    const permissions = [...getSessionEffectivePermissions(rbac)];
    const aclDecision = evaluateFolderAcl({
      username: rbac.username || username,
      groups: rbac.groups,
      permissions,
      provider,
      share,
      subfolder,
      access: body.access,
    });
    if (!aclDecision.allowed) {
      return NextResponse.json({ error: `NAS folder ACL denied: ${aclDecision.reason}` }, { status: 403 });
    }

    const pvc_namespace = body.pvc_namespace ?? username;
    const pvc_name = body.pvc_name ?? `nas-${username}-${share.toLowerCase()}`;
    const host = providerCfg.host;

    for (const [field, value] of Object.entries({ username, share, subfolder, pvc_namespace, pvc_name })) {
      if (!isSafeYamlScalar(value)) {
        return NextResponse.json({ error: `Invalid ${field}` }, { status: 400 });
      }
    }
    if (!SAFE_HOST.test(host) || !isSafeYamlScalar(host) || !parseAllowedInternalUrl(`https://${host}`)) {
      return NextResponse.json({ error: "Invalid host" }, { status: 400 });
    }

    const yaml = await import("js-yaml");
    const { users, raw } = await loadUsersConfig();
    if (!users[username]) return NextResponse.json({ error: `User '${username}' not found` }, { status: 404 });

    const usersData = yaml.load(raw) as { users?: Record<string, Record<string, unknown>> };
    if (!usersData?.users?.[username]) return NextResponse.json({ error: `User '${username}' not found` }, { status: 404 });

    const userData = usersData.users[username];
    const existingShares = (userData.nas_shares as NasShareAssignment[]) ?? [];
    userData.nas_shares = [
      ...existingShares,
      { provider, backend, share, subfolder, access, pvc_namespace, pvc_name, created_at: new Date().toISOString() },
    ];

    const manifestContent = generateK8sManifest({ username, provider, backend, share, subfolder, pvc_name, pvc_namespace, host, access, size: body.size }, yaml);
    const manifestSubfolder = subfolder.replace(/\//g, "-");
    const manifestPath = `kubernetes/catalog/nas-shares/${username}-${share.toLowerCase()}-${manifestSubfolder}.yaml`;
    const newUsersContent = yaml.dump(usersData, { lineWidth: -1, indent: 2 });
    await gitCommitFiles({
      message: `feat(nas): assign ${share}/${subfolder} to ${username}`,
      addOrUpdateFiles: [
        { path: manifestPath, content: manifestContent },
        { path: "users.yaml", content: newUsersContent },
      ],
    });

    return NextResponse.json({ ok: true, pvc_name, pvc_namespace, manifest_path: manifestPath, yaml: manifestContent });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  // Same authority as POST: deleting the assignment removes a StorageClass/PVC
  // manifest from `kubernetes/catalog/`, so require both permissions.
  if (!hasSessionPermission(access, "nas:write") || !hasSessionPermission(access, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("nas-assign-delete", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = DeleteBody.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const { username, provider, share } = parsed.data;
    const subfolder = parsed.data.subfolder ?? username;
    if (subfolder && !SAFE_SUBFOLDER.test(subfolder)) return NextResponse.json({ error: "Invalid subfolder" }, { status: 400 });
    for (const [field, value] of Object.entries({ username, share, subfolder })) {
      if (!isSafeYamlScalar(value)) {
        return NextResponse.json({ error: `Invalid ${field}` }, { status: 400 });
      }
    }

    const yaml = await import("js-yaml");
    const { raw } = await loadUsersConfig();
    const usersData = yaml.load(raw) as { users?: Record<string, Record<string, unknown>> };
    const existing = (usersData?.users?.[username]?.nas_shares as NasShareAssignment[]) ?? [];
    const matched = existing.find((entry) => entry.provider === provider && entry.share === share && (entry.subfolder ?? username) === subfolder);
    // Nothing to revoke — idempotent no-op, and never delete a manifest we
    // can't tie back to a recorded assignment.
    if (!matched) return NextResponse.json({ ok: true, removed: false });

    // Enforce the same folder ACL as POST, using the assignment's own access
    // mode. Without this, any catalog:write+nas:write holder could revoke a
    // share the ACL would have blocked them from ever assigning.
    const permissions = [...getSessionEffectivePermissions(access)];
    const aclDecision = evaluateFolderAcl({
      username: access.username || username,
      groups: access.groups,
      permissions,
      provider,
      share,
      subfolder,
      access: matched.access,
    });
    if (!aclDecision.allowed) {
      return NextResponse.json({ error: `NAS folder ACL denied: ${aclDecision.reason}` }, { status: 403 });
    }

    usersData!.users![username].nas_shares = existing.filter((entry) => entry !== matched);

    const manifestSubfolder = subfolder.replace(/\//g, "-");
    const manifestPath = `kubernetes/catalog/nas-shares/${username}-${share.toLowerCase()}-${manifestSubfolder}.yaml`;
    const newUsersContent = yaml.dump(usersData, { lineWidth: -1, indent: 2 });
    await gitCommitFiles({
      message: `feat(nas): revoke ${share}/${subfolder} from ${username}`,
      addOrUpdateFiles: [{ path: "users.yaml", content: newUsersContent }],
      deleteFiles: [manifestPath],
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
