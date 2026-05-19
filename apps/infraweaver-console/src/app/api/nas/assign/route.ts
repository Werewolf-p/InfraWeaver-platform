import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseAllowedInternalUrl } from "@/lib/internal-url-allowlist";
import { gitCommitFiles } from "@/lib/git-provider";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { loadUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const SAFE_NAME = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$/;
const SAFE_SUBFOLDER = /^(?!.*\.\.)(?!\/)(?!.*\/\/)[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/i;
const K8S_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SAFE_HOST = /^[a-z0-9.-]+$/i;
const YAML_UNSAFE_RE = /[\r\n\[\]{}&*!|>'"%@`]/;

const AssignBody = z.object({
  username: z.string().min(1).max(63).regex(K8S_NAME_RE, "Invalid username"),
  provider: z.enum(["synology", "truenas"]),
  share: z.string().min(1).max(63),
  subfolder: z.string().min(1).max(200).optional(),
  access: z.enum(["readonly", "readwrite"]),
  pvc_namespace: z.string().min(1).max(63).regex(K8S_NAME_RE).optional(),
  pvc_name: z.string().min(1).max(253).regex(K8S_NAME_RE).optional(),
});

const DeleteBody = z.object({
  username: z.string().min(1).max(63).regex(K8S_NAME_RE),
  provider: z.string().min(1).max(30),
  share: z.string().min(1).max(63),
  subfolder: z.string().min(1).max(200).optional(),
});

interface NasShareAssignment {
  provider: "synology" | "truenas";
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

function generateK8sManifest(
  params: {
    username: string;
    provider: string;
    share: string;
    subfolder: string;
    pvc_name: string;
    pvc_namespace: string;
    host: string;
  },
  yamlLib: Pick<typeof import("js-yaml"), "dump">,
): string {
  const { username, provider, share, subfolder, pvc_name, pvc_namespace, host } = params;
  const scName = `smb-${username}-${share.toLowerCase()}`;
  const documents = [
    {
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: { name: scName },
      provisioner: "smb.csi.k8s.io",
      reclaimPolicy: "Retain",
      volumeBindingMode: "Immediate",
      allowVolumeExpansion: false,
      parameters: {
        source: `//${host}/${share}`,
        subDir: subfolder,
        "csi.storage.k8s.io/provisioner-secret-name": "synology-smb-credentials",
        "csi.storage.k8s.io/provisioner-secret-namespace": pvc_namespace,
        "csi.storage.k8s.io/node-stage-secret-name": "synology-smb-credentials",
        "csi.storage.k8s.io/node-stage-secret-namespace": pvc_namespace,
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvc_name,
        namespace: pvc_namespace,
        labels: {
          "infraweaver.io/nas-share": "true",
          "infraweaver.io/user": username,
          "infraweaver.io/provider": provider,
        },
      },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: scName,
        resources: {
          requests: {
            storage: "100Gi",
          },
        },
      },
    },
  ];

  return documents.map((document) => yamlLib.dump(document, { lineWidth: -1, indent: 2 })).join("---\n");
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

    const pvc_namespace = body.pvc_namespace ?? "plex";
    const pvc_name = body.pvc_name ?? `nas-${username}-${share.toLowerCase()}`;
    const host = provider === "synology" ? (process.env.SYNOLOGY_HOST ?? "10.25.0.21") : (process.env.TRUENAS_HOST ?? "10.25.0.135");

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
      { provider, share, subfolder, access, pvc_namespace, pvc_name, created_at: new Date().toISOString() },
    ];

    const manifestContent = generateK8sManifest({ username, provider, share, subfolder, pvc_name, pvc_namespace, host }, yaml);
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
  if (!hasSessionPermission(access, "nas:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    if (usersData?.users?.[username]) {
      const existing = (usersData.users[username].nas_shares as NasShareAssignment[]) ?? [];
      usersData.users[username].nas_shares = existing.filter((entry) => !(entry.provider === provider && entry.share === share && (entry.subfolder ?? username) === subfolder));
    }

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
