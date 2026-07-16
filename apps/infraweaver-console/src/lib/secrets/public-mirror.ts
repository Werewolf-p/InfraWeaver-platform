import "server-only";

/**
 * Public-mirror (`sync-to-public`) status — SERVER ONLY.
 *
 * The GitHub Actions workflow that mirrors the private GitOps repo to the public
 * OSS template fails silently (see memory). This surfaces its latest run via the
 * same Actions API pattern as `/api/pipelines`, and can dispatch it on demand.
 */

import { getGitAccessToken } from "@/lib/git-provider";
import type { PublicMirrorStatus } from "@/lib/secrets/lifecycle-types";

const GITHUB_API_URL = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const SYNC_WORKFLOW_FILE = process.env.PUBLIC_SYNC_WORKFLOW ?? "sync-to-public.yml";
const REQUEST_TIMEOUT_MS = 5000;

function githubHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getGitAccessToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "infraweaver-console",
  };
}

/** Match the sync workflow by its file path (`.github/workflows/<file>`) or name. */
function isSyncWorkflow(wf: { path?: string; name?: string }): boolean {
  const path = (wf.path ?? "").toLowerCase();
  const name = (wf.name ?? "").toLowerCase();
  return path.endsWith(`/${SYNC_WORKFLOW_FILE.toLowerCase()}`) || name.includes("sync-to-public") || name.includes("sync to public");
}

/**
 * Latest `sync-to-public` run. Degrades to `available:false` (never throws) when
 * GitHub is unreachable or the repo/token is unset.
 */
export async function getPublicMirrorStatus(): Promise<PublicMirrorStatus> {
  const unavailable = (error: string): PublicMirrorStatus => ({
    available: false,
    workflowName: null,
    status: null,
    conclusion: null,
    updatedAt: null,
    htmlUrl: null,
    error,
  });

  if (!GITHUB_REPO) return unavailable("GITHUB_REPO not configured");
  if (!getGitAccessToken()) return unavailable("git token not configured");

  try {
    const wfRes = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}/actions/workflows`, {
      headers: githubHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!wfRes.ok) return unavailable(`workflows: ${wfRes.status}`);
    const { workflows } = (await wfRes.json()) as { workflows: Array<{ id: number; name: string; path: string }> };
    const syncWf = workflows.find(isSyncWorkflow);
    if (!syncWf) return unavailable("sync-to-public workflow not found");

    const runsRes = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPO}/actions/workflows/${syncWf.id}/runs?per_page=1`,
      { headers: githubHeaders(), cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!runsRes.ok) return unavailable(`runs: ${runsRes.status}`);
    const { workflow_runs } = (await runsRes.json()) as {
      workflow_runs: Array<{ status: string; conclusion: string | null; updated_at: string; html_url: string }>;
    };
    const latest = workflow_runs[0];
    return {
      available: true,
      workflowName: syncWf.name,
      status: latest?.status ?? null,
      conclusion: latest?.conclusion ?? null,
      updatedAt: latest?.updated_at ?? null,
      htmlUrl: latest?.html_url ?? null,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return unavailable("GitHub request timed out");
    return unavailable(err instanceof Error ? err.message : "GitHub unreachable");
  }
}

/** Dispatch the sync workflow (`workflow_dispatch`). Throws on failure so the route can 502. */
export async function triggerPublicSync(ref = "main"): Promise<void> {
  if (!GITHUB_REPO) throw new Error("GITHUB_REPO not configured");
  const wfRes = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}/actions/workflows`, {
    headers: githubHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!wfRes.ok) throw new Error(`workflows lookup failed: ${wfRes.status}`);
  const { workflows } = (await wfRes.json()) as { workflows: Array<{ id: number; name: string; path: string }> };
  const syncWf = workflows.find(isSyncWorkflow);
  if (!syncWf) throw new Error("sync-to-public workflow not found");

  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}/actions/workflows/${syncWf.id}/dispatches`, {
    method: "POST",
    headers: { ...githubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`dispatch failed: ${res.status} — ${await res.text()}`);
}
