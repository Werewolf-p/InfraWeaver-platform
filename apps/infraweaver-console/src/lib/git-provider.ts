import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITHUB_REPO = "Werewolf-p/InfraWeaver-platform";
const DEFAULT_ONEDEV_URL = "http://onedev.onedev.svc.cluster.local";
const DEFAULT_ONEDEV_BRANCH = "main";
const DEFAULT_GIT_WORKTREE_ROOT = "/git-cache";
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

interface GitHubContentResponse {
  content: string;
  sha: string;
  type?: string;
  path?: string;
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

function getGitHubConfig() {
  const apiUrl = (process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
  const repo = process.env.GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN ?? "";
  return {
    apiUrl,
    repo,
    token,
    repoApi: `${apiUrl}/repos/${repo}`,
  };
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

function getOneDevConfig() {
  const url = (process.env.ONEDEV_URL ?? DEFAULT_ONEDEV_URL).replace(/\/$/, "");
  const token = process.env.ONEDEV_TOKEN ?? "";
  const projectId = process.env.ONEDEV_PROJECT_ID ?? "";
  const projectPath = normalizePath(process.env.ONEDEV_PROJECT_PATH ?? "").replace(/\.git$/, "");
  const branch = process.env.ONEDEV_BRANCH ?? DEFAULT_ONEDEV_BRANCH;
  const username = process.env.ONEDEV_USERNAME ?? "admin";
  const worktreeRoot = process.env.GIT_WORKTREE_ROOT ?? DEFAULT_GIT_WORKTREE_ROOT;
  return { url, token, projectId, projectPath, branch, username, worktreeRoot };
}

function onedevHeaders(username: string, token: string): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  return headers;
}

let cachedOneDevProjectPath: string | null = null;

async function loadIsomorphicGit() {
  const [{ default: http }, git] = await Promise.all([
    import("isomorphic-git/http/node"),
    import("isomorphic-git"),
  ]);
  return { http, git };
}

async function getOneDevProjectPath(): Promise<string> {
  if (cachedOneDevProjectPath) return cachedOneDevProjectPath;
  const { url, token, projectId, projectPath: configuredProjectPath, username } = getOneDevConfig();
  if (configuredProjectPath.trim()) {
    cachedOneDevProjectPath = configuredProjectPath;
    return configuredProjectPath;
  }
  if (!token.trim() || !projectId.trim()) {
    throw new Error("OneDev is not configured. Set ONEDEV_TOKEN and ONEDEV_PROJECT_ID.");
  }
  const response = await fetch(`${url}/~api/projects/${projectId}`, {
    headers: onedevHeaders(username, token),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`OneDev project lookup failed: ${response.status} — ${await response.text()}`);
  }
  const data = await response.json() as { path?: string; name?: string };
  const projectPath = data.path ?? data.name;
  if (!projectPath) throw new Error("OneDev project path is missing");
  cachedOneDevProjectPath = projectPath;
  return projectPath;
}

export async function getGitRepoUrl(): Promise<string> {
  if (getGitProviderName() === "github") {
    const { repo } = getGitHubConfig();
    return `https://github.com/${repo}.git`;
  }
  const { url } = getOneDevConfig();
  const projectPath = await getOneDevProjectPath();
  return `${url}/${projectPath}.git`;
}

async function githubReadFile(filePath: string, revalidateSeconds = 0): Promise<GitFileResult | null> {
  const { repoApi, token } = getGitHubConfig();
  const normalizedPath = normalizePath(filePath);
  const response = await fetch(`${repoApi}/contents/${normalizedPath}`,
    revalidateSeconds > 0
      ? { headers: githubHeaders(token), next: { revalidate: revalidateSeconds } }
      : { headers: githubHeaders(token), cache: "no-store" }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub GET ${normalizedPath}: ${response.status}`);
  const data = await response.json() as GitHubContentResponse;
  return {
    content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8"),
    sha: data.sha,
  };
}

async function githubListDir(dirPath: string): Promise<GitTreeEntry[]> {
  const { repoApi, token } = getGitHubConfig();
  const normalizedPath = normalizePath(dirPath);
  const response = await fetch(`${repoApi}/contents/${normalizedPath}`, {
    headers: githubHeaders(token),
    cache: "no-store",
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`GitHub list ${normalizedPath}: ${response.status}`);
  const data = await response.json() as Array<{ path: string; type: string; sha?: string }>;
  return data.map((entry) => ({
    path: entry.path,
    type: entry.type === "dir" ? "dir" : "file",
    sha: entry.sha,
  }));
}

async function githubWriteFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
  const { repoApi, token } = getGitHubConfig();
  const normalizedPath = normalizePath(filePath);
  const response = await fetch(`${repoApi}/contents/${normalizedPath}`, {
    method: "PUT",
    headers: githubHeaders(token, true),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
      committer: COMMIT_AUTHOR,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub PUT ${normalizedPath}: ${response.status} — ${await response.text()}`);
  }
}

async function githubDeleteFile(filePath: string, message: string, sha?: string): Promise<void> {
  const { repoApi, token } = getGitHubConfig();
  const normalizedPath = normalizePath(filePath);
  const resolvedSha = sha ?? (await githubReadFile(normalizedPath))?.sha;
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

async function githubCommitFiles({ message, addOrUpdateFiles = [], deleteFiles = [] }: GitCommitOptions): Promise<void> {
  for (const entry of addOrUpdateFiles) {
    const existing = await githubReadFile(entry.path);
    await githubWriteFile(entry.path, entry.content, message, existing?.sha);
  }
  for (const filePath of deleteFiles) {
    await githubDeleteFile(filePath, message);
  }
}

function isPushRejection(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /non-fast-forward|fetch first|push rejected|failed to push/i.test(text);
}

async function withOneDevWorktree<T>(worker: (dir: string, gitClient: Awaited<ReturnType<typeof loadIsomorphicGit>>["git"]) => Promise<T>): Promise<T> {
  const { branch, token, username, worktreeRoot } = getOneDevConfig();
  if (!token.trim()) throw new Error("OneDev token is not configured");
  const { git, http } = await loadIsomorphicGit();
  const repoUrl = await getGitRepoUrl();
  const dir = path.join(worktreeRoot, randomUUID());
  await fsPromises.mkdir(dir, { recursive: true });
  try {
    await git.clone({
      fs,
      http,
      dir,
      url: repoUrl,
      singleBranch: true,
      depth: 1,
      ref: branch,
      onAuth: () => ({ username, password: token }),
    });
    return await worker(dir, git);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

async function onedevReadFile(filePath: string): Promise<GitFileResult | null> {
  const normalizedPath = normalizePath(filePath);
  return withOneDevWorktree(async (dir, gitClient) => {
    const fullPath = path.join(dir, normalizedPath);
    try {
      const content = await fsPromises.readFile(fullPath, "utf8");
      const sha = await gitClient.resolveRef({ fs, dir, ref: "HEAD" });
      return { content, sha };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}

async function onedevListDir(dirPath: string): Promise<GitTreeEntry[]> {
  const normalizedPath = normalizePath(dirPath);
  return withOneDevWorktree(async (dir) => {
    const fullPath = path.join(dir, normalizedPath);
    try {
      const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
      return entries.map((entry) => ({
        path: path.posix.join(normalizedPath, entry.name),
        type: entry.isDirectory() ? "dir" : "file",
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
}

async function onedevCommitFiles({ message, addOrUpdateFiles = [], deleteFiles = [] }: GitCommitOptions): Promise<void> {
  const { branch, token, username } = getOneDevConfig();
  const normalizedDeletes = deleteFiles.map(normalizePath);
  const normalizedWrites = addOrUpdateFiles.map((entry) => ({ ...entry, path: normalizePath(entry.path) }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { http } = await loadIsomorphicGit();
      await withOneDevWorktree(async (dir, gitClient) => {
        for (const entry of normalizedWrites) {
          const fullPath = path.join(dir, entry.path);
          await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
          await fsPromises.writeFile(fullPath, entry.content, "utf8");
          await gitClient.add({ fs, dir, filepath: entry.path });
        }

        for (const entry of normalizedDeletes) {
          const fullPath = path.join(dir, entry);
          if (!fs.existsSync(fullPath)) continue;
          await fsPromises.rm(fullPath, { recursive: true, force: true });
          await gitClient.remove({ fs, dir, filepath: entry }).catch(() => undefined);
        }

        try {
          await gitClient.commit({
            fs,
            dir,
            message,
            author: COMMIT_AUTHOR,
          });
        } catch (error) {
          if (/No changes/.test(error instanceof Error ? error.message : String(error))) {
            return;
          }
          throw error;
        }

        await gitClient.push({
          fs,
          http,
          dir,
          remote: "origin",
          ref: branch,
          onAuth: () => ({ username, password: token }),
        });
      });
      return;
    } catch (error) {
      if (attempt < 2 && isPushRejection(error)) continue;
      throw error;
    }
  }
}

export async function gitReadFile(filePath: string, revalidateSeconds = 0): Promise<GitFileResult | null> {
  return getGitProviderName() === "onedev"
    ? onedevReadFile(filePath)
    : githubReadFile(filePath, revalidateSeconds);
}

export async function gitListDir(dirPath: string): Promise<GitTreeEntry[]> {
  return getGitProviderName() === "onedev"
    ? onedevListDir(dirPath)
    : githubListDir(dirPath);
}

export async function gitWriteFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
  if (getGitProviderName() === "onedev") {
    await onedevCommitFiles({ message, addOrUpdateFiles: [{ path: filePath, content }] });
    return;
  }
  await githubWriteFile(filePath, content, message, sha);
}

export async function gitDeleteFile(filePath: string, message: string, sha?: string): Promise<void> {
  if (getGitProviderName() === "onedev") {
    await onedevCommitFiles({ message, deleteFiles: [filePath] });
    return;
  }
  await githubDeleteFile(filePath, message, sha);
}

export async function gitCommitFiles(options: GitCommitOptions): Promise<void> {
  if (getGitProviderName() === "onedev") {
    await onedevCommitFiles(options);
    return;
  }
  await githubCommitFiles(options);
}

async function collectFilePaths(baseDir: string, gitOrFsDir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fsPromises.readdir(path.join(gitOrFsDir, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        results.push(entryPath);
      }
    }
  };
  await walk(normalizePath(baseDir));
  return results;
}

export async function gitDeleteDir(dirPath: string, message: string): Promise<{ deleted: string[]; errors: string[] }> {
  if (getGitProviderName() === "onedev") {
    const errors: string[] = [];
    let deleted: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { http } = await loadIsomorphicGit();
        await withOneDevWorktree(async (dir, gitClient) => {
          const { branch, token, username } = getOneDevConfig();
          const filePaths = await collectFilePaths(dirPath, dir);
          if (filePaths.length === 0) return;

          for (const filePath of filePaths) {
            const fullPath = path.join(dir, filePath);
            await fsPromises.rm(fullPath, { force: true });
            await gitClient.remove({ fs, dir, filepath: filePath }).catch(() => undefined);
          }

          await gitClient.commit({ fs, dir, message, author: COMMIT_AUTHOR });
          await gitClient.push({ fs, http, dir, remote: "origin", ref: branch, onAuth: () => ({ username, password: token }) });
          deleted = filePaths;
        });
        break;
      } catch (error) {
        if (attempt < 2 && isPushRejection(error)) continue;
        errors.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }
    return { deleted, errors };
  }

  // GitHub: collect all paths first, then delete in one commit batch
  const allFiles: string[] = [];
  const collectGithub = async (dir: string) => {
    const entries = await gitListDir(dir);
    for (const entry of entries) {
      if (entry.type === "file") allFiles.push(entry.path);
      else await collectGithub(entry.path);
    }
  };
  await collectGithub(dirPath);

  if (allFiles.length === 0) return { deleted: [], errors: [] };

  try {
    await githubCommitFiles({ message, deleteFiles: allFiles });
    return { deleted: allFiles, errors: [] };
  } catch (error) {
    return { deleted: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}
