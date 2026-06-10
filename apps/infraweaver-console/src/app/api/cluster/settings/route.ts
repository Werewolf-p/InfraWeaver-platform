import { NextRequest, NextResponse } from "next/server";
import * as jsYaml from "js-yaml";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { withAuth } from "@/lib/with-auth";
import { getGitAccessToken, gitCommitFiles, gitReadFile } from "@/lib/git-provider";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const ResourceChangeSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.union([z.string().max(256), z.number()]),
});
const ClusterSettingsPutSchema = z.object({
  changes: z.array(ResourceChangeSchema).min(1).max(100),
  commitMessage: z.string().max(256).optional(),
});

type SettingType = "string" | "number" | "select";

interface ResourceSettingDef {
  key: string;
  group: string;
  label: string;
  description: string;
  file: string;
  yamlPath: string;
  type: SettingType;
  options?: string[];
  min?: number;
  max?: number;
  argoApp: string;
  unit?: string;
  placeholder?: string;
}

const GIT_TOKEN = getGitAccessToken();

// Resource limit settings for all platform services
const RESOURCE_DEFS: ResourceSettingDef[] = [
  // ── Authentik ──────────────────────────────────────────────────────────────
  {
    key: "authentik.server.cpuLimit",
    group: "Authentik",
    label: "Server CPU Limit",
    description: "Max CPU per Authentik server pod. Higher values allow faster SSO response under load.",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "server.resources.limits.cpu",
    type: "string",
    argoApp: "platform-authentik",
    unit: "cores",
    placeholder: "e.g. 1000m or 2",
  },
  {
    key: "authentik.server.memoryLimit",
    group: "Authentik",
    label: "Server Memory Limit",
    description: "Max memory per Authentik server pod. Too low causes OOM restarts and SSO outages.",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "server.resources.limits.memory",
    type: "string",
    argoApp: "platform-authentik",
    unit: "bytes",
    placeholder: "e.g. 1Gi or 512Mi",
  },
  {
    key: "authentik.server.memoryRequest",
    group: "Authentik",
    label: "Server Memory Request",
    description: "Guaranteed memory reserved per Authentik server pod.",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "server.resources.requests.memory",
    type: "string",
    argoApp: "platform-authentik",
    unit: "bytes",
    placeholder: "e.g. 256Mi",
  },
  {
    key: "authentik.worker.cpuLimit",
    group: "Authentik",
    label: "Worker CPU Limit",
    description: "Max CPU per Authentik background-task worker pod.",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "worker.resources.limits.cpu",
    type: "string",
    argoApp: "platform-authentik",
    unit: "cores",
    placeholder: "e.g. 500m",
  },
  {
    key: "authentik.worker.memoryLimit",
    group: "Authentik",
    label: "Worker Memory Limit",
    description: "Max memory per Authentik worker pod. Increase if background tasks OOM-crash.",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "worker.resources.limits.memory",
    type: "string",
    argoApp: "platform-authentik",
    unit: "bytes",
    placeholder: "e.g. 512Mi",
  },
  // ── ArgoCD ─────────────────────────────────────────────────────────────────
  {
    key: "argocd.server.cpuLimit",
    group: "ArgoCD",
    label: "Server CPU Limit",
    description: "Max CPU for the ArgoCD API server pod.",
    file: "kubernetes/core/argocd/values.yaml",
    yamlPath: "server.resources.limits.cpu",
    type: "string",
    argoApp: "core-argocd-manifests",
    unit: "cores",
    placeholder: "e.g. 1000m",
  },
  {
    key: "argocd.server.memoryLimit",
    group: "ArgoCD",
    label: "Server Memory Limit",
    description: "Max memory for the ArgoCD API server pod.",
    file: "kubernetes/core/argocd/values.yaml",
    yamlPath: "server.resources.limits.memory",
    type: "string",
    argoApp: "core-argocd-manifests",
    unit: "bytes",
    placeholder: "e.g. 1Gi",
  },
  {
    key: "argocd.controller.memoryRequest",
    group: "ArgoCD",
    label: "App Controller Memory",
    description: "Memory reserved for the ArgoCD application controller. Increase if the controller OOMs with many apps.",
    file: "kubernetes/core/argocd/values.yaml",
    yamlPath: "controller.resources.requests.memory",
    type: "string",
    argoApp: "core-argocd-manifests",
    unit: "bytes",
    placeholder: "e.g. 512Mi",
  },
  // ── Grafana ────────────────────────────────────────────────────────────────
  {
    key: "grafana.cpuLimit",
    group: "Grafana",
    label: "CPU Limit",
    description: "Max CPU for the Grafana dashboard pod.",
    file: "kubernetes/platform/grafana/values.yaml",
    yamlPath: "resources.limits.cpu",
    type: "string",
    argoApp: "platform-grafana",
    unit: "cores",
    placeholder: "e.g. 500m",
  },
  {
    key: "grafana.memoryLimit",
    group: "Grafana",
    label: "Memory Limit",
    description: "Max memory for the Grafana dashboard pod.",
    file: "kubernetes/platform/grafana/values.yaml",
    yamlPath: "resources.limits.memory",
    type: "string",
    argoApp: "platform-grafana",
    unit: "bytes",
    placeholder: "e.g. 512Mi",
  },
  {
    key: "grafana.memoryRequest",
    group: "Grafana",
    label: "Memory Request",
    description: "Guaranteed memory reserved for the Grafana pod.",
    file: "kubernetes/platform/grafana/values.yaml",
    yamlPath: "resources.requests.memory",
    type: "string",
    argoApp: "platform-grafana",
    unit: "bytes",
    placeholder: "e.g. 128Mi",
  },
  // ── Longhorn ───────────────────────────────────────────────────────────────
  {
    key: "longhorn.instanceManagerCPU",
    group: "Longhorn",
    label: "Instance Manager CPU Guarantee",
    description: "CPU % guaranteed to each Longhorn instance manager per node. Increase if disk I/O is throttled.",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.guaranteedInstanceManagerCPU",
    type: "number",
    min: 0,
    max: 40,
    argoApp: "core-longhorn",
    unit: "%",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getNestedPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = obj;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  if (!GIT_TOKEN) {
    return NextResponse.json({ error: "Missing git provider token" }, { status: 503 });
  }

  try {
    const uniqueFiles = Array.from(new Set(RESOURCE_DEFS.map((d) => d.file)));
    const fileEntries = await Promise.all(
      uniqueFiles.map(async (filePath) => {
        const file = await gitReadFile(filePath);
        if (!file) throw new Error(`Repository file not found: ${filePath}`);
        const parsed = toRecord(jsYaml.load(file.content));
        return [filePath, { parsed, sha: file.sha }] as const;
      }),
    );
    const filesByPath = Object.fromEntries(fileEntries) as Record<string, { parsed: Record<string, unknown>; sha: string }>;
    const values = Object.fromEntries(
      RESOURCE_DEFS.map((d) => [d.key, getNestedPath(filesByPath[d.file].parsed, d.yamlPath)]),
    );
    const files = Object.fromEntries(uniqueFiles.map((f) => [f, filesByPath[f].sha]));
    return NextResponse.json({ schema: RESOURCE_DEFS, values, files });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!GIT_TOKEN) {
    return NextResponse.json({ error: "Missing git provider token" }, { status: 503 });
  }

  try {
    const parseResult = ClusterSettingsPutSchema.safeParse(await req.json().catch(() => null));
    if (!parseResult.success) {
      return NextResponse.json({ error: parseResult.error.flatten() }, { status: 400 });
    }
    const body = parseResult.data;
    if (!Array.isArray(body.changes) || body.changes.length === 0) {
      return NextResponse.json({ error: "No changes provided" }, { status: 400 });
    }

    // Validate and normalise changes
    const validChanges: Array<{ def: ResourceSettingDef; value: string | number }> = [];
    for (const change of body.changes) {
      const def = RESOURCE_DEFS.find((d) => d.key === change.key);
      if (!def) return NextResponse.json({ error: `Unknown setting: ${change.key}` }, { status: 400 });
      let value: string | number;
      if (def.type === "number") {
        value = Number(change.value);
        if (!Number.isFinite(value)) return NextResponse.json({ error: `Invalid number for ${def.label}` }, { status: 400 });
        if (def.min !== undefined && value < def.min) return NextResponse.json({ error: `${def.label} must be ≥ ${def.min}` }, { status: 400 });
        if (def.max !== undefined && value > def.max) return NextResponse.json({ error: `${def.label} must be ≤ ${def.max}` }, { status: 400 });
      } else {
        if (typeof change.value !== "string" || !change.value.trim()) {
          return NextResponse.json({ error: `${def.label} must be a non-empty string` }, { status: 400 });
        }
        value = change.value.trim();
      }
      validChanges.push({ def, value });
    }

    // Group by file
    const byFile = validChanges.reduce<Map<string, typeof validChanges>>((m, c) => {
      const arr = m.get(c.def.file) ?? [];
      arr.push(c);
      m.set(c.def.file, arr);
      return m;
    }, new Map());

    const labels = [...new Set(validChanges.map((c) => `${c.def.group}: ${c.def.label}`))];
    const commitMsg =
      body.commitMessage?.trim() ||
      `feat(cluster): update ${labels.join(", ")} via InfraWeaver Console\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;

    const filesToWrite = await Promise.all(
      Array.from(byFile.entries()).map(async ([filePath, changes]) => {
        const file = await gitReadFile(filePath);
        if (!file) throw new Error(`Repository file not found: ${filePath}`);
        const parsed = toRecord(jsYaml.load(file.content));
        for (const { def, value } of changes) setNestedPath(parsed, def.yamlPath, value);
        return {
          path: filePath,
          content: jsYaml.dump(parsed, { lineWidth: -1, indent: 2 }),
        };
      }),
    );

    await gitCommitFiles({
      message: commitMsg,
      addOrUpdateFiles: filesToWrite,
    });

    return NextResponse.json({
      ok: true,
      affectedApps: [...new Set(validChanges.map((c) => c.def.argoApp))],
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
