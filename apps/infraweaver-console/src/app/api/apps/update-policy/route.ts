// Disable TLS verification for in-cluster k8s API calls
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";

// ── Types ──────────────────────────────────────────────────────────────────────

export type UpdateSchedule = "continuous" | "daily" | "weekly" | "monthly" | "manual";
export type UpdateStrategy = "semver-patch" | "semver-minor" | "semver-major" | "digest" | "newest-build";
export type DeploymentStrategy = "rolling" | "recreate";

export interface UpdatePolicy {
  enabled: boolean;
  schedule: UpdateSchedule;
  strategy: UpdateStrategy;
  deploymentStrategy: DeploymentStrategy;
  includePreRelease: boolean;
  minimumAge: "none" | "7d" | "14d" | "30d";
  autoMerge: boolean;
  imageRef?: string;
  imageConstraint?: string;
}

// ── Zod schema ─────────────────────────────────────────────────────────────────

const UpdatePolicySchema = z.object({
  enabled: z.boolean(),
  schedule: z.enum(["continuous", "daily", "weekly", "monthly", "manual"]),
  strategy: z.enum(["semver-patch", "semver-minor", "semver-major", "digest", "newest-build"]),
  deploymentStrategy: z.enum(["rolling", "recreate"]),
  includePreRelease: z.boolean(),
  minimumAge: z.enum(["none", "7d", "14d", "30d"]),
  autoMerge: z.boolean(),
  imageRef: z.string().optional(),
  imageConstraint: z.string().optional(),
});

const PutBodySchema = z.object({
  appName: z.string().min(1).max(64),
  policy: UpdatePolicySchema,
});

// ── Env ───────────────────────────────────────────────────────────────────────

const K8S_HOST = "https://kubernetes.default.svc";
const SA_TOKEN = process.env.CONSOLE_SA_TOKEN ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

// ── k8s helpers ───────────────────────────────────────────────────────────────

function k8sReq(path: string, opts?: RequestInit) {
  return fetch(`${K8S_HOST}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${SA_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts?.headers ?? {}),
    },
  });
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function githubGet(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json() as Promise<{ content: string; sha: string }>;
}

async function githubPut(path: string, content: string, message: string, sha?: string) {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
  };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Schedule / strategy mappings ──────────────────────────────────────────────

const SCHEDULE_TO_CRON: Record<string, string[]> = {
  daily: ["* 0-3 * * *"],
  weekly: ["* 0-3 * * 1"],
  monthly: ["* 0-3 1 * *"],
};

function strategyToMatchUpdateTypes(strategy: UpdateStrategy): string[] | null {
  switch (strategy) {
    case "semver-patch": return ["patch"];
    case "semver-minor": return ["minor", "patch"];
    case "semver-major": return ["major", "minor", "patch"];
    case "digest": return ["digest"];
    default: return null;
  }
}

// ── ACIU CR builder ───────────────────────────────────────────────────────────

function buildACIUCR(slug: string, policy: UpdatePolicy): Record<string, unknown> {
  const image = policy.imageRef ?? "";
  let updateStrategy: string;
  switch (policy.strategy) {
    case "digest": updateStrategy = "digest"; break;
    case "newest-build": updateStrategy = "newest-build"; break;
    default: updateStrategy = "semver";
  }

  return {
    apiVersion: "argocd-image-updater.argoproj.io/v1alpha1",
    kind: "ImageUpdater",
    metadata: {
      name: `${slug}-image-updater`,
      namespace: "argocd",
      annotations: {
        "infraweaver.io/managed-by": "infraweaver-console",
        "infraweaver.io/policy": JSON.stringify(policy),
      },
    },
    spec: {
      writeBackConfig: {
        method: "git",
        gitConfig: { branch: "main" },
      },
      applicationRefs: [
        {
          namePattern: `catalog-${slug}-manifests`,
          images: [
            {
              alias: "app",
              imageName: image,
              commonUpdateSettings: {
                updateStrategy,
                ignoreTags: ["latest", "dev", "nightly", "main", "edge"],
              },
            },
          ],
        },
      ],
    },
  };
}

// ── Renovate packageRule builder ──────────────────────────────────────────────

interface RenovatePackageRule {
  description: string;
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
  schedule?: string[];
  automerge?: boolean;
  automergeStrategy?: string;
  ignorePrerelease?: boolean;
  minimumReleaseAge?: string;
  pinDigests?: boolean;
}

function buildRenovateRule(slug: string, policy: UpdatePolicy): RenovatePackageRule {
  const rule: RenovatePackageRule = {
    description: `infraweaver-managed: ${slug}`,
    matchPackageNames: policy.imageRef ? [policy.imageRef] : [],
    automerge: policy.schedule === "manual" ? false : policy.autoMerge,
    automergeStrategy: "squash",
    ignorePrerelease: !policy.includePreRelease,
  };

  if (policy.schedule !== "manual") {
    const cron = SCHEDULE_TO_CRON[policy.schedule];
    if (cron) rule.schedule = cron;
  }

  if (policy.strategy === "digest") {
    rule.pinDigests = true;
    rule.matchUpdateTypes = ["digest"];
  } else {
    const types = strategyToMatchUpdateTypes(policy.strategy);
    if (types) rule.matchUpdateTypes = types;
  }

  if (policy.minimumAge !== "none") {
    rule.minimumReleaseAge = policy.minimumAge;
  }

  return rule;
}

// ── k8s ACIU CR operations ────────────────────────────────────────────────────

async function getACIUCR(slug: string): Promise<{ found: boolean; resource?: Record<string, unknown> }> {
  const res = await k8sReq(
    `/apis/argocd-image-updater.argoproj.io/v1alpha1/namespaces/argocd/imageupdaters/${slug}-image-updater`
  );
  if (res.status === 404) return { found: false };
  if (!res.ok) return { found: false };
  const data = await res.json() as Record<string, unknown>;
  return { found: true, resource: data };
}

async function applyACIUCR(slug: string, cr: Record<string, unknown>): Promise<void> {
  const { found } = await getACIUCR(slug);
  const path = `/apis/argocd-image-updater.argoproj.io/v1alpha1/namespaces/argocd/imageupdaters/${slug}-image-updater`;

  if (found) {
    // Get current resourceVersion for update
    const existing = await k8sReq(path);
    if (existing.ok) {
      const existingData = await existing.json() as { metadata?: { resourceVersion?: string } };
      const resourceVersion = existingData.metadata?.resourceVersion;
      if (resourceVersion) {
        (cr as { metadata: Record<string, unknown> }).metadata.resourceVersion = resourceVersion;
      }
    }
    const res = await k8sReq(path, { method: "PUT", body: JSON.stringify(cr) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`k8s PUT ImageUpdater failed: ${res.status} ${text}`);
    }
  } else {
    const res = await k8sReq(
      `/apis/argocd-image-updater.argoproj.io/v1alpha1/namespaces/argocd/imageupdaters`,
      { method: "POST", body: JSON.stringify(cr) }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`k8s POST ImageUpdater failed: ${res.status} ${text}`);
    }
  }
}

async function deleteACIUCR(slug: string): Promise<void> {
  const { found } = await getACIUCR(slug);
  if (!found) return;
  const res = await k8sReq(
    `/apis/argocd-image-updater.argoproj.io/v1alpha1/namespaces/argocd/imageupdaters/${slug}-image-updater`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`k8s DELETE ImageUpdater failed: ${res.status} ${text}`);
  }
}

// ── Image auto-detection ──────────────────────────────────────────────────────

async function detectImage(slug: string): Promise<string | undefined> {
  const res = await k8sReq(
    `/apis/apps/v1/namespaces/${slug}/deployments`
  );
  if (!res.ok) return undefined;
  const data = await res.json() as {
    items?: Array<{
      spec?: {
        template?: {
          spec?: {
            containers?: Array<{ image?: string }>;
          };
        };
      };
    }>;
  };
  const image = data.items?.[0]?.spec?.template?.spec?.containers?.[0]?.image;
  if (!image) return undefined;
  // Strip tag to get base image ref
  const colonIdx = image.lastIndexOf(":");
  if (colonIdx > -1 && !image.substring(colonIdx).includes("/")) {
    return image.substring(0, colonIdx);
  }
  return image;
}

// ── Renovate operations ───────────────────────────────────────────────────────

interface RenovateConfig {
  packageRules?: RenovatePackageRule[];
  [key: string]: unknown;
}

async function getRenovateConfig(): Promise<{ config: RenovateConfig; sha: string } | null> {
  const file = await githubGet("renovate.json");
  if (!file) return null;
  const content = Buffer.from(file.content, "base64").toString("utf-8");
  try {
    const config = JSON.parse(content) as RenovateConfig;
    return { config, sha: file.sha };
  } catch {
    return null;
  }
}

async function updateRenovateRule(slug: string, rule: RenovatePackageRule | null): Promise<void> {
  const result = await getRenovateConfig();
  if (!result) {
    if (rule === null) return; // nothing to remove
    throw new Error("renovate.json not found in repository");
  }

  const { config, sha } = result;
  const rules = config.packageRules ?? [];
  const matchDesc = `infraweaver-managed: ${slug}`;
  const filtered = rules.filter(r => r.description !== matchDesc);

  if (rule !== null) {
    filtered.push(rule);
  }

  config.packageRules = filtered;
  const newContent = JSON.stringify(config, null, 2) + "\n";
  await githubPut(
    "renovate.json",
    newContent,
    rule
      ? `chore: update auto-update policy for ${slug} via InfraWeaver Console`
      : `chore: remove auto-update policy for ${slug} via InfraWeaver Console`,
    sha
  );
}

// ── Policy reading from ACIU CR ───────────────────────────────────────────────

function parsePolicyFromACIU(cr: Record<string, unknown>): Partial<UpdatePolicy> {
  const metadata = cr.metadata as { annotations?: Record<string, string> } | undefined;
  const annotation = metadata?.annotations?.["infraweaver.io/policy"];
  if (annotation) {
    try {
      return JSON.parse(annotation) as Partial<UpdatePolicy>;
    } catch { /* ignore */ }
  }
  return { enabled: true, schedule: "continuous" };
}

function parsePolicyFromRenovateRule(rule: RenovatePackageRule): Partial<UpdatePolicy> {
  let schedule: UpdateSchedule = "manual";
  if (rule.schedule) {
    const sched = rule.schedule[0];
    if (sched === "* 0-3 * * *") schedule = "daily";
    else if (sched === "* 0-3 * * 1") schedule = "weekly";
    else if (sched === "* 0-3 1 * *") schedule = "monthly";
  }

  let strategy: UpdateStrategy = "semver-minor";
  if (rule.pinDigests) strategy = "digest";
  else if (rule.matchUpdateTypes?.includes("major")) strategy = "semver-major";
  else if (rule.matchUpdateTypes?.includes("minor")) strategy = "semver-minor";
  else if (rule.matchUpdateTypes?.includes("patch") && !rule.matchUpdateTypes.includes("minor")) strategy = "semver-patch";

  return {
    enabled: true,
    schedule,
    strategy,
    autoMerge: rule.automerge ?? false,
    includePreRelease: rule.ignorePrerelease === false,
    minimumAge: (rule.minimumReleaseAge as UpdatePolicy["minimumAge"]) ?? "none",
    imageRef: rule.matchPackageNames?.[0],
  };
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const slug = req.nextUrl.searchParams.get("app");
  if (!slug) return NextResponse.json({ error: "Missing app param" }, { status: 400 });

  const defaultPolicy: UpdatePolicy = {
    enabled: false,
    schedule: "weekly",
    strategy: "semver-minor",
    deploymentStrategy: "rolling",
    includePreRelease: false,
    minimumAge: "7d",
    autoMerge: true,
    imageRef: undefined,
    imageConstraint: undefined,
  };

  let imageRef: string | undefined;
  let policyFromAciu: Partial<UpdatePolicy> | null = null;
  let policyFromRenovate: Partial<UpdatePolicy> | null = null;

  // 1. Check ACIU CR
  const { found: acuFound, resource: acuResource } = await getACIUCR(slug);
  if (acuFound && acuResource) {
    policyFromAciu = parsePolicyFromACIU(acuResource);
    const appRefs = (acuResource.spec as { applicationRefs?: Array<{ images?: Array<{ imageName?: string }> }> })
      ?.applicationRefs;
    imageRef = appRefs?.[0]?.images?.[0]?.imageName ?? policyFromAciu.imageRef;
  }

  // 2. Check renovate.json
  if (!policyFromAciu) {
    const renovateResult = await getRenovateConfig();
    if (renovateResult) {
      const matchDesc = `infraweaver-managed: ${slug}`;
      const rule = renovateResult.config.packageRules?.find(r => r.description === matchDesc);
      if (rule) {
        policyFromRenovate = parsePolicyFromRenovateRule(rule);
        imageRef = imageRef ?? rule.matchPackageNames?.[0];
      }
    }
  }

  // 3. Auto-detect image
  if (!imageRef) {
    imageRef = await detectImage(slug);
  }

  const mergedPolicy: UpdatePolicy = {
    ...defaultPolicy,
    ...(policyFromAciu ?? policyFromRenovate ?? {}),
    imageRef,
  };

  return NextResponse.json({
    policy: mergedPolicy,
    source: policyFromAciu ? "aciu" : policyFromRenovate ? "renovate" : "none",
    imageDetected: !!imageRef,
  });
}

// ── PUT handler ───────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("update-policy", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { appName: slug, policy } = parsed.data;

  // Detect image if not provided
  let imageRef = policy.imageRef;
  let imageDetected = !!imageRef;
  if (!imageRef) {
    imageRef = await detectImage(slug);
    imageDetected = !!imageRef;
    if (imageRef) policy.imageRef = imageRef;
  }

  try {
    if (!policy.enabled) {
      // Disable: remove both ACIU CR and Renovate rule
      await deleteACIUCR(slug);
      await updateRenovateRule(slug, null);
      return NextResponse.json({ ok: true, message: "Auto-update policy disabled" });
    }

    if (policy.schedule === "continuous") {
      // ACIU path
      const cr = buildACIUCR(slug, policy);
      await applyACIUCR(slug, cr);
      await updateRenovateRule(slug, null);
      return NextResponse.json({
        ok: true,
        message: "Continuous update policy applied via ACIU",
        imageDetected,
        imageRef: imageRef ?? null,
      });
    }

    // Renovate-managed path (daily/weekly/monthly/manual)
    // newest-build is ACIU only — fall back to ACIU if strategy is newest-build
    if (policy.strategy === "newest-build") {
      const cr = buildACIUCR(slug, policy);
      await applyACIUCR(slug, cr);
      await updateRenovateRule(slug, null);
      return NextResponse.json({
        ok: true,
        message: "Newest-build update policy applied via ACIU",
        imageDetected,
        imageRef: imageRef ?? null,
      });
    }

    await deleteACIUCR(slug);
    const rule = buildRenovateRule(slug, policy);
    await updateRenovateRule(slug, rule);
    return NextResponse.json({
      ok: true,
      message: `Scheduled update policy (${policy.schedule}) applied via Renovate`,
      imageDetected,
      imageRef: imageRef ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
