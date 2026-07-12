import { createGithubContentsClient, type GithubContentsClient } from "@/lib/github-contents-client";
import { errorMessage } from "@/lib/utils";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITHUB_REPO = "your-org/your-repo";
const COMMIT_AUTHOR = { name: "InfraWeaver Console", email: "console@infraweaver.internal" };

export type GitProviderName = "github" | "onedev";

export interface GitFileResult {
  content: string;
  sha: string;
}

export interface GitTreeEntry {
  path: string;
  type: "file" | "dir";
  sha?: string;
}

export interface GitCommitFile {
  path: string;
  content: string;
}

export interface GitCommitOptions {
  message: string;
  addOrUpdateFiles?: GitCommitFile[];
  deleteFiles?: string[];
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\/+/, "").replace(/\\/g, "/");
}

export function getGitProviderName(): GitProviderName {
  return (process.env.GIT_PROVIDER ?? "github").toLowerCase() === "onedev" ? "onedev" : "github";
}

export function getGitAccessToken(): string {
  return getGitProviderName() === "onedev"
    ? (process.env.ONEDEV_TOKEN ?? "")
    : (process.env.GITHUB_TOKEN ?? "");
}

/**
 * Repository this module reads and writes.
 *
 * `GITHUB_REPO` is overloaded: it also names the repo whose GitHub Actions the
 * console dispatches (`/api/pipelines`, node settings) and whose wiki it renders
 * — that is the *platform* repo. The GitOps manifests ArgoCD syncs live in the
 * *infra* repo. Where those differ, every commit this module made (catalog
 * installs, NAS mounts, users.yaml) landed in a repo no Application watches, so
 * the change was recorded and never applied.
 *
 * `GITOPS_REPO` names the repo ArgoCD actually syncs. It falls back to
 * `GITHUB_REPO`, so a single-repo deployment is unaffected.
 */
function getGitOpsRepo(): string {
  return process.env.GITOPS_REPO ?? process.env.GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
}

function getGitHubConfig() {
  const apiUrl = (process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
  const repo = getGitOpsRepo();
  const token = process.env.GITHUB_TOKEN ?? "";
  return {
    apiUrl,
    repo,
    token,
    repoApi: `${apiUrl}/repos/${repo}`,
  };
}

// Built per call so env changes (tests, hot config) are always honored, exactly
// like the previous per-call getGitHubConfig() reads.
function client(): GithubContentsClient {
  const { apiUrl, repo, token } = getGitHubConfig();
  return createGithubContentsClient({ apiUrl, repo, token, committer: COMMIT_AUTHOR });
}

export async function getGitRepoUrl(): Promise<string> {
  return `https://github.com/${getGitOpsRepo()}.git`;
}

function githubHeaders(token: string, includeJson = false): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "infraweaver-console",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

// The contents client has no delete operation, so DELETE stays hand-rolled here.
async function githubDeleteFile(filePath: string, message: string, sha?: string): Promise<void> {
  const { repoApi, token } = getGitHubConfig();
  const normalizedPath = normalizePath(filePath);
  const resolvedSha = sha ?? (await client().readFile(normalizedPath))?.sha;
  if (!resolvedSha) return;
  const response = await fetch(`${repoApi}/contents/${normalizedPath}`, {
    method: "DELETE",
    headers: githubHeaders(token, true),
    body: JSON.stringify({
      message,
      sha: resolvedSha,
      committer: COMMIT_AUTHOR,
    }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub DELETE ${normalizedPath}: ${response.status} — ${await response.text()}`);
  }
}

export async function gitReadFile(filePath: string, revalidateSeconds = 0): Promise<GitFileResult | null> {
  return client().readFile(filePath, revalidateSeconds);
}

export async function gitListDir(dirPath: string): Promise<GitTreeEntry[]> {
  return client().listDir(dirPath);
}

export async function gitWriteFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
  await client().writeFile(filePath, content, message, sha);
}

export async function gitDeleteFile(filePath: string, message: string, sha?: string): Promise<void> {
  await githubDeleteFile(filePath, message, sha);
}

export async function gitCommitFiles({ message, addOrUpdateFiles = [], deleteFiles = [] }: GitCommitOptions): Promise<void> {
  const repoClient = client();
  for (const entry of addOrUpdateFiles) {
    // writeFile resolves the existing blob sha with a read first — the same
    // read-then-put sequence the previous inline implementation performed.
    await repoClient.writeFile(entry.path, entry.content, message);
  }
  for (const filePath of deleteFiles) {
    await githubDeleteFile(filePath, message);
  }
}

export async function gitDeleteDir(dirPath: string, message: string): Promise<{ deleted: string[]; errors: string[] }> {
  // Collect all file paths first, then delete in one commit batch.
  const allFiles: string[] = [];
  const collect = async (dir: string) => {
    const entries = await gitListDir(dir);
    for (const entry of entries) {
      if (entry.type === "file") allFiles.push(entry.path);
      else await collect(entry.path);
    }
  };
  await collect(dirPath);

  if (allFiles.length === 0) return { deleted: [], errors: [] };

  try {
    await gitCommitFiles({ message, deleteFiles: allFiles });
    return { deleted: allFiles, errors: [] };
  } catch (error) {
    return { deleted: [], errors: [errorMessage(error)] };
  }
}
