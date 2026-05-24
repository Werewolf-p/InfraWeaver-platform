import { Hono } from "hono";
import { hasPermission } from "../lib/rbac.js";
import { onedevGetFile, onedevPutFile } from "../lib/git-provider.js";
import { getCoreApiForCluster } from "../lib/k8s-client.js";
import type { AppBindings } from "../types/index.js";

/**
 * Platform update routes — all logic runs in the API, no init-VM proxy.
 *
 * GET  /api/v1/platform/version         — compare APP_VERSION vs latest GitHub release
 * POST /api/v1/platform/update          — rewrite ghcr.io image tags in Onedev manifests
 *                                         then hard-refresh ArgoCD (cluster:admin)
 * POST /api/v1/platform/trigger-ci      — dispatch GitHub Actions release workflow (cluster:admin)
 * GET  /api/v1/platform/workflow/:runId — poll a GitHub Actions run status
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_REPO = (process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform")
  .replace(/^https?:\/\/github\.com\//, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

// The current version of THIS running pod — injected as APP_VERSION env at build time.
// Format: "v1.2.3" (GitHub release) or "main-abc1234" (internal SHA-based tag).
const APP_VERSION = process.env.APP_VERSION ?? "unknown";

const ARGOCD_SERVER = (process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80")
  .replace(/\/$/, "");
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

// ghcr.io org derived from GitHub repo owner
const GHCR_ORG = GITHUB_REPO.split("/")[0]?.toLowerCase() ?? "werewolf-p";

// Mapping of app name → deployment manifest path in the repo
const DEPLOYMENT_MANIFESTS: Record<string, string> = {
  "infraweaver-api":     "kubernetes/catalog/infraweaver-api/manifests/deployment.yaml",
  "infraweaver-console": "kubernetes/catalog/infraweaver-console/manifests/deployment.yaml",
  "infraweaver-node":    "kubernetes/catalog/infraweaver-node/manifests/deployment.yaml",
};

// ArgoCD application names for platform components
const ARGOCD_APPS = [
  "catalog-infraweaver-api-manifests",
  "catalog-infraweaver-console-manifests",
  "catalog-infraweaver-node-manifests",
] as const;

// Namespaces where platform pods run — need ghcr-pull-secret after image migration to ghcr.io
const PLATFORM_NAMESPACES = ["infraweaver-console", "infraweaver-system"] as const;

// ── GitHub API ────────────────────────────────────────────────────────────────

function ghHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...ghHeaders(false), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface GHRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

interface GHCommit {
  sha: string;
  commit: { message: string; author: { date: string; name: string } };
}

interface GHWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_commit?: { message: string };
}

async function getLatestRelease(): Promise<GHRelease | null> {
  try {
    return await ghFetch<GHRelease>(`/repos/${GITHUB_REPO}/releases/latest`);
  } catch {
    return null;
  }
}

async function getLatestCommit(): Promise<GHCommit | null> {
  try {
    const commits = await ghFetch<GHCommit[]>(`/repos/${GITHUB_REPO}/commits?sha=main&per_page=1`);
    return commits[0] ?? null;
  } catch {
    return null;
  }
}

async function getChangelogSince(since: string): Promise<string[]> {
  try {
    // Try release-based changelog first
    const releases = await ghFetch<GHRelease[]>(`/repos/${GITHUB_REPO}/releases?per_page=10`);
    const newerReleases = releases.filter((r) => r.tag_name !== since);
    if (newerReleases.length > 0) {
      return newerReleases
        .slice(0, 5)
        .map((r) => `${r.tag_name}: ${r.name || r.body?.split("\n")[0] || "(no description)"}`);
    }
    // Fall back to recent commits
    const commits = await ghFetch<GHCommit[]>(
      `/repos/${GITHUB_REPO}/commits?sha=main&per_page=15`,
    );
    return commits.map((c) => `${c.sha.slice(0, 8)} ${c.commit.message.split("\n")[0]}`);
  } catch {
    return [];
  }
}

// ── ArgoCD helpers ────────────────────────────────────────────────────────────

async function argocdHardRefresh(appName: string): Promise<boolean> {
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${appName}?refresh=hard`, {
      headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Manifest image-tag rewriting ──────────────────────────────────────────────

function rewriteImageTag(yaml: string, appName: string, newTag: string): string | null {
  // Matches: "image: <any-registry>/<any-path>/infraweaver-{app}:<old-tag>"
  const re = new RegExp(
    `(\\bimage:\\s*)[^\\s]*/${appName}:[^\\s]+`,
    "gm",
  );
  if (!re.test(yaml)) return null;
  const updated = yaml.replace(
    new RegExp(`(\\bimage:\\s*)[^\\s]*/${appName}:[^\\s]+`, "gm"),
    `$1ghcr.io/${GHCR_ORG}/infraweaver-${appName}:${newTag}`,
  );
  // Also update APP_VERSION env var if present
  return updated.replace(
    /(name:\s*APP_VERSION\s*\n\s*value:\s*")[^"]+(")/m,
    `$1${newTag}$2`,
  );
}


// ── ghcr.io pull secret ───────────────────────────────────────────────────────

/**
 * Creates or updates "ghcr-pull-secret" in all platform namespaces so pods can
 * pull from ghcr.io/werewolf-p/... after an image-tag update.
 * No-ops if GITHUB_TOKEN is not set (packages may be public).
 */
async function ensureGhcrPullSecret(): Promise<void> {
  if (!GITHUB_TOKEN) return;
  const dockerCfg = JSON.stringify({
    auths: {
      "ghcr.io": {
        username: GHCR_ORG,
        password: GITHUB_TOKEN,
        auth: Buffer.from(`${GHCR_ORG}:${GITHUB_TOKEN}`).toString("base64"),
      },
    },
  });
  const encodedCfg = Buffer.from(dockerCfg).toString("base64");

  // Use local in-cluster service account (the API always targets its own cluster)
  const coreApi = await getCoreApiForCluster("local").catch(() => null);
  if (!coreApi) return;

  for (const ns of PLATFORM_NAMESPACES) {
    const body = {
      apiVersion: "v1" as const,
      kind: "Secret" as const,
      metadata: { name: "ghcr-pull-secret", namespace: ns },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": encodedCfg },
    };
    try {
      await coreApi.createNamespacedSecret({ namespace: ns, body });
    } catch (e: unknown) {
      const code =
        (e as { statusCode?: number })?.statusCode ??
        (e as { response?: { statusCode?: number } })?.response?.statusCode;
      if (code === 409) {
        // Secret already exists — replace with updated credentials
        try {
          await coreApi.replaceNamespacedSecret({
            name: "ghcr-pull-secret",
            namespace: ns,
            body: {
              ...body,
              metadata: { name: "ghcr-pull-secret", namespace: ns },
            },
          });
        } catch { /* ignore replace errors */ }
      }
      // Other errors: log and continue — pull secret is best-effort
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const route = new Hono<AppBindings>();

// GET /version
route.get("/version", async (c) => {
  try {
    const [release, latestCommit] = await Promise.all([
      getLatestRelease(),
      getLatestCommit(),
    ]);

    const latestVersion = release?.tag_name ?? null;
    const latestCommitSha = latestCommit?.sha?.slice(0, 8) ?? null;

    // Determine if an update is available
    const updateAvailable = latestVersion != null && latestVersion !== APP_VERSION;

    const changelog = updateAvailable ? await getChangelogSince(APP_VERSION) : [];

    return c.json({
      ok: true,
      currentVersion: APP_VERSION,
      latestVersion,
      latestCommitSha,
      latestRelease: release
        ? {
            tag: release.tag_name,
            name: release.name,
            publishedAt: release.published_at,
            url: release.html_url,
          }
        : null,
      updateAvailable,
      changelog,
      githubRepo: `https://github.com/${GITHUB_REPO}`,
      hasGithubToken: Boolean(GITHUB_TOKEN),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Version check failed: ${msg}` }, 502);
  }
});

// POST /update — rewrite image tags in Onedev manifests → ArgoCD hard-refresh
route.post("/update", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "cluster:admin")) {
    return c.json({ ok: false, error: "Forbidden: requires cluster:admin" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as { version?: string };

  // Determine target version
  let targetVersion = body.version as string | undefined;
  if (!targetVersion) {
    const release = await getLatestRelease();
    if (!release) {
      return c.json({
        ok: false,
        error: "No GitHub release found. Push a v* tag to create one, or specify a version explicitly.",
      }, 422);
    }
    targetVersion = release.tag_name;
  }

  if (targetVersion === APP_VERSION) {
    return c.json({ ok: false, error: "Already on this version" }, 409);
  }

  const results: Record<string, { ok: boolean; error?: string }> = {};
  const manifestErrors: string[] = [];

  // Update each deployment manifest in Onedev
  for (const [appName, filePath] of Object.entries(DEPLOYMENT_MANIFESTS)) {
    try {
      const file = await onedevGetFile(filePath);
      if (!file) {
        results[appName] = { ok: false, error: "Manifest file not found" };
        manifestErrors.push(`${appName}: manifest not found`);
        continue;
      }

      const updated = rewriteImageTag(file.content, appName, targetVersion);
      if (!updated) {
        results[appName] = { ok: false, error: "Image tag pattern not found in manifest" };
        manifestErrors.push(`${appName}: image pattern not matched`);
        continue;
      }

      if (updated === file.content) {
        results[appName] = { ok: true };
        continue; // already at this version
      }

      await onedevPutFile(
        filePath,
        updated,
        `ci: update infraweaver-${appName} to ${targetVersion}`,
      );
      results[appName] = { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[appName] = { ok: false, error: msg };
      manifestErrors.push(`${appName}: ${msg}`);
    }
  }

  // Create/update ghcr-pull-secret in platform namespaces (required when migrating from onedev to ghcr.io images)
  await ensureGhcrPullSecret();

  // Hard-refresh all platform ArgoCD apps (fire-and-forget the results)
  const refreshResults = await Promise.allSettled(
    ARGOCD_APPS.map((app) => argocdHardRefresh(app)),
  );
  const refreshed = refreshResults.filter((r) => r.status === "fulfilled" && r.value).length;

  const allOk = manifestErrors.length === 0;
  return c.json({
    ok: allOk,
    targetVersion,
    manifests: results,
    argocdRefreshed: refreshed,
    argocdApps: ARGOCD_APPS,
    ...(manifestErrors.length > 0 && { errors: manifestErrors }),
    message: allOk
      ? `Updated manifests to ${targetVersion}. ArgoCD is deploying (${refreshed}/${ARGOCD_APPS.length} apps refreshed).`
      : `Partial update: ${manifestErrors.length} manifest(s) failed.`,
  }, allOk ? 200 : 207);
});

// POST /trigger-ci — dispatch GitHub Actions release workflow
route.post("/trigger-ci", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "cluster:admin")) {
    return c.json({ ok: false, error: "Forbidden: requires cluster:admin" }, 403);
  }
  if (!GITHUB_TOKEN) {
    return c.json({
      ok: false,
      error: "GITHUB_TOKEN is not configured. Set github-token in the infraweaver-console-secret and add GITHUB_TOKEN to the API deployment.",
    }, 422);
  }

  try {
    const body = await c.req.json().catch(() => ({})) as { ref?: string; tag?: string };
    const ref = body.ref ?? "main";

    await ghFetch(`/repos/${GITHUB_REPO}/actions/workflows/release.yml/dispatches`, {
      method: "POST",
      headers: ghHeaders(true),
      body: JSON.stringify({ ref, inputs: { reason: "manual trigger via InfraWeaver console" } }),
    });

    // Get the run that was just created (give it a moment to register)
    await new Promise((r) => setTimeout(r, 2000));
    const runs = await ghFetch<{ workflow_runs: GHWorkflowRun[] }>(
      `/repos/${GITHUB_REPO}/actions/workflows/release.yml/runs?per_page=1`,
    );
    const run = runs.workflow_runs[0];

    return c.json({
      ok: true,
      message: "GitHub Actions workflow dispatched",
      runId: run?.id,
      runUrl: run?.html_url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to trigger CI: ${msg}` }, 502);
  }
});

// GET /workflow/:runId — poll a GitHub Actions run
route.get("/workflow/:runId", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "cluster:admin")) {
    return c.json({ ok: false, error: "Forbidden" }, 403);
  }
  if (!GITHUB_TOKEN) {
    return c.json({ ok: false, error: "GITHUB_TOKEN not configured" }, 422);
  }

  const runId = c.req.param("runId");
  if (!/^\d+$/.test(runId)) {
    return c.json({ ok: false, error: "Invalid run ID" }, 400);
  }

  try {
    const run = await ghFetch<GHWorkflowRun>(
      `/repos/${GITHUB_REPO}/actions/runs/${runId}`,
    );
    return c.json({
      ok: true,
      runId: run.id,
      status: run.status,         // queued | in_progress | completed
      conclusion: run.conclusion, // success | failure | cancelled | null (pending)
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      commitMessage: run.head_commit?.message?.split("\n")[0],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 502);
  }
});

export { route as platformRoute };
