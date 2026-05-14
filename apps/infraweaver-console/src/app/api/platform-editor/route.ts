import { NextRequest, NextResponse } from "next/server";
import * as jsYaml from "js-yaml";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

type SettingType = "number" | "string" | "select";

interface SettingDefinition {
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
}

interface GitHubFileResponse {
  content: string;
  sha: string;
}

interface PlatformEditorChange {
  key: string;
  value: unknown;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

const SETTING_DEFS: SettingDefinition[] = [
  {
    key: "longhorn.defaultReplicaCount",
    group: "Longhorn Storage",
    label: "Volume Replicas",
    description: "Replicas per Longhorn volume. 3 = HA across all 3 nodes.",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.defaultReplicaCount",
    type: "number",
    min: 1,
    max: 5,
    argoApp: "core-longhorn",
    unit: "replicas",
  },
  {
    key: "longhorn.storageMinimalAvailablePercentage",
    group: "Longhorn Storage",
    label: "Min Available Disk",
    description: "Won't schedule new replicas if disk is below this %",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.storageMinimalAvailablePercentage",
    type: "number",
    min: 5,
    max: 50,
    argoApp: "core-longhorn",
    unit: "%",
  },
  {
    key: "longhorn.storageReservedPercentageForDefaultDisk",
    group: "Longhorn Storage",
    label: "Reserved Disk %",
    description: "Disk % reserved for system use per node",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.storageReservedPercentageForDefaultDisk",
    type: "number",
    min: 5,
    max: 30,
    argoApp: "core-longhorn",
    unit: "%",
  },
  {
    key: "longhorn.concurrentReplicaRebuildPerNodeLimit",
    group: "Longhorn Storage",
    label: "Concurrent Rebuilds/Node",
    description: "Max simultaneous replica rebuilds per node — keep at 1 to prevent I/O storms",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.concurrentReplicaRebuildPerNodeLimit",
    type: "number",
    min: 1,
    max: 5,
    argoApp: "core-longhorn",
  },
  {
    key: "longhorn.replicaReplenishmentWaitInterval",
    group: "Longhorn Storage",
    label: "Rebuild Wait Interval",
    description: "Seconds to wait before starting replica rebuild after node flap",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.replicaReplenishmentWaitInterval",
    type: "number",
    min: 0,
    max: 3600,
    argoApp: "core-longhorn",
    unit: "s",
  },
  {
    key: "longhorn.guaranteedInstanceManagerCPU",
    group: "Longhorn Storage",
    label: "Instance Manager CPU",
    description: "CPU% reserved for Longhorn instance managers on each node",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.guaranteedInstanceManagerCPU",
    type: "number",
    min: 5,
    max: 25,
    argoApp: "core-longhorn",
    unit: "%",
  },
  {
    key: "longhorn.replicaAutoBalance",
    group: "Longhorn Storage",
    label: "Replica Auto-Balance",
    description: "Automatically rebalance replicas when nodes have unequal counts",
    file: "kubernetes/core/longhorn/values.yaml",
    yamlPath: "defaultSettings.replicaAutoBalance",
    type: "select",
    options: ["disabled", "least-effort", "best-effort"],
    argoApp: "core-longhorn",
  },
  {
    key: "traefik.replicas",
    group: "Traefik",
    label: "Ingress Replicas",
    description: "Number of Traefik ingress controller replicas (min 2 for HA)",
    file: "kubernetes/core/traefik/values.yaml",
    yamlPath: "deployment.replicas",
    type: "number",
    min: 1,
    max: 4,
    argoApp: "core-traefik",
    unit: "replicas",
  },
  {
    key: "argocd.serverReplicas",
    group: "ArgoCD",
    label: "Server Replicas",
    description: "ArgoCD web UI server replicas (min 2 for HA)",
    file: "kubernetes/core/argocd/values.yaml",
    yamlPath: "server.replicas",
    type: "number",
    min: 1,
    max: 3,
    argoApp: "core-argocd",
    unit: "replicas",
  },
  {
    key: "authentik.serverReplicas",
    group: "Authentik",
    label: "Server Replicas",
    description: "Authentik SSO server replicas — handles web traffic and API",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "server.replicas",
    type: "number",
    min: 1,
    max: 4,
    argoApp: "platform-authentik",
    unit: "replicas",
  },
  {
    key: "authentik.serverMemory",
    group: "Authentik",
    label: "Server Memory Limit",
    description: "Max memory per Authentik server pod",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "server.resources.limits.memory",
    type: "select",
    options: ["512Mi", "1Gi", "1536Mi", "2Gi"],
    argoApp: "platform-authentik",
  },
  {
    key: "authentik.workerReplicas",
    group: "Authentik",
    label: "Worker Replicas",
    description: "Authentik background worker replicas — handles flows, sync tasks",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "worker.replicas",
    type: "number",
    min: 1,
    max: 4,
    argoApp: "platform-authentik",
    unit: "replicas",
  },
  {
    key: "authentik.workerMemory",
    group: "Authentik",
    label: "Worker Memory Limit",
    description: "Max memory per Authentik worker pod",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "worker.resources.limits.memory",
    type: "select",
    options: ["256Mi", "512Mi", "768Mi", "1Gi"],
    argoApp: "platform-authentik",
  },
  {
    key: "authentik.postgresMemory",
    group: "Authentik",
    label: "PostgreSQL Memory Limit",
    description: "Max memory for Authentik PostgreSQL database pod",
    file: "kubernetes/platform/authentik/values.yaml",
    yamlPath: "postgresql.primary.resources.limits.memory",
    type: "select",
    options: ["256Mi", "512Mi", "768Mi", "1Gi"],
    argoApp: "platform-authentik",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function ensureGitHubConfig() {
  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }
}

function decodeGitHubContent(content: string) {
  return Buffer.from(content, "base64").toString("utf-8");
}

function buildCommitMessage(definitions: SettingDefinition[]) {
  const labels = Array.from(new Set(definitions.map((definition) => `${definition.group}: ${definition.label}`)));
  return `feat(platform): update ${labels.join(", ")} via InfraWeaver Console\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
}

function normalizeSettingValue(definition: SettingDefinition, rawValue: unknown): number | string {
  if (definition.type === "number") {
    const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      throw new Error(`Invalid number for ${definition.label}`);
    }
    if (definition.min !== undefined && numericValue < definition.min) {
      throw new Error(`${definition.label} must be at least ${definition.min}`);
    }
    if (definition.max !== undefined && numericValue > definition.max) {
      throw new Error(`${definition.label} must be at most ${definition.max}`);
    }
    return numericValue;
  }

  if (typeof rawValue !== "string") {
    throw new Error(`Invalid value for ${definition.label}`);
  }

  if (definition.type === "select" && !definition.options?.includes(rawValue)) {
    throw new Error(`Invalid option for ${definition.label}`);
  }

  return rawValue;
}

function getSettingDefinition(key: string) {
  return SETTING_DEFS.find((definition) => definition.key === key);
}

async function getFileFromGitHub(filePath: string) {
  ensureGitHubConfig();

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  return res.json() as Promise<GitHubFileResponse>;
}

async function commitFileToGitHub(filePath: string, content: string, sha: string, message: string) {
  ensureGitHubConfig();

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      sha,
      committer: {
        name: "InfraWeaver Console",
        email: "console@infraweaver.internal",
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub commit failed: ${res.status}`);
  }

  return res.json();
}

export function getNestedPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;

  for (const segment of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

export function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = obj;

  for (const segment of segments.slice(0, -1)) {
    const nextValue = current[segment];
    if (!isRecord(nextValue)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const groups: string[] = (session.user as { groups?: string[] } | undefined)?.groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const uniqueFiles = Array.from(new Set(SETTING_DEFS.map((definition) => definition.file)));
    const fileEntries = await Promise.all(
      uniqueFiles.map(async (filePath) => {
        const file = await getFileFromGitHub(filePath);
        const parsed = toRecord(jsYaml.load(decodeGitHubContent(file.content)));
        return [filePath, { parsed, sha: file.sha }] as const;
      }),
    );

    const filesByPath = Object.fromEntries(fileEntries) as Record<string, { parsed: Record<string, unknown>; sha: string }>;
    const values = Object.fromEntries(
      SETTING_DEFS.map((definition) => [definition.key, getNestedPath(filesByPath[definition.file].parsed, definition.yamlPath)]),
    );
    const files = Object.fromEntries(uniqueFiles.map((filePath) => [filePath, filesByPath[filePath].sha]));

    return NextResponse.json({
      schema: SETTING_DEFS,
      values,
      files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load platform settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await req.json()) as {
      changes?: PlatformEditorChange[];
      commitMessage?: string;
    };

    if (!Array.isArray(body.changes) || body.changes.length === 0) {
      return NextResponse.json({ error: "No changes provided" }, { status: 400 });
    }

    const normalizedChangeMap = new Map<string, { definition: SettingDefinition; value: number | string }>();

    for (const change of body.changes) {
      const definition = getSettingDefinition(change.key);
      if (!definition) {
        return NextResponse.json({ error: `Unknown setting: ${change.key}` }, { status: 400 });
      }

      normalizedChangeMap.set(change.key, {
        definition,
        value: normalizeSettingValue(definition, change.value),
      });
    }

    const normalizedChanges = Array.from(normalizedChangeMap.values());
    const changesByFile = normalizedChanges.reduce<Map<string, { definition: SettingDefinition; value: number | string }[]>>((map, change) => {
      const fileChanges = map.get(change.definition.file) ?? [];
      fileChanges.push(change);
      map.set(change.definition.file, fileChanges);
      return map;
    }, new Map());

    const commitMessage = body.commitMessage?.trim() || buildCommitMessage(normalizedChanges.map((change) => change.definition));

    await Promise.all(
      Array.from(changesByFile.entries()).map(async ([filePath, fileChanges]) => {
        const file = await getFileFromGitHub(filePath);
        const parsed = toRecord(jsYaml.load(decodeGitHubContent(file.content)));

        for (const change of fileChanges) {
          setNestedPath(parsed, change.definition.yamlPath, change.value);
        }

        const nextContent = jsYaml.dump(parsed, { lineWidth: -1, indent: 2 });
        await commitFileToGitHub(filePath, nextContent, file.sha, commitMessage);
      }),
    );

    return NextResponse.json({
      ok: true,
      affectedApps: Array.from(new Set(normalizedChanges.map((change) => change.definition.argoApp))),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save platform settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
