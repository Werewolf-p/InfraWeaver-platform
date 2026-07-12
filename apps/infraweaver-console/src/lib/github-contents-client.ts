/**
 * Factory for a GitHub Contents-API client bound to one repo + token.
 *
 * Extracts the GitHub path of `@/lib/git-provider` and the near-copy in
 * `@/lib/infra-repo` so future repo targets (platform repo, infra repo,
 * template mirror, ...) don't re-implement headers/base64/sha handling.
 * Behavior mirrors those modules:
 *
 *  - readFile: 404 → null; content base64-decoded; returns the blob `sha`
 *    needed for a subsequent conflict-safe write.
 *  - writeFile: create-or-update; when `sha` is omitted it is resolved with a
 *    read first (infra-repo convention) so plain "upsert" callers work.
 *  - listDir: 404 → empty array.
 *
 * This is a plain factory — env wiring (which repo, which token) stays with
 * the caller, exactly like infra-repo.ts does today.
 */

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_COMMITTER = { name: "InfraWeaver Console", email: "console@infraweaver.internal" };

export interface GithubCommitter {
  name: string;
  email: string;
}

export interface GithubContentsClientOptions {
  /** GitHub API base URL. Default `https://api.github.com` (GHE: `https://<host>/api/v3`). */
  apiUrl?: string;
  /** `owner/name` repo slug. Required. */
  repo: string;
  /** Bearer token. May be empty for public-repo reads; writes require it. */
  token: string;
  /** Commit author/committer identity. Default the InfraWeaver Console identity. */
  committer?: GithubCommitter;
}

export interface GithubFileResult {
  content: string;
  sha: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "file" | "dir";
  sha?: string;
}

export interface GithubContentsClient {
  /** Read a file, or `null` when it does not exist (404). */
  readFile(filePath: string, revalidateSeconds?: number): Promise<GithubFileResult | null>;
  /** Create-or-update a single file. Resolves the blob sha via a read when omitted. */
  writeFile(filePath: string, content: string, message: string, sha?: string): Promise<void>;
  /** List a directory's entries, or an empty array when it does not exist (404). */
  listDir(dirPath: string): Promise<GithubTreeEntry[]>;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\/+/, "").replace(/\\/g, "/");
}

export function createGithubContentsClient(opts: GithubContentsClientOptions): GithubContentsClient {
  const repo = opts.repo.trim();
  if (!repo) throw new Error("github-contents-client: `repo` (owner/name) is required");
  const apiUrl = (opts.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
  const token = opts.token;
  const committer = opts.committer ?? DEFAULT_COMMITTER;
  const repoApi = `${apiUrl}/repos/${repo}`;

  function headers(includeJson = false): HeadersInit {
    const h: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "infraweaver-console",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    if (includeJson) h["Content-Type"] = "application/json";
    return h;
  }

  async function readFile(filePath: string, revalidateSeconds = 0): Promise<GithubFileResult | null> {
    const path = normalizePath(filePath);
    const res = await fetch(
      `${repoApi}/contents/${path}`,
      revalidateSeconds > 0
        ? { headers: headers(), next: { revalidate: revalidateSeconds } }
        : { headers: headers(), cache: "no-store" },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${repo}/${path}: ${res.status}`);
    const data = (await res.json()) as { content: string; sha: string };
    return {
      content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8"),
      sha: data.sha,
    };
  }

  async function writeFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
    if (!token) throw new Error(`github-contents-client: a token is required to write to ${repo}`);
    const path = normalizePath(filePath);
    const resolvedSha = sha ?? (await readFile(path))?.sha;
    const res = await fetch(`${repoApi}/contents/${path}`, {
      method: "PUT",
      headers: headers(true),
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        ...(resolvedSha ? { sha: resolvedSha } : {}),
        committer,
      }),
    });
    if (!res.ok) throw new Error(`GitHub PUT ${repo}/${path}: ${res.status} — ${await res.text()}`);
  }

  async function listDir(dirPath: string): Promise<GithubTreeEntry[]> {
    const path = normalizePath(dirPath);
    const res = await fetch(`${repoApi}/contents/${path}`, { headers: headers(), cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub list ${repo}/${path}: ${res.status}`);
    const data = (await res.json()) as Array<{ path: string; type: string; sha?: string }>;
    return data.map((entry) => ({
      path: entry.path,
      type: entry.type === "dir" ? "dir" : "file",
      sha: entry.sha,
    }));
  }

  return { readFile, writeFile, listDir };
}
