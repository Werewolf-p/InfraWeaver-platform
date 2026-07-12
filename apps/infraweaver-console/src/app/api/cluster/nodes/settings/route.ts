import { NextRequest, NextResponse } from "next/server";
import * as jsYaml from "js-yaml";
import { withAuth } from "@/lib/with-auth";
import { getGitAccessToken } from "@/lib/git-provider";
import { readInfraRepoFile, writeInfraRepoFile } from "@/lib/infra-repo";
import { safeError } from "@/lib/utils";
import { z } from "zod";
import { withRoute } from "@/lib/route-utils";

const NodeChangeSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  cpu: z.number().int().min(1).max(64).optional(),
  memory_mb: z.number().int().min(512).max(131072).optional(),
});
const NodesSettingsPutSchema = z.object({
  changes: z.array(NodeChangeSchema).min(1).max(20),
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface NodeSpec {
  name: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  ip: string;
  vm_id: number;
  proxmox_node: string;
  controlplane: boolean;
}

interface ClusterYaml {
  nodes: Record<
    string,
    {
      cpu?: number;
      memory_mb?: number;
      disk_gb?: number;
      ip?: string;
      vm_id?: number;
      proxmox_node?: string;
      controlplane?: boolean;
      mac_address?: string;
      datastore?: string;
    }
  >;
  [key: string]: unknown;
}

// ── Config ────────────────────────────────────────────────────────────────────

const GIT_TOKEN = getGitAccessToken();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const CLUSTER_YAML_PATH = "envs/productie/cluster.yaml";

// Workflow file that handles the rolling node update via Terraform + kubectl drain/uncordon
const NODE_UPDATE_WORKFLOW = "node-rolling-update.yml";

async function dispatchWorkflow(workflowFile: string, inputs: Record<string, string>) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error("Missing GITHUB_TOKEN/GITHUB_REPO for workflow dispatch");
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  if (!res.ok) {
    // Log the raw GitHub response server-side only; the thrown message flows
    // back to the client via safeError and must stay generic.
    const body = await res.text();
    console.error(`[nodes/settings] workflow dispatch failed: ${res.status} — ${body}`);
    throw new Error(`Workflow dispatch failed (HTTP ${res.status})`);
  }
}

// ── GET — return current node specs ──────────────────────────────────────────

export const GET = withAuth({ permission: "config:read" }, async () => {
  if (!GIT_TOKEN) return NextResponse.json({ error: "Missing git provider token" }, { status: 503 });

  try {
    const file = await readInfraRepoFile(CLUSTER_YAML_PATH);
    if (!file) throw new Error(`Repository file not found: ${CLUSTER_YAML_PATH}`);
    const parsed = jsYaml.load(file.content) as ClusterYaml;

    const nodes: NodeSpec[] = Object.entries(parsed.nodes ?? {}).map(([name, cfg]) => ({
      name,
      cpu: cfg.cpu ?? 0,
      memory_mb: cfg.memory_mb ?? 0,
      disk_gb: cfg.disk_gb ?? 0,
      ip: cfg.ip ?? "",
      vm_id: cfg.vm_id ?? 0,
      proxmox_node: cfg.proxmox_node ?? "",
      controlplane: cfg.controlplane ?? false,
    }));

    // Sort deterministically: cp1, cp2, cp3
    nodes.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ nodes, sha: file.sha });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
});

// ── PUT — commit changes + dispatch rolling-update workflow ───────────────────

export const PUT = withRoute("config:write", async (req: NextRequest) => {
  if (!GIT_TOKEN) return NextResponse.json({ error: "Missing git provider token" }, { status: 503 });
  // Fail fast before committing anything: a commit whose rolling-update workflow
  // can never dispatch would leave cluster.yaml changed but unapplied.
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return NextResponse.json({ error: "Workflow dispatch not configured (GITHUB_TOKEN/GITHUB_REPO)" }, { status: 503 });
  }

  try {
    const parseResult = NodesSettingsPutSchema.safeParse(await req.json().catch(() => null));
    if (!parseResult.success) {
      return NextResponse.json({ error: parseResult.error.flatten() }, { status: 400 });
    }
    const body = parseResult.data;

    // Schema enforces presence/ranges; only the 512 MB alignment needs a manual pass.
    for (const change of body.changes) {
      if (change.memory_mb !== undefined && change.memory_mb % 512 !== 0) {
        return NextResponse.json({ error: `memory_mb for ${change.name} must be a multiple of 512` }, { status: 400 });
      }
    }

    // Read current cluster.yaml
    const file = await readInfraRepoFile(CLUSTER_YAML_PATH);
    if (!file) throw new Error(`Repository file not found: ${CLUSTER_YAML_PATH}`);
    const parsed = jsYaml.load(file.content) as ClusterYaml;

    if (!parsed.nodes) {
      return NextResponse.json({ error: "cluster.yaml has no nodes section" }, { status: 500 });
    }

    // Apply changes
    const changedNodeNames: string[] = [];
    for (const change of body.changes) {
      const nodeCfg = parsed.nodes[change.name];
      if (!nodeCfg) {
        return NextResponse.json({ error: `Node ${change.name} not found in cluster.yaml` }, { status: 400 });
      }
      if (change.cpu !== undefined) nodeCfg.cpu = change.cpu;
      if (change.memory_mb !== undefined) nodeCfg.memory_mb = change.memory_mb;
      changedNodeNames.push(change.name);
    }

    // Commit to git
    const nodesSummary = changedNodeNames.join(", ");
    const commitMsg = `feat(cluster): update node specs for ${nodesSummary} via InfraWeaver Console\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
    const updatedYaml = jsYaml.dump(parsed, { lineWidth: -1, indent: 2 });
    await writeInfraRepoFile(CLUSTER_YAML_PATH, updatedYaml, commitMsg, file.sha);

    // Dispatch the rolling-update workflow
    await dispatchWorkflow(NODE_UPDATE_WORKFLOW, {
      changed_nodes: changedNodeNames.join(","),
      environment: "productie",
      confirm: "yes",
    });

    return NextResponse.json({
      ok: true,
      changedNodes: changedNodeNames,
      workflowDispatched: NODE_UPDATE_WORKFLOW,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
});
